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

function extractVal(v) {
  v = v.trim();
  if (v.startsWith('<int>') || v.startsWith('<i4>')) return parseInt(v.replace(/<\/?(?:int|i4)>/g,''));
  if (v.startsWith('<double>')) return parseFloat(v.replace(/<\/?double>/g,''));
  if (v.startsWith('<boolean>')) return v.includes('>1<');
  if (v.startsWith('<string>')) return v.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#10;/g,'\n').trim();
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
  const match = xml.match(/<int>(\d+)<\/int>|<i4>(\d+)<\/i4>/);
  const uid = match ? parseInt(match[1]||match[2]) : null;
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

function stripHtml(html) {
  return (html||'').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]+>/g,'')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/\s+/g,' ').trim();
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { pid, fromStr, toStr, priorFrom, priorTo } = JSON.parse(event.body);
    const uid = await getUid();

    // 1. Recent calls for this partner
    const callMessages = await odooCall(uid, 'mail.message', 'search_read', [[
      ['model', '=', 'res.partner'],
      ['res_id', '=', pid],
      ['body', 'like', 'Call'],
      ['subtype_id.name', 'in', ['Note', 'Discussions']],
    ]], { fields: ['date', 'body', 'author_id'], order: 'date desc', limit: 5 });

    const calls = callMessages.map(m => {
      const body = stripHtml(m.body || '');
      let callType = 'Call';
      if (body.includes('Proactive Call')) callType = 'Proactive Call';
      else if (body.includes('Inbound Call')) callType = 'Inbound Call';
      else if (body.includes('Account Management')) callType = 'Account Management Call';
      else if (body.includes('Opportunity Follow Up')) callType = 'Opp. Follow Up';
      else if (body.includes('Quote Follow Up')) callType = 'Quote Follow Up';

      // Extract feedback
      let feedback = '';
      const fbMatch = body.match(/Feedback[:\s]+([\s\S]+)/i);
      if (fbMatch) feedback = fbMatch[1].trim().slice(0, 200);
      else feedback = body.replace(/^[^:]+:\s*/, '').slice(0, 200);

      const date = (m.date || '').slice(0, 10);
      return [date, callType, feedback];
    }).filter(c => c[0]);

    // 2. Category spend — current period
    const invoiceLinesCurrentRaw = await odooCall(uid, 'account.move.line', 'search_read', [[
      ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
      ['move_id.state', '=', 'posted'],
      ['move_id.invoice_date', '>=', fromStr],
      ['move_id.invoice_date', '<=', toStr],
      ['partner_id', '=', pid],
      ['product_id', '!=', false],
    ]], { fields: ['price_subtotal', 'product_id', 'move_id'], limit: 2000 });

    const invoiceLinesPriorRaw = await odooCall(uid, 'account.move.line', 'search_read', [[
      ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
      ['move_id.state', '=', 'posted'],
      ['move_id.invoice_date', '>=', priorFrom],
      ['move_id.invoice_date', '<=', priorTo],
      ['partner_id', '=', pid],
      ['product_id', '!=', false],
    ]], { fields: ['price_subtotal', 'product_id', 'move_id'], limit: 2000 });

    // Get product -> category mapping
    const allProductIds = [...new Set([
      ...invoiceLinesCurrentRaw.map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id),
      ...invoiceLinesPriorRaw.map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id),
    ])].filter(Boolean);

    // Get product templates for categories
    const products = allProductIds.length > 0 ? await odooCall(uid, 'product.product', 'search_read',
      [[['id', 'in', allProductIds]]],
      { fields: ['id', 'categ_id'], limit: 1000 }) : [];

    const productCategoryMap = {};
    products.forEach(p => {
      productCategoryMap[p.id] = Array.isArray(p.categ_id) ? p.categ_id[0] : null;
    });

    const allCategIds = [...new Set(Object.values(productCategoryMap).filter(Boolean))];
    const categories = allCategIds.length > 0 ? await odooCall(uid, 'product.category', 'search_read',
      [[['id', 'in', allCategIds]]],
      { fields: ['id', 'name', 'parent_id'], limit: 200 }) : [];

    const catMap = {};
    categories.forEach(c => {
      const parentName = Array.isArray(c.parent_id) ? c.parent_id[1] : null;
      const displayName = (parentName && parentName !== 'All' && !parentName.includes('DONOTUSE')) ? parentName : c.name;
      catMap[c.id] = displayName;
    });

    // Get move types for sign correction
    const allMoveIds = [...new Set([
      ...invoiceLinesCurrentRaw.map(l => Array.isArray(l.move_id) ? l.move_id[0] : l.move_id),
      ...invoiceLinesPriorRaw.map(l => Array.isArray(l.move_id) ? l.move_id[0] : l.move_id),
    ])];
    const moves = allMoveIds.length > 0 ? await odooCall(uid, 'account.move', 'search_read',
      [[['id', 'in', allMoveIds]]],
      { fields: ['id', 'move_type'], limit: 2000 }) : [];
    const moveTypeMap = {};
    moves.forEach(m => { moveTypeMap[m.id] = m.move_type; });

    function aggregateByCategory(lines) {
      const totals = {};
      lines.forEach(l => {
        const pid2 = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
        const mid = Array.isArray(l.move_id) ? l.move_id[0] : l.move_id;
        const catId = productCategoryMap[pid2];
        if (!catId) return;
        const cat = catMap[catId];
        if (!cat || cat.includes('DONOTUSE') || ['Miscellaneous','Landed Costs','Promotional','Deliveries'].includes(cat)) return;
        const isRefund = moveTypeMap[mid] === 'out_refund';
        const amt = isRefund ? -(l.price_subtotal||0) : (l.price_subtotal||0);
        totals[cat] = (totals[cat]||0) + amt;
      });
      return Object.entries(totals)
        .filter(([,v]) => v > 0)
        .sort((a,b) => b[1]-a[1])
        .map(([cat, total]) => [cat, total]);
    }

    const catCurrent = aggregateByCategory(invoiceLinesCurrentRaw);
    const catPrior   = aggregateByCategory(invoiceLinesPriorRaw);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ calls, catCurrent, catPrior }),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
