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
    const { type, pids, soIds, soNames } = JSON.parse(event.body || '{}');
    const uid = await getUid();

    if (type === 'pipeline_orders') {
      // Draft/sent SO lines for these products
      const soLines = await odooCall(uid, 'sale.order.line', 'search_read',
        [[['product_id','in',pids],['order_id.state','in',['draft','sent']],['product_uom_qty','>',0]]],
        { fields: ['order_id','product_id','product_uom_qty'], limit: 500 });
      const soIdSet = [...new Set(soLines.map(l => Array.isArray(l.order_id)?l.order_id[0]:l.order_id))];
      if (!soIdSet.length) return ok({ soLines:[], soHeaders:[], pickings:[], oppData:[] });
      const [soHeaders, pickings] = await Promise.all([
        odooCall(uid,'sale.order','search_read',
          [[['id','in',soIdSet],['state','in',['draft','sent']]]],
          { fields:['id','name','state','partner_id','commitment_date','opportunity_id'], limit:500 }),
        odooCall(uid,'stock.picking','search_read',
          [[['picking_type_code','=','outgoing'],['state','not in',['done','cancel']]]],
          { fields:['id','scheduled_date','origin'], limit:2000 }),
      ]);
      const oppIds = [...new Set(soHeaders.map(s => Array.isArray(s.opportunity_id)?s.opportunity_id[0]:s.opportunity_id).filter(Boolean))];
      let oppData = [];
      if (oppIds.length > 0) {
        oppData = await odooCall(uid,'crm.lead','search_read',
          [[['id','in',oppIds]]],
          { fields:['id','probability','date_deadline'], limit:200 });
      }
      return ok({ soLines, soHeaders, pickings, oppData });
    }

    if (type === 'confirmed_orders') {
      const soLines = await odooCall(uid,'sale.order.line','search_read',
        [[['product_id','in',pids],['order_id.state','=','sale'],['product_uom_qty','>',0]]],
        { fields:['order_id','product_id','product_uom_qty','qty_delivered'], limit:500 });
      const soIdSet = [...new Set(soLines.map(l => Array.isArray(l.order_id)?l.order_id[0]:l.order_id))];
      if (!soIdSet.length) return ok({ soLines:[], soHeaders:[], pickings:[] });
      const [soHeaders, pickings] = await Promise.all([
        odooCall(uid,'sale.order','search_read',
          [[['id','in',soIdSet],['state','=','sale']]],
          { fields:['id','name','partner_id','commitment_date'], limit:500 }),
        odooCall(uid,'stock.picking','search_read',
          [[['picking_type_code','=','outgoing'],['state','not in',['done','cancel']]]],
          { fields:['id','scheduled_date','origin'], limit:2000 }),
      ]);
      return ok({ soLines, soHeaders, pickings });
    }

    if (type === 'phasing_nonkit') {
      const [pickings, moves] = await Promise.all([
        odooCall(uid,'stock.picking','search_read',
          [[['picking_type_code','=','outgoing'],['state','not in',['done','cancel']]]],
          { fields:['id','name','scheduled_date','state','origin','partner_id'], limit:2000 }),
        odooCall(uid,'stock.move','search_read',
          [[['product_id','in',pids],['state','not in',['done','cancel','draft']]]],
          { fields:['picking_id','product_id','product_uom_qty'], limit:2000 }),
      ]);
      let soIdData = [];
      if (soNames && soNames.length > 0) {
        soIdData = await odooCall(uid,'sale.order','search_read',
          [[['name','in',soNames]]],
          { fields:['id','name'], limit:500 });
      }
      return ok({ pickings, moves, soIdData });
    }

    if (type === 'phasing_kit') {
      const soLines = await odooCall(uid,'sale.order.line','search_read',
        [[['product_id','in',pids],['order_id.state','=','sale'],['product_uom_qty','>',0]]],
        { fields:['order_id','product_id','product_uom_qty','qty_delivered'], limit:500 });
      const soIdSet = [...new Set(soLines.map(l => Array.isArray(l.order_id)?l.order_id[0]:l.order_id))];
      if (!soIdSet.length) return ok({ soLines:[], soHeaders:[], pickings:[] });
      const [soHeaders, pickings] = await Promise.all([
        odooCall(uid,'sale.order','search_read',
          [[['id','in',soIdSet],['state','=','sale']]],
          { fields:['id','name','partner_id','commitment_date','state'], limit:500 }),
        odooCall(uid,'stock.picking','search_read',
          [[['picking_type_code','=','outgoing'],['state','not in',['done','cancel']]]],
          { fields:['id','scheduled_date','origin'], limit:2000 }),
      ]);
      return ok({ soLines, soHeaders, pickings });
    }

    if (type === 'bare_posts') {
      const rows = await odooCall(uid,'product.product','search_read',
        [[['default_code','in',pids]]],
        { fields:['id','default_code'], limit:500 });
      return ok({ rows });
    }

    if (type === 'comp_codes') {
      const rows = await odooCall(uid,'product.product','search_read',
        [[['id','in',pids]]],
        { fields:['id','default_code'], limit:200 });
      return ok({ rows });
    }

    return { statusCode:400, body: JSON.stringify({ error:'Unknown type: '+type }) };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function ok(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}
