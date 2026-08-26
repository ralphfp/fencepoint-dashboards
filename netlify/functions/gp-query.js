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
    const { start, end } = JSON.parse(event.body);
    const uid = await getUid();

    // Orders + pricelist + partner in one call
    const orders = await odooCall(uid, 'sale.order', 'search_read',
      [[['state','=','sale'],
        ['date_order','>=',start+' 00:00:00'],
        ['date_order','<', end+' 00:00:00']]],
      { fields: ['id','name','partner_id','user_id','create_uid','pricelist_id'], limit: 500 });

    if (!orders.length)
      return { statusCode:200, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows:[] }) };

    const orderIds   = orders.map(o => o.id);
    const partnerIds = [...new Set(orders.map(o => Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id).filter(Boolean))];

    // Fetch partner default pricelists + order lines in parallel
    const [partners, lines] = await Promise.all([
      partnerIds.length > 0
        ? odooCall(uid, 'res.partner', 'search_read',
            [[['id','in',partnerIds]]],
            { fields: ['id','property_product_pricelist'], limit: 500 })
        : Promise.resolve([]),
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id','in',orderIds],['price_subtotal','>',0]]],
        { fields: ['order_id','price_subtotal','margin'], limit: 5000 }),
    ]);

    // Build partner pricelist map
    const partnerPlMap = {};
    partners.forEach(p => {
      const pl = Array.isArray(p.property_product_pricelist)
        ? p.property_product_pricelist[1] : (p.property_product_pricelist || '—');
      partnerPlMap[p.id] = pl || '—';
    });

    // Build order map
    const agentMap = {};
    orders.forEach(o => {
      const pid = Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id;
      agentMap[o.id] = {
        name:          o.name,
        partner:       Array.isArray(o.partner_id)  ? o.partner_id[1]  : '',
        salesperson:   Array.isArray(o.user_id)     ? o.user_id[1]     : '',
        created_by:    Array.isArray(o.create_uid)  ? o.create_uid[1]  : '',
        orderPl:       Array.isArray(o.pricelist_id)? o.pricelist_id[1]: '—',
        customerPl:    partnerPlMap[pid] || '—',
      };
    });

    // Group lines by order
    const grouped = {};
    lines.forEach(l => {
      const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!grouped[oid]) grouped[oid] = { rev:0, margin:0 };
      grouped[oid].rev    += l.price_subtotal || 0;
      grouped[oid].margin += l.margin || 0;
    });

    const rows = Object.entries(grouped).map(([oid, vals]) => {
      const a = agentMap[parseInt(oid)] || {};
      return {
        id:          parseInt(oid),
        name:        a.name       || '',
        partner:     a.partner    || '',
        created_by:  a.created_by || '',
        salesperson: a.salesperson|| '',
        customerPl:  a.customerPl || '—',
        orderPl:     a.orderPl    || '—',
        rev:    vals.rev,
        margin: vals.margin,
        pct:    vals.rev > 0 ? vals.margin / vals.rev : 0,
      };
    }).sort((a,b) => a.pct - b.pct);

    return { statusCode:200, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}, body: JSON.stringify({ rows }) };

  } catch(err) {
    return { statusCode:500, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ error:err.message }) };
  }
};
