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
    const uid = await getUid();
    const LOC_IDS = [8,11,23,24,25,26,27,28,29,30,31,32,33,34,35,36];

    const [stockedTmplRecs, stockRecs, bomHeaders, bomLines, poHeaders, poLines, suppliers] = await Promise.all([
      odooCall(uid,'product.template','search_read',
        [[['x_studio_stocked_item','=',true],['active','=',true]]],
        {fields:['id'],limit:2000}),
      odooCall(uid,'stock.quant','search_read',
        [[['location_id','in',LOC_IDS],['quantity','>',0]]],
        {fields:['product_id','quantity','reserved_quantity'],limit:5000}),
      odooCall(uid,'mrp.bom','search_read',
        [[['type','=','phantom']]],
        {fields:['id','product_tmpl_id','product_qty'],limit:500}),
      odooCall(uid,'mrp.bom.line','search_read',
        [[]],{fields:['bom_id','product_id','product_qty'],limit:3000}),
      odooCall(uid,'purchase.order','search_read',
        [[['state','in',['purchase','done']]]],
        {fields:['id','name','partner_id','date_order'],limit:2000}),
      odooCall(uid,'purchase.order.line','search_read',
        [[['qty_received','<','product_qty'],['product_qty','>',0]]],
        {fields:['order_id','product_id','product_qty','qty_received','date_planned','price_unit'],limit:2000}),
      odooCall(uid,'product.supplierinfo','search_read',
        [[['delay','>',0]]],
        {fields:['product_tmpl_id','delay','price'],limit:5000}),
    ]);

    const stockedTmplIds = stockedTmplRecs.map(r => r.id);
    const products = stockedTmplIds.length > 0
      ? await odooCall(uid,'product.product','search_read',
          [[['active','=',true],['product_tmpl_id','in',stockedTmplIds]]],
          {fields:['id','product_tmpl_id','default_code'],limit:3000})
      : [];

    return {
      statusCode:200,
      headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
      body: JSON.stringify({ products, stockRecs, bomHeaders, bomLines, poHeaders, poLines, suppliers }),
    };
  } catch(err) {
    return {statusCode:500,headers:{'Content-Type':'application/json'},body:JSON.stringify({error:err.message})};
  }
};
