const https = require('https');

function xmlrpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const xmlBody = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param><value>${toXml(p)}</value></param>`).join('')}</params></methodCall>`;
    const u = new URL(url);
    const options = { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xmlBody) } };
    const req = https.request(options, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data)); });
    req.on('error', reject);
    req.write(xmlBody);
    req.end();
  });
}

function toXml(val) {
  if (val === null || val === false) return '<boolean>0</boolean>';
  if (val === true) return '<boolean>1</boolean>';
  if (typeof val === 'number') return Number.isInteger(val) ? `<int>${val}</int>` : `<double>${val}</double>`;
  if (typeof val === 'string') return `<string>${val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</string>`;
  if (Array.isArray(val)) return `<array><data>${val.map(v => `<value>${toXml(v)}</value>`).join('')}</data></array>`;
  if (typeof val === 'object') return `<struct>${Object.entries(val).map(([k,v]) => `<member><name>${k}</name><value>${toXml(v)}</value></member>`).join('')}</struct>`;
  return `<string>${val}</string>`;
}

function extractInts(xml) {
  return [...xml.matchAll(/<int>(.*?)<\/int>|<i4>(.*?)<\/i4>/g)].map(m => parseInt(m[1] || m[2]));
}

function extractVal(v) {
  v = v.trim();
  if (v.startsWith('<int>') || v.startsWith('<i4>')) return parseInt(v.replace(/<\/?(?:int|i4)>/g,''));
  if (v.startsWith('<double>')) return parseFloat(v.replace(/<\/?double>/g,''));
  if (v.startsWith('<boolean>')) return v.includes('>1<');
  if (v.startsWith('<string>')) return v.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if (v.startsWith('<array>')) {
    const arr=[]; const r=/<value>([\s\S]*?)<\/value>/g; let m;
    while((m=r.exec(v))!==null) arr.push(extractVal(m[1]));
    return arr;
  }
  return v.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
}

function extractArrayData(xml) {
  const results=[];
  const itemRegex=/<struct>([\s\S]*?)<\/struct>/g; let itemMatch;
  while((itemMatch=itemRegex.exec(xml))!==null) {
    const struct={};
    const memberRegex=/<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g; let m;
    while((m=memberRegex.exec(itemMatch[1]))!==null) struct[m[1]]=extractVal(m[2].trim());
    results.push(struct);
  }
  return results;
}

async function getUid() {
  const xml = await xmlrpc(process.env.ODOO_URL+'/xmlrpc/2/common','authenticate',
    [process.env.ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}]);
  const uid = extractInts(xml)[0];
  if (!uid) throw new Error('Odoo auth failed');
  return uid;
}

