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

function extractVal(valXml) {
  const v = valXml.trim();
  if (v.startsWith('<int>') || v.startsWith('<i4>')) return parseInt(v.replace(/<\/?(?:int|i4)>/g,''));
  if (v.startsWith('<double>')) return parseFloat(v.replace(/<\/?double>/g,''));
  if (v.startsWith('<boolean>')) return v.includes('>1<');
  if (v.startsWith('<string>')) return v.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if (v.startsWith('<array>')) {
    const arr = []; const r = /<value>([\s\S]*?)<\/value>/g; let m;
    while ((m = r.exec(v)) !== null) arr.push(extractVal(m[1]));
    return arr;
  }
  if (v.startsWith('<struct>')) {
    const obj = {}; const r = /<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g; let m;
    while ((m = r.exec(v)) !== null) obj[m[1]] = extractVal(m[2]);
    return obj;
  }
  return v.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
}

function extractArrayData(xml) {
  const results = [];
  const itemRegex = /<struct>([\s\S]*?)<\/struct>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const struct = {};
    const memberRegex = /<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let m;
    while ((m = memberRegex.exec(itemMatch[1])) !== null) struct[m[1]] = extractVal(m[2]);
    results.push(struct);
  }
  return results;
}

async function getUid() {
  const xml = await xmlrpc(process.env.ODOO_URL + '/xmlrpc/2/common', 'authenticate',
    [process.env.ODOO_DB, process.env.ODOO_USER, process.env.ODOO_API_KEY, {}]);
  const uid = extractInts(xml)[0];
  if (!uid) throw new Error('Odoo auth failed');
  return uid;
}

async function odooCall(uid, model, method, args, kwargs) {
  const xml = await xmlrpc(process.env.ODOO_URL + '/xmlrpc/2/object', 'execute_kw',
    [process.env.ODOO_DB, uid, process.env.ODOO_API_KEY, model, method, args, kwargs || {}]);
  if (xml.includes('<fault>')) {
    const msg = xml.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? msg[1].slice(0,300) : 'XML-RPC fault');
  }
  return extractArrayData(xml);
}

function normaliseLead(r) {
  return {
    id: r.id,
    name: r.name || '',
    create_date: r.create_date || '',
    date_closed: r.date_closed || '',
    date_deadline: r.date_deadline || '',
    expected_revenue: r.expected_revenue || 0,
    won_status: r.probability === 100 ? 'won' : (r.active === false ? 'lost' : 'pending'),
    lost_reason_id_label: (Array.isArray(r.lost_reason_id) ? r.lost_reason_id[1] : '') || '',
    stage_id_label: Array.isArray(r.stage_id) ? r.stage_id[1] : '',
    partner_id_label: Array.isArray(r.partner_id) ? r.partner_id[1] : '',
    user_id_label: Array.isArray(r.user_id) ? r.user_id[1] : '',
    source_id_label: Array.isArray(r.source_id) ? r.source_id[1] : '',
  };
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const uid = await getUid();
    const year = new Date().getFullYear();
    const yearStart = year + '-01-01 00:00:00';
    const yearEnd   = (year + 1) + '-01-01 00:00:00';
    const FIELDS = ['id','name','create_date','date_closed','date_deadline','expected_revenue',
                    'probability','active','lost_reason_id','stage_id','partner_id','user_id','source_id'];

    const PIPELINE_STAGES = ['Quote Raised','Proposal Sent','In Running','Final Negotiation','Committed to Order'];

    const [activeLeads, pipelineLeads, lostLeads, wonLeads, soRows] = await Promise.all([
      // Q1: active leads created in 2026
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',true],['create_date','>=',yearStart],['create_date','<',yearEnd]]],
        { fields: FIELDS, limit: 500, order: 'create_date asc' }),

      // Q2: all active pipeline-stage deals
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',true],['stage_id.name','in', PIPELINE_STAGES]]],
        { fields: FIELDS, limit: 500 }),

      // Q3: lost/archived leads created in 2026
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',false],['create_date','>=',yearStart],['create_date','<',yearEnd]]],
        { fields: FIELDS, limit: 500, order: 'create_date asc' }),

      // Q4: won leads closed in 2026
      odooCall(uid, 'crm.lead', 'search_read',
        [[['active','=',true],['probability','=',100],['date_closed','>=',yearStart.slice(0,10)],['date_closed','<',yearEnd.slice(0,10)]]],
        { fields: FIELDS, limit: 500 }),

      // Q5: GP from sale orders linked to CRM opportunities
      odooCall(uid, 'sale.order', 'search_read',
        [[['opportunity_id','!=',false],['state','in',['sale','done']]]],
        { fields: ['opportunity_id','margin','amount_untaxed'], limit: 2000 }),
    ]);

    // Build GP map
    const gpMap = {};
    soRows.forEach(r => {
      const oid = Array.isArray(r.opportunity_id) ? r.opportunity_id[0] : r.opportunity_id;
      if (!oid) return;
      const key = String(oid);
      if (!gpMap[key]) gpMap[key] = { gp: 0, soRev: 0 };
      gpMap[key].gp += r.margin || 0;
      gpMap[key].soRev += r.amount_untaxed || 0;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activeLeads: activeLeads.map(normaliseLead),
        pipelineLeads: pipelineLeads.map(normaliseLead),
        lostLeads: lostLeads.map(normaliseLead),
        wonLeads: wonLeads.map(normaliseLead),
        gpMap,
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
