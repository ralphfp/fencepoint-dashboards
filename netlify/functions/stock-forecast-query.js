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
    const today = new Date();
    const threeMonthsAgo = new Date(Date.now() - 91*86400000).toISOString().slice(0,10);
    const oneMonthAgo    = new Date(Date.now() - 31*86400000).toISOString().slice(0,10);
    const histStart      = new Date(Date.now() - 182*86400000).toISOString().slice(0,10);

    // ── Step 0: Stocked product templates ──
    const stockedTmplRecs = await odooCall(uid, 'product.template', 'search_read',
      [[['x_studio_stocked_item','=',true],['active','=',true]]],
      { fields: ['id'], limit: 2000 });
    const stockedTmplIds = stockedTmplRecs.map(r => r.id);

    // ── Parallel group 1: products, suppliers, stock, BoMs ──
    const [products, suppliers, stockRecs, bomHeaders, bomLines] = await Promise.all([

      stockedTmplIds.length > 0
        ? odooCall(uid, 'product.product', 'search_read',
            [[['active','=',true],['product_tmpl_id','in',stockedTmplIds]]],
            { fields: ['id','product_tmpl_id','default_code','name'], limit: 3000 })
        : Promise.resolve([]),

      odooCall(uid, 'product.supplierinfo', 'search_read',
        [[['delay','>',0]]],
        { fields: ['product_tmpl_id','delay','price'], limit: 5000 }),

      odooCall(uid, 'stock.quant', 'search_read',
        [[['location_id','in',LOC_IDS]]],
        { fields: ['product_id','quantity','reserved_quantity'], limit: 3000 }),

      odooCall(uid, 'mrp.bom', 'search_read',
        [[['type','=','phantom']]],
        { fields: ['id','product_tmpl_id','product_qty'], limit: 500 }),

      odooCall(uid, 'mrp.bom.line', 'search_read',
        [[]],
        { fields: ['bom_id','product_id','product_qty'], limit: 3000 }),
    ]);

    // ── Parallel group 2: demand, pipeline, invoice headers, PO headers ──
    const [pipelineDemand, confirmedDemand, pipelineLines, invoiceHeaders, poHeaders, runRate, lastMonthRate] = await Promise.all([

      // CRM-weighted pipeline demand
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id.state','in',['draft','sent']],['product_uom_qty','>',0]]],
        { fields: ['order_id','product_id','product_uom_qty'], limit: 3000 }),

      // Confirmed undelivered demand
      odooCall(uid, 'sale.order.line', 'search_read',
        [[['order_id.state','=','sale'],['product_uom_qty','>',0]]],
        { fields: ['order_id','product_id','product_uom_qty','qty_delivered'], limit: 3000 }),

      // Pipeline lines with CRM close dates
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',true],['stage_id.name','not in',['Won','Lost']]]],
        { fields: ['id','probability','date_deadline'], limit: 2000 }),

      // Invoice headers for run rate (last 26 weeks)
      odooCall(uid, 'account.move', 'search_read',
        [[['move_type','=','out_invoice'],['state','=','posted'],
          ['invoice_date','>=',histStart]]],
        { fields: ['id','invoice_date'], limit: 3000 }),

      // PO headers
      odooCall(uid, 'purchase.order', 'search_read',
        [[['state','in',['purchase','done']]]],
        { fields: ['id','name','partner_id','date_order'], limit: 2000 }),

      // 3-month run rate from invoice lines
      odooCall(uid, 'account.move.line', 'search_read',
        [[['move_id.move_type','=','out_invoice'],['move_id.state','=','posted'],
          ['move_id.invoice_date','>=',threeMonthsAgo],['quantity','>',0],
          ['product_id','!=',false]]],
        { fields: ['product_id','quantity'], limit: 5000 }),

      // Last month rate
      odooCall(uid, 'account.move.line', 'search_read',
        [[['move_id.move_type','=','out_invoice'],['move_id.state','=','posted'],
          ['move_id.invoice_date','>=',oneMonthAgo],['quantity','>',0],
          ['product_id','!=',false]]],
        { fields: ['product_id','quantity'], limit: 5000 }),
    ]);

    // Get sale order states for pipeline demand weighting
    const quoteSoIds = [...new Set(pipelineDemand.map(l =>
      Array.isArray(l.order_id) ? l.order_id[0] : l.order_id))];
    let soStates = [];
    if (quoteSoIds.length > 0) {
      soStates = await odooCall(uid, 'sale.order', 'search_read',
        [[['id','in',quoteSoIds]]],
        { fields: ['id','state','opportunity_id'], limit: 2000 });
    }

    // ── Parallel group 3: invoice lines, PO lines ──
    const allInvIds = invoiceHeaders.map(i => i.id);
    const [invoiceLines, poLines] = await Promise.all([

      allInvIds.length > 0
        ? odooSearchAll(uid, 'account.move.line',
            [['move_id','in',allInvIds],['quantity','>',0],['product_id','!=',false]],
            ['move_id','product_id','quantity'], 2000)
        : Promise.resolve([]),

      odooCall(uid, 'purchase.order.line', 'search_read',
        [[['qty_received','<','product_qty']]],
        { fields: ['order_id','product_id','product_qty','qty_received','date_planned','price_unit'], limit: 2000 }),
    ]);

    // Aggregate run rate by product
    const runRateMap = {};
    runRate.forEach(r => {
      const pid = Array.isArray(r.product_id) ? r.product_id[0] : r.product_id;
      runRateMap[pid] = (runRateMap[pid]||0) + (r.quantity||0);
    });
    Object.keys(runRateMap).forEach(k => { runRateMap[k] = runRateMap[k] / 3; });

    const lastMonthMap = {};
    lastMonthRate.forEach(r => {
      const pid = Array.isArray(r.product_id) ? r.product_id[0] : r.product_id;
      lastMonthMap[pid] = (lastMonthMap[pid]||0) + (r.quantity||0);
    });

    // Aggregate confirmed demand by product
    const confirmedDemandMap = {};
    confirmedDemand.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const undelivered = (l.product_uom_qty||0) - (l.qty_delivered||0);
      if (undelivered > 0) confirmedDemandMap[pid] = (confirmedDemandMap[pid]||0) + undelivered;
    });

    // Build CRM lead map
    const crmLeadMap = {};
    pipelineLines.forEach(l => { crmLeadMap[l.id] = l; });

    // Build SO → opportunity map
    const soOppMap = {};
    soStates.forEach(s => {
      const oppId = Array.isArray(s.opportunity_id) ? s.opportunity_id[0] : s.opportunity_id;
      soOppMap[s.id] = { state: s.state, oppId };
    });

    // Aggregate pipeline demand by product with CRM weighting
    const pipelineDemandMap = {}, pipelineNominalMap = {}, pipelineLinesMap = {};
    pipelineDemand.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const soId = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      const so = soOppMap[soId] || {};
      const crm = so.oppId ? crmLeadMap[so.oppId] : null;
      const prob = crm ? (crm.probability||20) : (so.state === 'sent' ? 60 : 30);
      const closeDate = crm ? crm.date_deadline : null;
      const qty = l.product_uom_qty || 0;
      pipelineDemandMap[pid] = (pipelineDemandMap[pid]||0) + qty * prob / 100;
      pipelineNominalMap[pid] = (pipelineNominalMap[pid]||0) + qty;
      if (!pipelineLinesMap[pid]) pipelineLinesMap[pid] = [];
      pipelineLinesMap[pid].push({ qty, prob, close_date: closeDate });
    });

    // Aggregate incoming PO by product
    const poMap = {};
    const poInfoMap = {};
    const confirmedPoIds = new Set(poHeaders.map(p => p.id));
    poHeaders.forEach(p => {
      const suppName = Array.isArray(p.partner_id) ? p.partner_id[1] : '';
      poInfoMap[p.id] = { name: p.name, supplier: suppName, date_order: p.date_order };
    });
    const poLinesAll = [];
    poLines.forEach(l => {
      const orderId = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      if (!confirmedPoIds.has(orderId)) return;
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const incoming = (l.product_qty||0) - (l.qty_received||0);
      if (incoming > 0) {
        poMap[pid] = (poMap[pid]||0) + incoming;
        const info = poInfoMap[orderId] || {};
        poLinesAll.push({ product_id: pid, incoming, date_planned: l.date_planned,
          order_id: orderId, po_name: info.name, supplier: info.supplier });
      }
    });

    // Build last PO price map
    const lastPriceMap = {};
    poLines.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const orderId = Array.isArray(l.order_id) ? l.order_id[0] : l.order_id;
      const price = l.price_unit || 0;
      const date = (poInfoMap[orderId] || {}).date_order || '';
      if (price > 0 && (!lastPriceMap[pid] || date > lastPriceMap[pid].date)) {
        lastPriceMap[pid] = { price, date };
      }
    });

    // Aggregate stock by product
    const stockMap = {};
    stockRecs.forEach(s => {
      const pid = Array.isArray(s.product_id) ? s.product_id[0] : s.product_id;
      if (!stockMap[pid]) stockMap[pid] = { current_stock: 0, reserved_qty: 0 };
      stockMap[pid].current_stock += (s.quantity||0);
      stockMap[pid].reserved_qty  += (s.reserved_quantity||0);
    });

    // Aggregate supplier info by product template
    const supplierMap = {};
    suppliers.forEach(s => {
      const tmplId = Array.isArray(s.product_tmpl_id) ? s.product_tmpl_id[0] : s.product_tmpl_id;
      if (!supplierMap[tmplId] || s.delay < supplierMap[tmplId].delay) {
        supplierMap[tmplId] = { lead_days: s.delay, unit_cost: s.price };
      }
    });

    // Build product map
    const productMap = {};
    products.forEach(p => {
      productMap[p.id] = {
        id: p.id,
        product_tmpl_id: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id,
        product_tmpl_id_label: Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[1] : '',
        default_code: p.default_code || '',
      };
    });

    // Build BoM maps
    const bomIdToTmpl = {};
    bomHeaders.forEach(b => {
      bomIdToTmpl[b.id] = {
        tmplId: Array.isArray(b.product_tmpl_id) ? b.product_tmpl_id[0] : b.product_tmpl_id,
        bom_qty: b.product_qty || 1,
      };
    });
    const bomMap = {};
    bomLines.forEach(l => {
      const header = bomIdToTmpl[Array.isArray(l.bom_id) ? l.bom_id[0] : l.bom_id];
      if (!header) return;
      const { tmplId, bom_qty } = header;
      if (!bomMap[tmplId]) bomMap[tmplId] = { bom_qty, components: [] };
      bomMap[tmplId].components.push({
        pid: Array.isArray(l.product_id) ? l.product_id[0] : l.product_id,
        qty: l.product_qty || 1,
      });
    });

    // Invoice date map
    const invoiceDateMap = {};
    invoiceHeaders.forEach(i => { invoiceDateMap[i.id] = i.invoice_date; });

    // Weekly demand for run rate / sigma
    const weeklyByPid = {};
    invoiceLines.forEach(l => {
      const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
      const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
      const dateStr = invoiceDateMap[mid];
      if (!dateStr) return;
      const d = new Date(dateStr);
      const startOfYear = new Date(d.getFullYear(), 0, 1);
      const wk = d.getFullYear() + '-' + Math.ceil(((d - startOfYear)/86400000 + startOfYear.getDay() + 1) / 7);
      if (!weeklyByPid[pid]) weeklyByPid[pid] = {};
      weeklyByPid[pid][wk] = (weeklyByPid[pid][wk]||0) + (l.quantity||0);
    });

    const sigmaTrimmedMap = {};
    Object.entries(weeklyByPid).forEach(([pidStr, weekMap]) => {
      const weeks = Object.values(weekMap).sort((a,b) => a-b);
      const cutIdx = Math.floor(weeks.length * 0.90);
      const trimmed = weeks.slice(0, cutIdx);
      if (trimmed.length < 4) return;
      const mean = trimmed.reduce((s,v) => s+v, 0) / trimmed.length;
      const variance = trimmed.reduce((s,v) => s + (v-mean)**2, 0) / (trimmed.length - 1);
      sigmaTrimmedMap[Number(pidStr)] = Math.sqrt(variance);
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        products: Object.values(productMap),
        supplierMap,
        stockMap,
        bomMap,
        pipelineDemandMap,
        pipelineNominalMap,
        pipelineLinesMap,
        confirmedDemandMap,
        invoiceDateMap,
        invoiceLines,
        poMap,
        poLinesAll,
        lastPriceMap,
        runRateMap,
        lastMonthMap,
        sigmaTrimmedMap,
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
