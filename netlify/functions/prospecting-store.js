// Netlify function: shared read/write store for the Salesdesk dashboard's
// "Prospecting" cells, backed by Netlify Blobs — so every rep's browser reads
// and writes the same numbers instead of each keeping its own in-memory copy.
//
// GET  /.netlify/functions/prospecting-store?date=YYYY-MM-DD
//      -> { "Ralph Lewis": { total, connected, updatedAt }, "Roger Lewis": {...} }
//      (missing reps simply aren't in the object — the dashboard treats that as 0/0)
//
// POST /.netlify/functions/prospecting-store?date=YYYY-MM-DD
//      body: { rep: "Ralph Lewis", total: 4, connected: 2 }
//      -> merges just that one rep's entry into the day's record and returns
//         the full updated record for that date. Only the named rep's field
//         is touched, so two reps saving around the same time never clobber
//         each other's numbers.

const { getStore } = require('@netlify/blobs');

function todayKeyUTC() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

exports.handler = async function (event) {
  try {
    const store = getStore('prospecting');
    const date = (event.queryStringParameters && event.queryStringParameters.date) || todayKeyUTC();

    if (event.httpMethod === 'GET') {
      const data = (await store.get(date, { type: 'json' })) || {};
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const rep = body.rep;
      if (!rep || typeof rep !== 'string') {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing or invalid "rep"' }) };
      }
      const total = parseInt(body.total, 10) || 0;
      const connected = parseInt(body.connected, 10) || 0;

      const existing = (await store.get(date, { type: 'json' })) || {};
      existing[rep] = {
        total: total,
        connected: connected,
        updatedAt: new Date().toISOString(),
      };
      await store.setJSON(date, existing);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existing),
      };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
