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
    const { today } = JSON.parse(event.body);
    const uid = await getUid();

    // Fetch in two passes:
    // 1. Pending orders with commitment_date from today onwards
    // 2. ALL part-shipped (started) orders regardless of commitment_date
    const [pendingOrders, startedOrders] = await Promise.all([
      odooCall(uid, 'sale.order', 'search_read',
        [[
          ['state', '=', 'sale'],
          ['commitment_date', '>=', today + ' 00:00:00'],
          ['delivery_status', '=', 'pending'],
          ['tag_ids', 'in', [20]],
        ]],
        {
          fields: ['id','name','partner_id','commitment_date','delivery_status',
                   'user_id','amount_untaxed','margin','client_order_ref','tag_ids'],
          order: 'commitment_date asc',
          limit: 500
        }
      ),
      odooCall(uid, 'sale.order', 'search_read',
        [[
          ['state', '=', 'sale'],
          ['delivery_status', '=', 'started'],
          ['tag_ids', 'in', [20]],
        ]],
        {
          fields: ['id','name','partner_id','commitment_date','delivery_status',
                   'user_id','amount_untaxed','margin','client_order_ref','tag_ids'],
          order: 'commitment_date asc',
          limit: 500
        }
      ),
    ]);

    // Merge — started orders first (already in progress), then pending by date
    // Deduplicate in case a started order also has commitment_date >= today
    const seenIds = new Set();
    const orders = [];
    [...startedOrders, ...pendingOrders].forEach(o => {
      if (!seenIds.has(o.id)) { seenIds.add(o.id); orders.push(o); }
    });

    if (!orders.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [] })
      };
    }

    const orderIds = orders.map(o => o.id);

    // Get order lines (exclude delivery, section/note lines, zero-qty)
    const lines = await odooCall(uid, 'sale.order.line', 'search_read',
      [[
        ['order_id', 'in', orderIds],
        ['display_type', '=', false],
        ['is_delivery', '=', false],
        ['product_uom_qty', '>', 0],
      ]],
      {
        fields: ['order_id','product_id','name','product_uom_qty','product_uom','price_subtotal'],
        limit: 5000
      }
    );

    // Group lines by order id
    const linesByOrder = {};
    lines.forEach(l => {
      const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!linesByOrder[oid]) linesByOrder[oid] = [];
      linesByOrder[oid].push({
        product: Array.isArray(l.product_id) ? l.product_id[1] : '',
        description: l.name || '',
        qty: l.product_uom_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : '',
        subtotal: l.price_subtotal || 0,
      });
    });

    const result = orders.map(o => ({
      id: o.id,
      name: o.name,
      customer: Array.isArray(o.partner_id) ? o.partner_id[1] : '',
      ref: o.client_order_ref || '',
      tag_ids: Array.isArray(o.tag_ids) ? o.tag_ids : [],
      commitment_date: o.commitment_date || '',
      delivery_status: o.delivery_status || '',
      salesperson: Array.isArray(o.user_id) ? o.user_id[1] : '',
      revenue: o.amount_untaxed || 0,
      margin: o.margin || 0,
      lines: linesByOrder[o.id] || [],
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: result })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
