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

    // Step 1: authenticate with API key as password
    const authRes = await fetch(ODOO_URL + '/web/session/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 1,
        params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_API_KEY }
      })
    });

    const authText = await authRes.text();
    let authData;
    try { authData = JSON.parse(authText); } catch(e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Auth parse failed', raw: authText.slice(0, 500) }) };
    }

    if (authData.error) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Odoo auth failed', detail: authData.error }) };
    }

    const uid = authData.result && authData.result.uid;
    if (!uid) {
      return { statusCode: 502, body: JSON.stringify({ error: 'Odoo auth failed', detail: authData.result }) };
    }

    // Extract session cookie
    const setCookie = authRes.headers.get('set-cookie') || '';
    const sessionMatch = setCookie.match(/session_id=([^;]+)/);
    const sessionId = sessionMatch ? sessionMatch[1] : '';

    // Step 2: call model method using session
    const rpcRes = await fetch(ODOO_URL + '/web/dataset/call_kw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': 'session_id=' + sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call', id: 2,
        params: { model, method, args: args || [], kwargs: kwargs || {} }
      })
    });

    const rpcText = await rpcRes.text();
    let rpcData;
    try { rpcData = JSON.parse(rpcText); } catch(e) {
      return { statusCode: 502, body: JSON.stringify({ error: 'RPC parse failed', raw: rpcText.slice(0, 500) }) };
    }

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
