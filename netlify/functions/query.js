exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    const { model, method, args, kwargs } = body;

    const ODOO_URL     = process.env.ODOO_URL;
    const ODOO_DB      = process.env.ODOO_DB;
    const ODOO_USER    = process.env.ODOO_USER;
    const ODOO_API_KEY = process.env.ODOO_API_KEY;

    // Use Odoo JSON-RPC with API key via basic auth
    const rpcRes = await fetch(ODOO_URL + '/web/dataset/call_kw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(ODOO_USER + ':' + ODOO_API_KEY).toString('base64')
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { model, method, args: args || [], kwargs: kwargs || {} }
      })
    });

    const rpcData = await rpcRes.json();

    if (rpcData.error) {
      return { statusCode: 502, body: JSON.stringify({ error: rpcData.error }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: rpcData.result })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
