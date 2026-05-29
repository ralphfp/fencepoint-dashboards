const https = require('https');

function xmlrpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const xmlBody = `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${params.map(p => `<param><value>${toXml(p)}</value></param>`).join('')}</params>
</methodCall>`;

    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xmlBody) }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
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
    const members = Object.entries(val).map(([k,v]) => `<member><name>${k}</name><value>${toXml(v)}</value></member>`).join('');
    return `<struct>${members}</struct>`;
  }
  return `<string>${val}</string>`;
}

function parseXmlrpc(xml) {
  // Extract all string/int/double/boolean/array/struct values
  const fault = xml.match(/<fault>/);
  if (fault) {
    const msg = xml.match(/<name>faultString<\/name>\s*<value><string>(.*?)<\/string>/s);
    throw new Error(msg ? msg[1] : 'XML-RPC fault');
  }
  // Simple extraction of the response data
  return xml;
}

function extractInts(xml) {
  const matches = [...xml.matchAll(/<int>(.*?)<\/int>|<i4>(.*?)<\/i4>/g)];
  return matches.map(m => parseInt(m[1] || m[2]));
}

function extractArrayData(xml) {
  // Parse the XML-RPC array response into JS objects
  // For search_read we need to parse struct arrays
  const results = [];
  const itemRegex = /<struct>([\s\S]*?)<\/struct>/g;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const struct = {};
    const memberRegex = /<member>\s*<name>(.*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
    let memberMatch;
    while ((memberMatch = memberRegex.exec(itemMatch[1])) !== null) {
      const key = memberMatch[1];
      const valXml = memberMatch[2].trim();
      if (valXml.startsWith('<int>') || valXml.startsWith('<i4>')) {
        struct[key] = parseInt(valXml.replace(/<\/?(?:int|i4)>/g, ''));
      } else if (valXml.startsWith('<double>')) {
        struct[key] = parseFloat(valXml.replace(/<\/?double>/g, ''));
      } else if (valXml.startsWith('<boolean>')) {
        struct[key] = valXml.includes('>1<') ? true : false;
      } else if (valXml.startsWith('<string>')) {
        struct[key] = valXml.replace(/<\/?string>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      } else if (valXml.startsWith('<array>')) {
        // array value - extract strings/ints
        const arrVals = [];
        const avRegex = /<value>([\s\S]*?)<\/value>/g;
        let avMatch;
        while ((avMatch = avRegex.exec(valXml)) !== null) {
          const av = avMatch[1].trim();
          if (av.startsWith('<int>') || av.startsWith('<i4>')) arrVals.push(parseInt(av.replace(/<\/?(?:int|i4)>/g,'')));
          else if (av.startsWith('<string>')) arrVals.push(av.replace(/<\/?string>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
          else if (av.startsWith('<boolean>')) arrVals.push(av.includes('>1<'));
          else if (av.startsWith('<double>')) arrVals.push(parseFloat(av.replace(/<\/?double>/g,'')));
        }
        struct[key] = arrVals;
      } else {
        struct[key] = valXml.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
      }
    }
    results.push(struct);
  }
  return results;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { model, method, args, kwargs } = JSON.parse(event.body);
    const ODOO_URL     = process.env.ODOO_URL;
    const ODOO_DB      = process.env.ODOO_DB;
    const ODOO_USER    = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // Step 1: authenticate via XML-RPC
    const authXml = await xmlrpc(ODOO_URL + '/xmlrpc/2/common', 'authenticate',
      [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);

    const uidMatches = extractInts(authXml);
    const uid = uidMatches[0];
    if (!uid || uid <= 0) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Auth failed', raw: authXml.slice(0, 300) }) };
    }

    // Step 2: call model method via XML-RPC
    const kwargsWithFields = { ...(kwargs || {}) };
    const callArgs = [ODOO_DB, uid, ODOO_API_KEY, model, method, args || [], kwargsWithFields];
    const resultXml = await xmlrpc(ODOO_URL + '/xmlrpc/2/object', 'execute_kw', callArgs);

    if (resultXml.includes('<fault>')) {
      const msg = resultXml.match(/<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/);
      return { statusCode: 502, body: JSON.stringify({ error: msg ? msg[1].slice(0,300) : 'XML-RPC fault' }) };
    }

    const result = extractArrayData(resultXml);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
