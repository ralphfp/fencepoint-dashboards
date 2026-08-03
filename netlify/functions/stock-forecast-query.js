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
    const threeMonthsAgo = new Date(Date.now() - 91*86400000).toISOString().slice(0,10);
    const histStart      = new Date(Date.now() - 182*86400000).toISOString().slice(0,10);

    // ── SINGLE PARALLEL BATCH: all independent queries at once ──
    const [
      stockedTmplRecs,
      stockRecs,
      bomHeaders,
      bomLines,
      confirmedDemandLines,
      quotedSoLines,
      quotedSoHeaders,     // includes opportunity_id + state
      crmLeads,            // all active leads with probability + close date
      invoiceHeaders,
      invoiceLines,
      poHeaders,
      poLines,
      suppliers,
    ] = await Promise.all([

      odooCall(uid, 'product.template', 'search_read',
        [[['x_studio_stocked_item','=',true],['active','=',true]]],
        { fields: ['id'], limit: 2000 }),

      odooCall(uid, 'stock.quant', 'search_read',
        [[['location_id','in',LOC_IDS],['quantity','>',0]]],
        { fields: ['product_id','quantity','reserved_quantity'], limit: 5000 }),

      odooCall(uid, 'mrp.bom', 'search_read',
        [[['type','=','phantom']]],
        { fields: ['id','product_tmpl_id','product_qty'], limit: 500 }),

      odooCall(uid, 'mrp.bom.line', 'search_read',
        [[]],
        { fields: ['bom_id','product_id','product_qty'], limit: 3000 }),

      // Confirmed undelivered demand
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id.state','=','sale'],
          ['product_uom_qty','>',0],
          ['qty_delivered','<','product_uom_qty']]],
        { fields: ['product_id','product_uom_qty','qty_delivered'], limit: 3000 }),

      // Quoted SO lines
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id.state','in',['draft','sent']],['product_uom_qty','>',0]]],
        { fields: ['product_id','product_uom_qty','order_id'], limit: 3000 }),

      // SO headers for quoted lines — includes opportunity_id and state
      odooCall(uid, 'sale.order', 'search_read',
        [[['state','in',['draft','sent']]]],
        { fields: ['id','state','opportunity_id'], limit: 2000 }),

      // All active CRM leads with probability + close date
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',true]]],
        { fields: ['id','probability','date_deadline'], limit: 3000 }),

      // Invoice headers for run rate
      odooCall(uid, 'account.move', 'search_read',
        [[['move_type','=','out_invoice'],['state','=','posted'],
          ['invoice_date','>=',histStart]]],
        { fields: ['id','invoice_date'], limit: 3000 }),

      // Invoice lines for run rate
      odooCall(uid, 'account.move.line', 'search_read',
        [[['move_id.move_type','=','out_invoice'],['move_id.state','=','posted'],
          ['move_id.invoice_date','>=',threeMonthsAgo],
          ['quantity','>',0],['product_id','!=',false]]],
        { fields: ['product_id','quantity','move_id'], limit: 5000 }),

      odooCall(uid, 'purchase.order', 'search_read',
        [[['state','in',['purchase','done']]]],
        { fields: ['id','name','partner_id','date_order'], limit: 2000 }),

      odooCall(uid, 'purchase.order.line', 'search_read',
        [[['qty_received','<','product_qty'],['product_qty','>',0]]],
        { fields: ['order_id','product_id','product_qty','qty_received','date_planned','price_unit'], limit: 2000 }),

      odooCall(uid, 'product.supplierinfo', 'search_read',
        [[['delay','>',0]]],
        { fields: ['product_tmpl_id','delay','price'], limit: 5000 }),
    ]);

    // ── Round trip 2: Products (needs stocked IDs from trip 1) ──
    const stockedTmplIds = stockedTmplRecs.map(r => r.id);
    const products = stockedTmplIds.length > 0
      ? await odooCall(uid, 'product.product', 'search_read',
          [[['active','=',true],['product_tmpl_id','in',stockedTmplIds]]],
          { fields: ['id','product_tmpl_id','default_code'], limit: 3000 })
      : [];

    // ── Aggregate ──

    const stockMap = {};
    stockRecs.forEach(s => {
      const pid = Array.isArray(s.product_id) ? s.product_id[0] : s.product_id;
      if (!stockMap[pid]) stockMap[pid] = { current_stock: 0, reserved_qty: 0 };
      stockMap[pid].current_stock += (s.quantity||0);
      stockMap[pid].reserved_qty  += (s.reserved_quantity||0);
    });

    const supplierMap = {};
    suppliers.forEach(s => {
      const tid = Array.isArray(s.product_tmpl_id) ? s.product_tmpl_id[0] : s.product_tmpl_id;
      if (!supplierMap[tid] || s.delay < supplierMap[tid].lead_days)
        supplierMap[tid] = { lead_days: s.delay, unit_cost: s.price };
    });

    const bomIdToTmpl = {};
    bomHeaders.forEach(b => {
      bomIdToTmpl[b.id] = {
        tmplId: Array.isArray(b.product_tmpl_id) ? b.product_tmpl_id[0] : b.product_tmpl_id,
        bom_qty: b.product_qty || 1,
      };
    });
    const bomMap = {};
    bomLines.forEach(l => {
      const bid = Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id;
      const h = bomIdToTmpl[bid];
      if (!h) return;
      if (!bomMap[h.tmplId]) bomMap[h.tmplId] = { bom_qty: h.bom_qty, components: [] };
      bomMap[h.tmplId].components.push({
        pid: Array.isArray(l.product_id) ? l.product_id[0] : l.product_id,
        qty: l.product_qty || 1,
      });
    });

    const confirmedDemandMap = {};
    confirmedDemandLines.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const qty = (l.product_uom_qty||0) - (l.qty_delivered||0);
      if (qty > 0) confirmedDemandMap[pid] = (confirmedDemandMap[pid]||0) + qty;
    });

    // CRM lead map
    const crmLeadMap = {};
    crmLeads.forEach(c => { crmLeadMap[c.id] = c; });

    // SO → opportunity map
    const soOppMap = {};
    quotedSoHeaders.forEach(s => {
      const oid = Array.isArray(s.opportunity_id) ? s.opportunity_id[0] : s.opportunity_id;
      soOppMap[s.id] = { state: s.state, oppId: oid || null };
    });

    // Pipeline demand with CRM probability weighting
    const pipelineDemandMap = {}, pipelineNominalMap = {}, pipelineLinesMap = {};
    quotedSoLines.forEach(l => {
      const pid   = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const soId  = Array.isArray(l.order_id)   ? l.order_id[0]   : l.order_id;
      const so    = soOppMap[soId] || {};
      const crm   = so.oppId ? crmLeadMap[so.oppId] : null;
      const prob  = crm ? (crm.probability || 20)
                        : (so.state === 'sent' ? 60 : 30);
      const closeDate = crm ? (crm.date_deadline || null) : null;
      const qty   = l.product_uom_qty || 0;
      pipelineDemandMap[pid]  = (pipelineDemandMap[pid]||0)  + qty * prob / 100;
      pipelineNominalMap[pid] = (pipelineNominalMap[pid]||0) + qty;
      if (!pipelineLinesMap[pid]) pipelineLinesMap[pid] = [];
      pipelineLinesMap[pid].push({ qty, prob, close_date: closeDate });
    });

    // PO aggregation
    const poMap = {}, poLinesAll = [], lastPriceMap = {}, poInfoMap = {};
    const confirmedPoIds = new Set(poHeaders.map(p => p.id));
    poHeaders.forEach(p => {
      poInfoMap[p.id] = {
        name: p.name,
        supplier: Array.isArray(p.partner_id) ? p.partner_id[1] : '',
        date_order: p.date_order,
      };
    });
    poLines.forEach(l => {
      const oid = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!confirmedPoIds.has(oid)) return;
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const incoming = (l.product_qty||0) - (l.qty_received||0);
      if (incoming <= 0) return;
      poMap[pid] = (poMap[pid]||0) + incoming;
      const info = poInfoMap[oid] || {};
      poLinesAll.push({ product_id: pid, incoming,
        date_planned: l.date_planned, order_id: oid,
        po_name: info.name, supplier: info.supplier });
      if (l.price_unit > 0 && (!lastPriceMap[pid] || info.date_order > (lastPriceMap[pid]||{}).date))
        lastPriceMap[pid] = { price: l.price_unit, date: info.date_order };
    });

    // Run rate + last month from invoice lines
    const runRateMap = {}, lastMonthMap = {};
    const lastMonthCutoff = new Date(Date.now() - 31*86400000).toISOString().slice(0,10);
    const invoiceDateMap = {};
    invoiceHeaders.forEach(i => { invoiceDateMap[i.id] = i.invoice_date; });

    invoiceLines.forEach(l => {
      const pid  = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const mid  = Array.isArray(l.move_id)    ? l.move_id[0]    : l.move_id;
      const qty  = l.quantity || 0;
      const date = invoiceDateMap[mid] || '';
      runRateMap[pid]  = (runRateMap[pid]||0)  + qty;
      if (date >= lastMonthCutoff) lastMonthMap[pid] = (lastMonthMap[pid]||0) + qty;
    });
    Object.keys(runRateMap).forEach(k => { runRateMap[k] = runRateMap[k] / 3; });

    // Trimmed weekly sigma
    const weeklyByPid = {};
    invoiceLines.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      const dateStr = invoiceDateMap[mid];
      if (!dateStr) return;
      const d = new Date(dateStr);
      const wk = d.getFullYear() + '-W' +
        Math.ceil(((d - new Date(d.getFullYear(),0,1))/86400000 + new Date(d.getFullYear(),0,1).getDay() + 1) / 7);
      if (!weeklyByPid[pid]) weeklyByPid[pid] = {};
      weeklyByPid[pid][wk] = (weeklyByPid[pid][wk]||0) + (l.quantity||0);
    });
    const sigmaTrimmedMap = {};
    Object.entries(weeklyByPid).forEach(([pid, wks]) => {
      const vals = Object.values(wks).sort((a,b)=>a-b);
      const trimmed = vals.slice(0, Math.floor(vals.length * 0.9));
      if (trimmed.length < 4) return;
      const mean = trimmed.reduce((s,v)=>s+v,0) / trimmed.length;
      const variance = trimmed.reduce((s,v)=>s+(v-mean)**2,0) / (trimmed.length-1);
      sigmaTrimmedMap[Number(pid)] = Math.sqrt(variance);
    });

    const productList = products.map(p => ({
      id: p.id,
      product_tmpl_id: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id,
      product_tmpl_id_label: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[1] : '',
      default_code: p.default_code || '',
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        products: productList, supplierMap, stockMap, bomMap,
        pipelineDemandMap, pipelineNominalMap, pipelineLinesMap,
        confirmedDemandMap, invoiceDateMap, invoiceLines,
        poMap, poLinesAll, lastPriceMap, runRateMap, lastMonthMap, sigmaTrimmedMap,
      }),
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
