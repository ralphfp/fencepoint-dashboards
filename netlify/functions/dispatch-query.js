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
  if (typeof val === 'object') return `<struct>${Object.entries(val).map(([k,v]) => `<member><n>${k}</n><value>${toXml(v)}</value></member>`).join('')}</struct>`;
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
    const msg = xml.match(/<n>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? msg[1].slice(0,300) : 'XML-RPC fault');
  }
  return extractArrayData(xml);
}

async function odooSearchAll(uid, model, domain, fields, pageSize=500) {
  let all=[], offset=0;
  while(true) {
    const batch = await odooCall(uid, model, 'search_read', [domain], {fields, limit:pageSize, offset});
    all = all.concat(batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { today } = JSON.parse(event.body || '{"today":"2026-01-01"}');
    const uid = await getUid();

    const LOC_IDS = [8,11,23,24,25,26,27,28,29,30,31,32,33,34,35,36];

    // Fetch pending (from today) + all part-shipped — both Commercial AND Timber teams
    const orderFields = ['id','name','partner_id','commitment_date','delivery_status',
                         'user_id','client_order_ref','tag_ids','team_id'];

    let step = 'orders';
    const [pendingOrders, startedOrders] = await Promise.all([
      odooCall(uid, 'sale.order', 'search_read',
        [[['state','=','sale'],['commitment_date','>=',today+' 00:00:00'],
          ['delivery_status','=','pending']]],
        { fields: orderFields, order: 'commitment_date asc', limit: 500 }),
      odooCall(uid, 'sale.order', 'search_read',
        [[['state','=','sale'],['delivery_status','=','started']]],
        { fields: orderFields, order: 'commitment_date asc', limit: 500 }),
    ]);

    const seenIds = new Set();
    const orders = [];
    [...startedOrders, ...pendingOrders].forEach(o => {
      if (!seenIds.has(o.id)) { seenIds.add(o.id); orders.push(o); }
    });

    if (!orders.length) return {
      statusCode: 200, headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ orders: [] })
    };

    const orderIds = orders.map(o => o.id);

    // All parallel fetches
    step = 'lines+pickings';
    const [lines, pickings, stockQuants] = await Promise.all([

      // SO lines — include route_id for dropship detection
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id','in',orderIds],['display_type','=',false],
          ['is_delivery','=',false],['product_uom_qty','>',0]]],
        { fields: ['order_id','product_id','name','product_uom_qty','product_uom','route_id'], limit: 5000 }),

      // Pickings — both PICK/* and DEL/* for same orders (include Done so PICK sheet always available)
      odooCall(uid, 'stock.picking', 'search_read',
        [[['sale_id','in',orderIds],['state','not in',['cancel']]]],
        { fields: ['sale_id','name','scheduled_date','picking_type_code',
                   'carrier_id','x_studio_transport_company','note'], limit: 2000 }),

      // Stock on hand — fetched after we know product IDs, so done separately below
      Promise.resolve([]),  // placeholder, stock fetched after lines
    ]);

    // Group lines to get product IDs first
    const productIds = [...new Set(lines.map(l => Array.isArray(l.product_id)?l.product_id[0]:l.product_id).filter(Boolean))];

    // Targeted stock quant fetch — only products on these orders
    const qohMap = {};
    if (productIds.length > 0) {
      step = 'stock_quant';
      const stockQuants = await odooCall(uid, 'stock.quant', 'search_read',
        [[['location_id','in',LOC_IDS],['product_id','in',productIds]]],
        { fields: ['product_id','quantity'], limit: 5000 });
      stockQuants.forEach(q => {
        const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
        qohMap[pid] = (qohMap[pid]||0) + (q.quantity||0);
      });
    }

    // Picking maps
    const pickMap = {};   // sale_id -> PICK scheduled_date
    const delMap  = {};   // sale_id -> DEL scheduled_date
    const transportMap = {};
    const noteMap = {};

    const pickIdMap = {};  // sale_id -> PICK picking id
    pickings.forEach(p => {
      const sid = Array.isArray(p.sale_id) ? p.sale_id[0] : p.sale_id;
      if (!sid) return;
      const isOutgoing = p.picking_type_code === 'outgoing';
      const isPick = (p.name||'').startsWith('PICK/');
      const isDel  = (p.name||'').startsWith('DEL/');

      if (isPick && !pickMap[sid]) { pickMap[sid] = p.scheduled_date || ''; pickIdMap[sid] = p.id; }
      if (isDel  && !delMap[sid])  delMap[sid]  = p.scheduled_date || '';

      // Transport + note from DEL picking
      if (isOutgoing) {
        const transport = p.x_studio_transport_company ||
                          (Array.isArray(p.carrier_id) ? p.carrier_id[1] : '') || '';
        if (transport && !transportMap[sid]) transportMap[sid] = transport;
        if (p.note && !noteMap[sid]) noteMap[sid] = p.note;
      }
    });

    // Lines — detect dropship (route_id = 9) and non-stock (x_studio_stocked_item=false handled later)
    // Group by order, flag each line
    const linesByOrder = {};

    lines.forEach(l => {
      const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!linesByOrder[oid]) linesByOrder[oid] = [];
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const routeId = Array.isArray(l.route_id) ? l.route_id[0] : (l.route_id||0);
      const isDropship = routeId === 9;
      linesByOrder[oid].push({
        product: Array.isArray(l.product_id) ? l.product_id[1] : '',
        product_id: pid,
        description: l.name || '',
        qty: l.product_uom_qty || 0,
        uom: Array.isArray(l.product_uom) ? l.product_uom[1] : '',
        qoh: qohMap[pid] !== undefined ? qohMap[pid] : null,
        dropship: isDropship,
      });
    });

    // Check non-stock: get template IDs for our product variants, then check x_studio_stocked_item
    // Two-step to avoid dotted path in XML-RPC domain
    let nonStockPids = new Set();
    if (productIds.length > 0) {
      step = 'non_stock_variants';
      const variantRecs = await odooCall(uid, 'product.product', 'search_read',
        [[['id','in',productIds]]],
        { fields: ['id','product_tmpl_id'], limit: 2000 });
      const tmplIds = [...new Set(variantRecs.map(p => Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id))];
      const tmplToVariants = {};
      variantRecs.forEach(p => {
        const tid = Array.isArray(p.product_tmpl_id)?p.product_tmpl_id[0]:p.product_tmpl_id;
        if (!tmplToVariants[tid]) tmplToVariants[tid] = [];
        tmplToVariants[tid].push(p.id);
      });
      if (tmplIds.length > 0) {
        const nonStockTmpls = await odooCall(uid, 'product.template', 'search_read',
          [[['id','in',tmplIds],['x_studio_stocked_item','=',false]]],
          { fields: ['id'], limit: 2000 });
        nonStockTmpls.forEach(t => {
          (tmplToVariants[t.id]||[]).forEach(pid => nonStockPids.add(pid));
        });
      }
    }

    // Mark non-stock on lines
    Object.values(linesByOrder).forEach(lineArr => {
      lineArr.forEach(l => {
        l.nonStock = nonStockPids.has(l.product_id);
      });
    });

    const result = orders.map(o => ({
      id: o.id,
      name: o.name,
      customer: Array.isArray(o.partner_id) ? o.partner_id[1] : '',
      ref: o.client_order_ref || '',
      tag_ids: Array.isArray(o.tag_ids) ? o.tag_ids : [],
      team: Array.isArray(o.team_id) ? o.team_id[1] : '',
      commitment_date: o.commitment_date || '',   // Collection Date (renamed)
      pick_date: pickMap[o.id] || '',             // Pick Date from PICK/* picking
      delivery_status: o.delivery_status || '',
      salesperson: Array.isArray(o.user_id) ? o.user_id[1] : '',
      transport: transportMap[o.id] || '',
      note: noteMap[o.id] || '',
      pick_id: pickIdMap[o.id] || null,
      lines: linesByOrder[o.id] || [],
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ orders: result })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, step: typeof step !== 'undefined' ? step : 'unknown', stack: err.stack ? err.stack.slice(0,500) : '' })
    };
  }
};
