// Netlify function to handle activity report queries
// Translates the SQL-like queries into Odoo JSON-RPC calls

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
  if (typeof val === 'object') {
    return `<struct>${Object.entries(val).map(([k,v]) => `<member><name>${k}</name><value>${toXml(v)}</value></member>`).join('')}</struct>`;
  }
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
      } else {
        struct[key] = valXml.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
      }
    }
    results.push(struct);
  }
  return results;
}

async function odooCall(uid, model, method, args, kwargs) {
  const ODOO_URL = process.env.ODOO_URL;
  const ODOO_DB = process.env.ODOO_DB;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;
  const xml = await xmlrpc(ODOO_URL + '/xmlrpc/2/object', 'execute_kw',
    [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs || {}]);
  if (xml.includes('<fault>')) {
    const msg = xml.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? msg[1].slice(0, 300) : 'XML-RPC fault');
  }
  return extractArrayData(xml);
}

async function getUid() {
  const ODOO_URL = process.env.ODOO_URL;
  const ODOO_DB = process.env.ODOO_DB;
  const ODOO_USER = process.env.ODOO_USER;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;
  const xml = await xmlrpc(ODOO_URL + '/xmlrpc/2/common', 'authenticate',
    [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
  const uid = extractInts(xml)[0];
  if (!uid) throw new Error('Auth failed');
  return uid;
}

// Parse the SQL queries from the activity report into Odoo API calls
async function handleSql(sql, uid) {
  // mail_message query - call log
  if (sql.includes('mail_message')) {
    // Extract date range from SQL
    const dateFromMatch = sql.match(/\[date\] >= '([^']+)'/);
    const dateToMatch = sql.match(/\[date\] < '([^']+)'/);
    const dateFrom = dateFromMatch ? dateFromMatch[1] : '';
    const dateTo = dateToMatch ? dateToMatch[1] : '';

    const domain = [
      ['mail_activity_type_id.name', 'in', ['Proactive Call','Commercial Brochure Follow Up','Opportunity Follow Up Call','Quote Follow Up Call','Inbound Call','Follow up call']],
      ['author_id.name', 'in', ['Ralph Lewis','Roger Lewis','Daniel Wilkin','Amy Hope','Kayleigh Rankin']],
    ];
    if (dateFrom) domain.push(['date', '>=', dateFrom]);
    if (dateTo) domain.push(['date', '<', dateTo]);

    const rows = await odooCall(uid, 'mail.message', 'search_read', [domain],
      { fields: ['author_id', 'mail_activity_type_id', 'record_name', 'body', 'date'], limit: 500 });

    return rows.map(r => ({
      author_id_label: Array.isArray(r.author_id) ? r.author_id[1] : '',
      mail_activity_type_id_label: Array.isArray(r.mail_activity_type_id) ? r.mail_activity_type_id[1] : '',
      record_name: r.record_name || '',
      body: r.body || '',
      date: r.date || '',
    }));
  }

  // sale_order query
  if (sql.includes('sale_order') && !sql.includes('account_move') && !sql.includes('pos_order')) {
    const dateFromMatch = sql.match(/\[date_order\] >= '([^']+)'/);
    const dateToMatch = sql.match(/\[date_order\] < '([^']+)'/);
    // Check if query filters by confirmed state
    const stateFilter = sql.includes("'sale'") || sql.includes("'done'");
    const domain = [];
    if (stateFilter) domain.push(['state', 'in', ['sale', 'done']]);
    if (dateFromMatch) domain.push(['date_order', '>=', dateFromMatch[1]]);
    if (dateToMatch) domain.push(['date_order', '<', dateToMatch[1]]);

    const rows = await odooCall(uid, 'sale.order', 'search_read', [domain],
      { fields: ['name', 'state', 'date_order', 'user_id', 'amount_untaxed', 'margin', 'team_id', 'partner_id'], limit: 2000 });

    return rows.map(r => ({
      id: r.id,
      name: r.name || '',
      state: r.state || '',
      date_order: r.date_order || '',
      user_id_label: Array.isArray(r.user_id) ? r.user_id[1] : '',
      amount_untaxed: r.amount_untaxed || 0,
      margin: r.margin || 0,
      team_id_label: Array.isArray(r.team_id) ? r.team_id[1] : '',
      partner_id_label: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
    }));
  }

  // crm_lead query
  if (sql.includes('crm_lead')) {
    const dateFromMatch = sql.match(/\[create_date\] >= '([^']+)'/);
    const dateToMatch = sql.match(/\[create_date\] < '([^']+)'/);
    const domain = [];
    if (dateFromMatch) domain.push(['create_date', '>=', dateFromMatch[1]]);
    if (dateToMatch) domain.push(['create_date', '<', dateToMatch[1]]);

    const rows = await odooCall(uid, 'crm.lead', 'search_read', [domain],
      { fields: ['name', 'stage_id', 'create_date', 'user_id', 'probability'], limit: 500 });

    return rows.map(r => ({
      id: r.id,
      name: r.name || '',
      stage_id_label: Array.isArray(r.stage_id) ? r.stage_id[1] : '',
      create_date: r.create_date || '',
      user_id_label: Array.isArray(r.user_id) ? r.user_id[1] : '',
      probability: r.probability || 0,
    }));
  }

  // mail_activity (outstanding activities)
  if (sql.includes('mail_activity')) {
    const dateMatch = sql.match(/\[date_deadline\] <= '([^']+)'/);
    const domain = [
      ['user_id.name', 'in', ['Ralph Lewis','Roger Lewis','Daniel Wilkin','Amy Hope','Kayleigh Rankin']],
    ];
    if (dateMatch) domain.push(['date_deadline', '<=', dateMatch[1]]);

    const rows = await odooCall(uid, 'mail.activity', 'search_read', [domain],
      { fields: ['user_id', 'activity_type_id'], limit: 1000 });

    return rows.map(r => ({
      user_id_label: Array.isArray(r.user_id) ? r.user_id[1] : '',
      activity_type_id_label: Array.isArray(r.activity_type_id) ? r.activity_type_id[1] : '',
    }));
  }

  // account_move (invoices) - also handles JOIN with sale_order for GP
  if (sql.includes('account_move') && !sql.includes('pos_order')) {
    const dateFromMatch = sql.match(/\[invoice_date\] >= '([^']+)'/);
    const dateToMatch = sql.match(/\[invoice_date\] < '([^']+)'/);

    // Check if this is the GP query (JOIN with sale_order for margin)
    const isGPQuery = sql.includes('[margin]') || sql.includes('sale_order].[margin]');

    const invDomain = [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
    ];
    if (dateFromMatch) invDomain.push(['invoice_date', '>=', dateFromMatch[1]]);
    if (dateToMatch) invDomain.push(['invoice_date', '<', dateToMatch[1]]);

    const invoices = await odooCall(uid, 'account.move', 'search_read', [invDomain],
      { fields: ['invoice_origin', 'amount_untaxed', 'partner_id', 'move_type'], limit: 2000 });

    if (isGPQuery) {
      // Get sale order names from invoice origins, then fetch margins
      const origins = [...new Set(invoices.map(i => i.invoice_origin).filter(o => o && o.trim()))];
      if (origins.length === 0) return [];
      const soDomain = [['name', 'in', origins]];
      const soRows = await odooCall(uid, 'sale.order', 'search_read', [soDomain],
        { fields: ['name', 'margin'], limit: 2000 });
      return soRows.map(r => ({
        id: r.id,
        margin: r.margin || 0,
      }));
    }

    return invoices.map(r => ({
      move_type: r.move_type || '',
      amount_untaxed: r.amount_untaxed || 0,
      invoice_origin: r.invoice_origin || '',
      partner_id_label: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
    }));
  }

  // pos_order
  if (sql.includes('pos_order')) {
    const dateFromMatch = sql.match(/\[date_order\] >= '([^']+)'/);
    const dateToMatch = sql.match(/\[date_order\] < '([^']+)'/);
    const domain = [
      ['crm_team_id.name', 'in', ['Timber', 'Commercial']],
      ['state', '=', 'invoiced'],
    ];
    if (dateFromMatch) domain.push(['date_order', '>=', dateFromMatch[1]]);
    if (dateToMatch) domain.push(['date_order', '<', dateToMatch[1]]);

    const rows = await odooCall(uid, 'pos.order', 'search_read', [domain],
      { fields: ['amount_total', 'amount_tax', 'partner_id', 'crm_team_id'], limit: 200 });

    return rows.map(r => ({
      amount_total: r.amount_total || 0,
      amount_tax: r.amount_tax || 0,
      partner_id_label: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
      crm_team_id_label: Array.isArray(r.crm_team_id) ? r.crm_team_id[1] : '',
    }));
  }

  return [];
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const { sql } = JSON.parse(event.body);
    const uid = await getUid();
    const rows = await handleSql(sql, uid);
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
