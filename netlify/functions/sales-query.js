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

    // Q1: Confirmed sale orders MTD — get orders with lines
    const orders = await odooCall(uid, 'sale.order', 'search_read',
      [[['state','=','sale'],['date_order','>=',monthStart+' 00:00:00'],['date_order','<',tomorrow+' 00:00:00']]],
      { fields: ['id','date_order'], limit: 2000 });

    const orderIds = orders.map(o => o.id);
    const orderDateMap = {};
    orders.forEach(o => { orderDateMap[o.id] = (o.date_order||'').slice(0,10); });

    let salesToday=0, costToday=0, salesMtd=0, costMtd=0;

    if (orderIds.length > 0) {
      const lines = await odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id','in',orderIds],['price_subtotal','>',0]]],
        { fields: ['order_id','price_subtotal','purchase_price','product_uom_qty'], limit: 10000 });

      lines.forEach(line => {
        const oid = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
        const date = orderDateMap[oid] || '';
        const rev = line.price_subtotal || 0;
        const cost = (line.purchase_price||0) * (line.product_uom_qty||0);
        salesMtd += rev; costMtd += cost;
        if (date === today) { salesToday += rev; costToday += cost; }
      });
    }

    // Q2: Invoices MTD
    const invoices = await odooCall(uid, 'account.move', 'search_read',
      [[['move_type','in',['out_invoice','out_refund']],['state','=','posted'],
        ['invoice_date','>=',monthStart],['invoice_date','<',tomorrow]]],
      { fields: ['move_type','amount_untaxed','invoice_origin'], limit: 2000 });

    let salesInv = 0;
    const invoiceOrigins = [];
    invoices.forEach(inv => {
      const amt = inv.amount_untaxed || 0;
      if (inv.move_type === 'out_invoice') {
        salesInv += amt;
        if (inv.invoice_origin) invoiceOrigins.push(inv.invoice_origin);
      } else if (inv.move_type === 'out_refund') {
        salesInv -= amt;
      }
    });

    let gpInv = 0;
    if (invoiceOrigins.length > 0) {
      const linkedOrders = await odooCall(uid, 'sale.order', 'search_read',
        [[['name','in',invoiceOrigins]]],
        { fields: ['name','margin'], limit: 2000 });
      linkedOrders.forEach(o => { gpInv += (o.margin || 0); });
    }

    // Q3: Pipeline — confirmed orders not fully delivered, grouped by commitment_date
    const pipelineOrders = await odooCall(uid, 'sale.order', 'search_read',
      [[['state','=','sale'],['delivery_status','in',['pending','waiting','ready']],
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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orders: { salesToday, costToday, salesMtd, costMtd },
        invoices: { salesInv, gpInv },
        pipeline: pipelineByMonth,
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
