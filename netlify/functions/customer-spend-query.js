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
  if (v.startsWith('<string>')) return v.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
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
    const { fromStr, toStr, priorFrom, priorTo, mode } = JSON.parse(event.body);
    const uid = await getUid();

    let current = [], prior = [];

    if (mode === 'invoiced') {
      // Fetch invoice lines grouped by partner/year/month
      const [invLines, priorInvLines] = await Promise.all([
        odooCall(uid, 'account.move.line', 'search_read', [[
          ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
          ['move_id.state', '=', 'posted'],
          ['move_id.invoice_date', '>=', fromStr],
          ['move_id.invoice_date', '<=', toStr],
          ['product_id', '!=', false],
          ['partner_id', '!=', false],
        ]], { fields: ['partner_id', 'price_subtotal', 'move_id'], limit: 10000 }),

        odooCall(uid, 'account.move.line', 'search_read', [[
          ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
          ['move_id.state', '=', 'posted'],
          ['move_id.invoice_date', '>=', priorFrom],
          ['move_id.invoice_date', '<=', priorTo],
          ['product_id', '!=', false],
          ['partner_id', '!=', false],
        ]], { fields: ['partner_id', 'price_subtotal', 'move_id'], limit: 10000 }),
      ]);

      // Also need invoice dates — fetch invoices separately
      const allMoveIds = [...new Set([
        ...invLines.map(l => Array.isArray(l.move_id) ? l.move_id[0] : l.move_id),
        ...priorInvLines.map(l => Array.isArray(l.move_id) ? l.move_id[0] : l.move_id),
      ])];

      // Batch fetch move dates (in chunks of 200)
      const moveDates = {};
      const moveMoveTypes = {};
      for (let i = 0; i < allMoveIds.length; i += 200) {
        const chunk = allMoveIds.slice(i, i + 200);
        const moves = await odooCall(uid, 'account.move', 'search_read',
          [[['id', 'in', chunk]]],
          { fields: ['id', 'invoice_date', 'move_type'], limit: 200 });
        moves.forEach(m => {
          moveDates[m.id] = m.invoice_date || '';
          moveMoveTypes[m.id] = m.move_type || '';
        });
      }

      // Aggregate: partner → year/month → total
      function aggregateLines(lines) {
        const map = {};
        lines.forEach(l => {
          const pid = Array.isArray(l.partner_id) ? l.partner_id[0] : l.partner_id;
          const pname = Array.isArray(l.partner_id) ? l.partner_id[1] : '';
          const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
          const dt = moveDates[mid] || '';
          if (!dt) return;
          const yr = parseInt(dt.slice(0,4));
          const mo = parseInt(dt.slice(5,7));
          const isRefund = moveMoveTypes[mid] === 'out_refund';
          const amt = isRefund ? -(l.price_subtotal || 0) : (l.price_subtotal || 0);
          const key = pid + '|' + yr + '|' + mo;
          if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: new Set() };
          map[key].total += amt;
          map[key].cnt.add(mid);
        });
        return Object.values(map).map(r => [r.pid, r.pname, r.yr, r.mo, r.total, r.cnt.size]);
      }

      current = aggregateLines(invLines);
      prior   = aggregateLines(priorInvLines);

    } else {
      // Orders mode: sale_order + pos_order
      const [soRows, posRows, priorSoRows, priorPosRows] = await Promise.all([
        odooCall(uid, 'sale.order', 'search_read', [[
          ['state', 'in', ['sale', 'done']],
          ['date_order', '>=', fromStr + ' 00:00:00'],
          ['date_order', '<=', toStr + ' 23:59:59'],
        ]], { fields: ['partner_id', 'amount_untaxed', 'date_order'], limit: 2000 }),

        odooCall(uid, 'pos.order', 'search_read', [[
          ['state', 'in', ['done', 'invoiced', 'paid']],
          ['date_order', '>=', fromStr + ' 00:00:00'],
          ['date_order', '<=', toStr + ' 23:59:59'],
          ['partner_id', '!=', false],
        ]], { fields: ['partner_id', 'amount_total', 'amount_tax', 'date_order'], limit: 2000 }),

        odooCall(uid, 'sale.order', 'search_read', [[
          ['state', 'in', ['sale', 'done']],
          ['date_order', '>=', priorFrom + ' 00:00:00'],
          ['date_order', '<=', priorTo + ' 23:59:59'],
        ]], { fields: ['partner_id', 'amount_untaxed', 'date_order'], limit: 2000 }),

        odooCall(uid, 'pos.order', 'search_read', [[
          ['state', 'in', ['done', 'invoiced', 'paid']],
          ['date_order', '>=', priorFrom + ' 00:00:00'],
          ['date_order', '<=', priorTo + ' 23:59:59'],
          ['partner_id', '!=', false],
        ]], { fields: ['partner_id', 'amount_total', 'amount_tax', 'date_order'], limit: 2000 }),
      ]);

      function aggregateOrders(soArr, posArr) {
        const map = {};
        soArr.forEach(o => {
          const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id;
          const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
          const dt = (o.date_order || '').slice(0,10);
          if (!dt) return;
          const yr = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(5,7));
          const key = pid+'|'+yr+'|'+mo;
          if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: 0 };
          map[key].total += parseFloat(o.amount_untaxed || 0);
          map[key].cnt++;
        });
        posArr.forEach(o => {
          const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id;
          const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
          const dt = (o.date_order || '').slice(0,10);
          if (!dt) return;
          const yr = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(5,7));
          const key = pid+'|'+yr+'|'+mo;
          if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: 0 };
          const exVat = parseFloat(o.amount_total||0) - parseFloat(o.amount_tax||0);
          map[key].total += exVat;
          map[key].cnt++;
        });
        return Object.values(map).map(r => [r.pid, r.pname, r.yr, r.mo, r.total, r.cnt]);
      }

      current = aggregateOrders(soRows, posRows);
      prior   = aggregateOrders(priorSoRows, priorPosRows);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ current, prior }),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