async function odooCall(uid, model, method, args, kwargs) {
  const xml = await xmlrpc(process.env.ODOO_URL+'/xmlrpc/2/object','execute_kw',
    [process.env.ODOO_DB, uid, process.env.ODOO_API_KEY, model, method, args, kwargs||{}]);
  if (xml.includes('<fault>')) {
    const msg = xml.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? msg[1].slice(0,300) : 'XML-RPC fault');
  }
  return extractArrayData(xml);
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { monthStart, today, tomorrow } = JSON.parse(event.body);
    const uid = await getUid();

    // Q1: Confirmed sale orders MTD — matching daily activity report logic exactly
    // Uses sale_order.amount_untaxed (header total) + POS orders, same as daily report
    const [orders, todayPOS] = await Promise.all([
      odooCall(uid, 'sale.order', 'search_read',
        [[['state','in',['sale','done']],['date_order','>=',monthStart+' 00:00:00'],['date_order','<',tomorrow+' 00:00:00']]],
        { fields: ['id','date_order','team_id','amount_untaxed','partner_id','margin'], limit: 2000 }),

      // POS orders today — invoiced, timber or commercial team
      odooCall(uid, 'pos.order', 'search_read',
        [[['date_order','>=',today+' 00:00:00'],['date_order','<',tomorrow+' 00:00:00'],
          ['crm_team_id.name','in',['Timber','Commercial']],['state','=','invoiced'],
          ['lines.product_id.name','not like','Down Payment']]],
        { fields: ['amount_total','amount_tax','partner_id','crm_team_id'], limit: 200 }),
    ]);

    const orderIds = orders.map(o => o.id);
    const orderDateMap = {};
    const orderTeamMap = {};
    orders.forEach(o => {
      orderDateMap[o.id] = (o.date_order||'').slice(0,10);
      orderTeamMap[o.id] = Array.isArray(o.team_id) ? o.team_id[1] : (o.team_id||'');
    });

    let salesToday=0, costToday=0, salesMtd=0, costMtd=0;
    let timberToday=0, commToday=0, timberMtd=0, commMtd=0;

    // Build dedup key set from today's sale orders (to avoid double-counting POS)
    const saleOrderKeys = {};
    orders.forEach(o => {
      if ((o.date_order||'').slice(0,10) === today) {
        const team = Array.isArray(o.team_id) ? o.team_id[1] : (o.team_id||'');
        const partner = Array.isArray(o.partner_id) ? o.partner_id[1] : (o.partner_id||'');
        const amt = parseFloat(o.amount_untaxed||0).toFixed(2);
        saleOrderKeys[team+'|'+partner+'|'+amt] = true;
      }
    });

    // Sum sale orders by team
    orders.forEach(o => {
      const date = orderDateMap[o.id] || '';
      const team = orderTeamMap[o.id] || '';
      const rev  = parseFloat(o.amount_untaxed||0);
      salesMtd += rev;
      if (team === 'Timber')     timberMtd += rev;
      else if (team === 'Commercial') commMtd += rev;
      if (date === today) {
        salesToday += rev;
        if (team === 'Timber')        timberToday += rev;
        else if (team === 'Commercial') commToday += rev;
      }
    });

    // Add POS orders today (deduped against sale orders, exclude down payments)
    todayPOS.forEach(po => {
      const exVat = parseFloat(po.amount_total||0) - parseFloat(po.amount_tax||0);
      const team    = Array.isArray(po.crm_team_id) ? po.crm_team_id[1] : (po.crm_team_id||'');
      const partner = Array.isArray(po.partner_id)  ? po.partner_id[1]  : (po.partner_id||'');
      const key = team+'|'+partner+'|'+exVat.toFixed(2);
      // Down payments already excluded at query level
      if (!saleOrderKeys[key]) {
        salesToday += exVat;
        if (team === 'Timber')        timberToday += exVat;
        else if (team === 'Commercial') commToday += exVat;
      }
    });

    // GP Today/MTD — use sale_order.margin directly (matches Odoo's own report)
    // This is more accurate than line-level purchase_price which can be 0 for some lines
    orders.forEach(o => {
      const date   = orderDateMap[o.id] || '';
      const margin = parseFloat(o.margin || 0);
      costMtd += (parseFloat(o.amount_untaxed||0) - margin); // derive cost from margin
      if (date === today) costToday += (parseFloat(o.amount_untaxed||0) - margin);
    });

    // Q2: Invoices MTD — revenue from account.move, GP from invoice lines directly
    // Using price_subtotal - (purchase_price * quantity) per line is the most accurate
    // method as it only counts GP on lines actually invoiced, not whole-SO margin.

    const invoices = await odooCall(uid, 'account.move', 'search_read',
      [[['move_type','in',['out_invoice','out_refund']],['state','=','posted'],
        ['invoice_date','>=',monthStart],['invoice_date','<',tomorrow],
        ['line_ids.account_id.code','not in',['491000','710000']]]],
      { fields: ['id','move_type','amount_untaxed','invoice_date'], limit: 2000 });

    let salesInv = 0, salesInvToday = 0;
    const invoiceIds = [], invoiceIdsToday = [];
    const refundIds  = [], refundIdsToday  = [];

    invoices.forEach(inv => {
      const amt     = inv.amount_untaxed || 0;
      const invDate = (inv.invoice_date || '').slice(0, 10);
      const isToday = invDate === today;
      if (inv.move_type === 'out_invoice') {
        salesInv += amt;
        invoiceIds.push(inv.id);
        if (isToday) { salesInvToday += amt; invoiceIdsToday.push(inv.id); }
      } else if (inv.move_type === 'out_refund') {
        salesInv -= amt;
        refundIds.push(inv.id);
        if (isToday) { salesInvToday -= amt; refundIdsToday.push(inv.id); }
      }
    });

    let gpInv = 0, gpInvToday = 0;
    const allInvoiceIds = [...invoiceIds, ...refundIds];

    if (allInvoiceIds.length > 0) {
      // Fetch all invoice lines that have a purchase_price (i.e. product lines)
      const invLines = await odooCall(uid, 'account.move.line', 'search_read',
        [[['move_id','in',allInvoiceIds],['purchase_price','>',0]]],
        { fields: ['move_id','price_subtotal','purchase_price','quantity'], limit: 10000 });

      // Build sets for fast invoice/refund lookup
      const invoiceIdSet      = new Set(invoiceIds);
      const refundIdSet       = new Set(refundIds);
      const invoiceIdSetToday = new Set(invoiceIdsToday);
      const refundIdSetToday  = new Set(refundIdsToday);

      invLines.forEach(line => {
        const mid    = Array.isArray(line.move_id) ? line.move_id[0] : line.move_id;
        const lineGp = (line.price_subtotal || 0) - (line.purchase_price || 0) * (line.quantity || 0);
        if (invoiceIdSet.has(mid)) {
          gpInv += lineGp;
          if (invoiceIdSetToday.has(mid)) gpInvToday += lineGp;
        } else if (refundIdSet.has(mid)) {
          gpInv -= lineGp;
          if (refundIdSetToday.has(mid)) gpInvToday -= lineGp;
        }
      });
    }

    // Q3: Pipeline — confirmed orders not fully delivered, grouped by commitment_date
    const pipelineOrders = await odooCall(uid, 'sale.order', 'search_read',
      [[['state','=','sale'],['delivery_status','in',['pending','started']],
        ['commitment_date','>=',monthStart+' 00:00:00']]],
      { fields: ['commitment_date','margin'], limit: 2000 });

    const pipelineByMonth = {};
    pipelineOrders.forEach(o => {
      if (!o.commitment_date) return;
      const mKey = o.commitment_date.slice(0,7);
      if (!pipelineByMonth[mKey]) pipelineByMonth[mKey] = { gp: 0, cnt: 0 };
      pipelineByMonth[mKey].gp += (o.margin || 0);
      pipelineByMonth[mKey].cnt += 1;
    });

    // Q4: Activity data for Salesdesk Dashboard
    const [callRows, orderRowsToday, leadRowsToday, actRows] = await Promise.all([
      // Phone calls logged today
      odooCall(uid, 'mail.message', 'search_read', [[
        ['mail_activity_type_id.name', 'in', ['Proactive Call','Commercial Brochure Follow Up','Opportunity Follow Up Call','Quote Follow Up Call','Inbound Call','Follow up call']],
        ['author_id.name', 'in', ['Ralph Lewis','Roger Lewis','Daniel Wilkin','Amy Hope','Kayleigh Rankin']],
        ['date', '>=', today + ' 00:00:00'],
        ['date', '<',  tomorrow + ' 00:00:00'],
      ]], { fields: ['author_id','mail_activity_type_id','record_name','body','date'], limit: 500 }),

      // Sale orders created today (quotes + confirmed)
      odooCall(uid, 'sale.order', 'search_read', [[
        ['date_order', '>=', today + ' 00:00:00'],
        ['date_order', '<',  tomorrow + ' 00:00:00'],
      ]], { fields: ['name','state','user_id'], limit: 500 }),

      // CRM leads created today
      odooCall(uid, 'crm.lead', 'search_read', [[
        ['create_date', '>=', today + ' 00:00:00'],
        ['create_date', '<',  tomorrow + ' 00:00:00'],
      ]], { fields: ['name','stage_id','user_id'], limit: 500 }),

      // Outstanding activities (overdue/due today)
      odooCall(uid, 'mail.activity', 'search_read', [[
        ['user_id.name', 'in', ['Ralph Lewis','Roger Lewis','Daniel Wilkin','Amy Hope','Kayleigh Rankin']],
        ['date_deadline', '<=', today],
      ]], { fields: ['user_id','activity_type_id'], limit: 1000 }),
    ]);

    const calls = callRows.map(r => ({
      author:   Array.isArray(r.author_id)              ? r.author_id[1]              : '',
      activity: Array.isArray(r.mail_activity_type_id)  ? r.mail_activity_type_id[1]  : '',
      customer: r.record_name || '',
      body:     r.body || '',
      date:     r.date || '',
    }));

    const saleOrdersToday = orderRowsToday.map(r => ({
      name:  r.name || '',
      state: r.state || '',
      rep:   Array.isArray(r.user_id) ? r.user_id[1] : '',
    }));

    const crmLeadsToday = leadRowsToday.map(r => ({
      name: r.name || '',
      rep:  Array.isArray(r.user_id) ? r.user_id[1] : '',
    }));

    const activityRows = actRows.map(r => ({
      user_id_label:          Array.isArray(r.user_id)          ? r.user_id[1]          : '',
      activity_type_id_label: Array.isArray(r.activity_type_id) ? r.activity_type_id[1] : '',
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orders:   { salesToday, costToday, salesMtd, costMtd },
        invoices: { salesInv, gpInv, salesInvToday, gpInvToday },
        pipeline: pipelineByMonth,
        bizData:  { timberToday, commToday, timberMtd, commMtd },
        activity: { calls, saleOrdersToday, crmLeadsToday, activityRows },
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
