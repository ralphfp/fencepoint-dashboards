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

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { start, end } = JSON.parse(event.body);
    const uid = await getUid();

    // Step 1: get confirmed sale orders in date range
    const orders = await odooCall(uid, 'sale.order', 'search_read',
      [[['state','=','sale'],['date_order','>=',start+' 00:00:00'],['date_order','<',end+' 00:00:00']]],
      { fields: ['id','name','partner_id','user_id','create_uid'], limit: 500 });

    if (!orders.length) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [] }) };
    }

    const orderIds = orders.map(o => o.id);
    const agentMap = {};
    orders.forEach(o => {
      agentMap[o.id] = {
        name: o.name,
        partner: Array.isArray(o.partner_id) ? o.partner_id[1] : '',
        salesperson: Array.isArray(o.user_id) ? o.user_id[1] : '',
        created_by: Array.isArray(o.create_uid) ? o.create_uid[1] : '',
      };
    });

    // Step 2: get order lines grouped by order, sum revenue and margin
    const lines = await odooCall(uid, 'sale.order.line', 'search_read',
      [[['order_id','in',orderIds],['price_subtotal','>',0]]],
      { fields: ['order_id','price_subtotal','margin'], limit: 5000 });

    // Group by order_id
    const grouped = {};
    lines.forEach(l => {
      const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!grouped[oid]) grouped[oid] = { rev: 0, margin: 0 };
      grouped[oid].rev    += l.price_subtotal || 0;
      grouped[oid].margin += l.margin || 0;
    });

    const rows = Object.entries(grouped).map(([oid, vals]) => {
      const a = agentMap[parseInt(oid)] || {};
      const pct = vals.rev > 0 ? vals.margin / vals.rev : 0;
      return {
        id: parseInt(oid),
        name: a.name || '',
        partner: a.partner || '',
        created_by: a.created_by || '',
        salesperson: a.salesperson || '',
        rev: vals.rev,
        margin: vals.margin,
        pct: pct,
      };
    }).sort((a,b) => a.pct - b.pct);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
