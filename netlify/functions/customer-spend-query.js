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
  const match = xml.match(/<int>(\d+)<\/int>|<i4>(\d+)<\/i4>/);
  const uid = match ? parseInt(match[1]||match[2]) : null;
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

// Paginate through all records — no limit cap
async function odooSearchAll(uid, model, domain, fields, pageSize=2000) {
  let allRecords = [];
  let offset = 0;
  while (true) {
    const batch = await odooCall(uid, model, 'search_read', [domain],
      { fields, limit: pageSize, offset });
    allRecords = allRecords.concat(batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return allRecords;
}

async function fetchInvoicedPeriod(uid, fromStr, toStr) {
  // Fetch all invoices and refunds sequentially to avoid overwhelming Odoo
  const allInvoices = await odooSearchAll(uid, 'account.move',
    [['move_type','in',['out_invoice','out_refund']],['state','=','posted'],
     ['invoice_date','>=',fromStr],['invoice_date','<=',toStr],
     ['partner_id','!=',false]],
    ['id','partner_id','commercial_partner_id','invoice_date','move_type','amount_untaxed'],
    2000
  );

  if (allInvoices.length === 0) return [];

  // Build rent deduction map — fetch lines on rent accounts for these invoices
  // Use sequential batches of 500 to avoid XML-RPC limits
  const allIds = allInvoices.map(i => i.id);
  const rentMap = {};
  for (let i = 0; i < allIds.length; i += 500) {
    const chunk = allIds.slice(i, i + 500);
    const rentLines = await odooCall(uid, 'account.move.line', 'search_read',
      [[['move_id','in',chunk],['account_id','in',[99,224]]]],
      { fields: ['move_id','price_subtotal'], limit: 2000 });
    rentLines.forEach(l => {
      const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      rentMap[mid] = (rentMap[mid]||0) + (l.price_subtotal||0);
    });
  }

  // Aggregate by commercial_partner + year + month
  // Revenue = amount_untaxed - rent lines (simpler and faster than fetching all revenue lines)
  const map = {};
  allInvoices.forEach(inv => {
    const pid   = Array.isArray(inv.commercial_partner_id) ? inv.commercial_partner_id[0]
                : (Array.isArray(inv.partner_id) ? inv.partner_id[0] : inv.partner_id);
    const pname = Array.isArray(inv.commercial_partner_id) ? inv.commercial_partner_id[1]
                : (Array.isArray(inv.partner_id) ? inv.partner_id[1] : '');
    const dt = (inv.invoice_date || '').slice(0, 7);
    if (!dt || !pid) return;
    const yr = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(5,7));
    const isRefund = inv.move_type === 'out_refund';
    const gross = parseFloat(inv.amount_untaxed||0);
    const rent  = rentMap[inv.id] || 0;
    const net   = gross - rent;
    const amt   = isRefund ? -net : net;
    if (Math.abs(amt) < 0.01) return; // skip zero-value lines
    const key = `${pid}|${yr}|${mo}`;
    if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: 0 };
    map[key].total += amt;
    if (!isRefund && net > 0) map[key].cnt++;
  });

  return Object.values(map).map(r => [r.pid, r.pname, r.yr, r.mo, r.total, r.cnt]);
}

async function fetchOrdersPeriod(uid, fromStr, toStr) {
  const [soRows, posRows] = await Promise.all([
    odooSearchAll(uid, 'sale.order',
      [
        ['state', 'in', ['sale', 'done']],
        ['date_order', '>=', fromStr + ' 00:00:00'],
        ['date_order', '<=', toStr + ' 23:59:59'],
        ['partner_id', '!=', false],
      ],
      ['partner_id', 'amount_untaxed', 'date_order']
    ),
    odooSearchAll(uid, 'pos.order',
      [
        ['state', 'in', ['done', 'invoiced', 'paid']],
        ['date_order', '>=', fromStr + ' 00:00:00'],
        ['date_order', '<=', toStr + ' 23:59:59'],
        ['partner_id', '!=', false],
        ['lines.product_id.name', 'not like', 'Down Payment'],
      ],
      ['partner_id', 'amount_total', 'amount_tax', 'date_order']
    ),
  ]);

  const map = {};

  soRows.forEach(o => {
    const pid   = Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id;
    const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
    const dt    = (o.date_order || '').slice(0, 7);
    if (!dt) return;
    const yr = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(5,7));
    const key = `${pid}|${yr}|${mo}`;
    if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: 0 };
    map[key].total += parseFloat(o.amount_untaxed||0);
    map[key].cnt++;
  });

  posRows.forEach(o => {
    const pid   = Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id;
    const pname = Array.isArray(o.partner_id) ? o.partner_id[1] : '';
    const dt    = (o.date_order || '').slice(0, 7);
    if (!dt) return;
    const yr = parseInt(dt.slice(0,4)), mo = parseInt(dt.slice(5,7));
    const key = `${pid}|${yr}|${mo}`;
    if (!map[key]) map[key] = { pid, pname, yr, mo, total: 0, cnt: 0 };
    map[key].total += parseFloat(o.amount_total||0) - parseFloat(o.amount_tax||0);
    map[key].cnt++;
  });

  return Object.values(map).map(r => [r.pid, r.pname, r.yr, r.mo, r.total, r.cnt]);
}

// Revenue account IDs — fetched dynamically from Odoo, cached per process
let _revenueAccountIds = null;

async function getRevenueAccountIds(uid) {
  if (_revenueAccountIds) return _revenueAccountIds;
  try {
    // Fetch all income accounts (account_type = income or income_other)
    const accounts = await odooCall(uid, 'account.account', 'search_read',
      [[['account_type', 'in', ['income', 'income_other']]]],
      { fields: ['id'], limit: 500 });
    // Exclude rent accounts 99 (491000 Rental) and 224 (710000 Rates)
    const ids = accounts.map(a => a.id).filter(id => id !== 99 && id !== 224);
    _revenueAccountIds = ids.length > 0 ? ids : [45, 46, 307, 280, 278, 293, 205, 286];
  } catch(e) {
    _revenueAccountIds = [45, 46, 307, 280, 278, 293, 205, 286];
  }
  return _revenueAccountIds;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { fromStr, toStr, priorFrom, priorTo, mode } = JSON.parse(event.body);
    const uid = await getUid();
    const revenueAccountIds = await getRevenueAccountIds(uid);
    const fetchFn = mode === 'invoiced' ? fetchInvoicedPeriod : fetchOrdersPeriod;

    // Sequential fetches — parallel overwhelms Odoo XML-RPC on large date ranges
    const current = await fetchFn(uid, fromStr, toStr);
    const prior   = await fetchFn(uid, priorFrom, priorTo);

    // Fetch salesperson for all unique commercial partner IDs
    const allPids = [...new Set([
      ...current.map(r => r[0]),
      ...prior.map(r => r[0]),
    ])];

    const spMap = {};
    if (allPids.length > 0) {
      // Batch in chunks of 500
      for (let i = 0; i < allPids.length; i += 500) {
        const chunk = allPids.slice(i, i + 500);
        const partners = await odooCall(uid, 'res.partner', 'search_read',
          [[['id', 'in', chunk]]],
          { fields: ['id', 'user_id'], limit: 500 });
        partners.forEach(p => {
          const sp = Array.isArray(p.user_id) ? p.user_id[1] : null;
          if (sp) spMap[p.id] = sp;
        });
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ current, prior, spMap }),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
