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

function extractArrayData(xml) {
  const results = [];
  const itemRegex = /<struct>([\s\S]*?)<\/struct>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const struct = {};
    const memberRegex = /<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let m;
    while ((m = memberRegex.exec(itemMatch[1])) !== null) {
      const key = m[1], valXml = m[2].trim();
      if (valXml.startsWith('<int>') || valXml.startsWith('<i4>')) struct[key] = parseInt(valXml.replace(/<\/?(?:int|i4)>/g,''));
      else if (valXml.startsWith('<double>')) struct[key] = parseFloat(valXml.replace(/<\/?double>/g,''));
      else if (valXml.startsWith('<boolean>')) struct[key] = valXml.includes('>1<');
      else if (valXml.startsWith('<string>')) struct[key] = valXml.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      else if (valXml.startsWith('<array>')) {
        const arrVals = [];
        const avR = /<value>([\s\S]*?)<\/value>/g; let av;
        while ((av = avR.exec(valXml)) !== null) {
          const a = av[1].trim();
          if (a.startsWith('<int>') || a.startsWith('<i4>')) arrVals.push(parseInt(a.replace(/<\/?(?:int|i4)>/g,'')));
          else if (a.startsWith('<string>')) arrVals.push(a.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
          else if (a.startsWith('<boolean>')) arrVals.push(a.includes('>1<'));
          else if (a.startsWith('<double>')) arrVals.push(parseFloat(a.replace(/<\/?double>/g,'')));
        }
        struct[key] = arrVals;
      } else struct[key] = valXml.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    }
    results.push(struct);
  }
  return results;
}

async function getUid() {
  const xml = await xmlrpc(process.env.ODOO_URL + '/xmlrpc/2/common', 'authenticate',
    [process.env.ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}]);
  const uid = extractInts(xml)[0];
  if (!uid) throw new Error('Odoo auth failed');
  return uid;
}

async function odooCall(uid, model, method, args, kwargs) {
  const xml = await xmlrpc(process.env.ODOO_URL + '/xmlrpc/2/object', 'execute_kw',
    [process.env.ODOO_DB, uid, process.env.ODOO_API_KEY, model, method, args, kwargs || {}]);
  if (xml.includes('<fault>')) {
    const msg = xml.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? msg[1].slice(0,300) : 'XML-RPC fault');
  }
  return extractArrayData(xml);
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
    const { type, dateFrom, dateTo } = JSON.parse(event.body);
    const uid = await getUid();
    const revenueAccountIds = await getRevenueAccountIds(uid);

    // GP: find posted invoices in range, get their sale order origins, sum margins
    if (type === 'gp') {
      const invDomain = [
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted'],
        ['invoice_date', '>=', dateFrom],
        ['invoice_date', '<=', dateTo],
      ];
      const invoices = await odooCall(uid, 'account.move', 'search_read', [invDomain],
        { fields: ['id', 'invoice_origin'], limit: 2000 });

      // Sum only revenue account lines (4xxxx excl rent) — matches Odoo Invoice Analysis
      const invIds = invoices.map(i => i.id);
      const revLines = invIds.length > 0
        ? await odooCall(uid, 'account.move.line', 'search_read',
            [[['move_id','in',invIds],['account_id','in',revenueAccountIds]]],
            { fields: ['move_id','price_subtotal'], limit: 10000 })
        : [];
      const invRevMap = {};
      revLines.forEach(l => {
        const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
        invRevMap[mid] = (invRevMap[mid]||0) + (l.price_subtotal||0);
      });
      const totalRevenue = invoices.reduce((s, i) => s + (invRevMap[i.id]||0), 0);
      const origins = [...new Set(invoices.map(i => i.invoice_origin).filter(o => o && o.trim()))];

      let totalGP = 0;
      if (origins.length > 0) {
        const orders = await odooCall(uid, 'sale.order', 'search_read',
          [[['name', 'in', origins]]],
          { fields: ['name', 'margin'], limit: 2000 });
        totalGP = orders.reduce((s, o) => s + (o.margin || 0), 0);
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revenue: totalRevenue, gp: totalGP })
      };
    }

    // Despatches: stock.picking done, picking_type_id=2 (outgoing), scheduled_date in range
    if (type === 'despatches') {
      const domain = [
        ['state', '=', 'done'],
        ['picking_type_id', '=', 2],
        ['scheduled_date', '>=', dateFrom + ' 00:00:00'],
        ['scheduled_date', '<', dateTo + ' 00:00:00'],
      ];
      const picks = await odooCall(uid, 'stock.picking', 'search_read', [domain],
        { fields: ['id'], limit: 5000 });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: picks.length })
      };
    }

    // Helpdesk tickets (ops errors) from date
    if (type === 'tickets') {
      const domain = [['create_date', '>=', dateFrom + ' 00:00:00']];
      const tickets = await odooCall(uid, 'helpdesk.ticket', 'search_read', [domain],
        { fields: ['name', 'create_date', 'partner_name', 'tag_ids', 'stage_id'], limit: 200, order: 'create_date desc' });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickets: tickets.map(t => ({
          name: t.name || '',
          create_date: t.create_date || '',
          partner_name: t.partner_name || '',
          tag_ids: t.tag_ids || [],
          stage_id: Array.isArray(t.stage_id) ? t.stage_id[0] : t.stage_id,
          stage_name: Array.isArray(t.stage_id) ? t.stage_id[1] : '',
        }))})
      };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown query type' }) };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
