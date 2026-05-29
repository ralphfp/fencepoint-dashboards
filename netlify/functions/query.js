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

    // Step 1: authenticate
    const authRes = await fetch(ODOO_URL + '/web/session/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
      })
    });

    const authData = await authRes.json();
    const uid = authData.result && authData.result.uid;
    if (!uid) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Odoo auth failed', detail: authData }) };
    }

    const cookie = authRes.headers.get('set-cookie') || '';

    // Step 2: call model method
    const rpcRes = await fetch(ODOO_URL + '/web/dataset/call_kw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 2,
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
