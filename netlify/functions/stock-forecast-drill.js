// stock-forecast-drill.js — on-demand drill queries for stock forecast modals

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { type, pidList, soNames, soIdList } = JSON.parse(event.body || '{}');

  const MCP_SERVER = { type: 'url', url: 'https://mcp.cloud.cdata.com/mcp', name: 'cdata-odoo' };

  const runQuery = async (sql) => {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: 'Run the SQL query via CData and return ONLY a raw JSON array. No explanation, no markdown, no backticks. Each row as an object. If no data return [].',
        messages: [{ role: 'user', content: `Query: ${sql}\n\nReturn ONLY: [{col:val,...},...]` }],
        mcp_servers: [MCP_SERVER],
      }),
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s === -1) return [];
    try { return JSON.parse(text.slice(s, e+1)); } catch { return []; }
  };

  try {
    if (type === 'pipeline_orders') {
      // Fetch SO lines + headers for pipeline modal
      const [soLines, oppIds] = await Promise.all([
        runQuery(`SELECT [order_id], [product_id], [product_uom_qty] FROM [User].[Odoo].[sale_order_line] WHERE [product_id] IN (${pidList}) AND [product_uom_qty] > 0 LIMIT 500`),
        Promise.resolve([]),
      ]);
      if (!soLines.length) return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines: [], soHeaders: [], oppData: [] }) };

      const ids = [...new Set(soLines.map(l => l.order_id || l.ORDER_ID))].join(',');
      const [soHeaders, pickings] = await Promise.all([
        runQuery(`SELECT [id], [name], [state], [partner_id_label], [commitment_date], [opportunity_id] FROM [User].[Odoo].[sale_order] WHERE [id] IN (${ids}) AND [state] IN ('draft','sent') LIMIT 500`),
        runQuery(`SELECT [id], [scheduled_date], [origin] FROM [User].[Odoo].[stock_picking] WHERE [picking_type_id_label] LIKE '%Despatch%' AND [state] NOT IN ('done','cancel') AND [origin] IS NOT NULL LIMIT 2000`),
      ]);
      const oppIdList = [...new Set(soHeaders.map(s => s.opportunity_id).filter(Boolean))].join(',');
      let oppData = [];
      if (oppIdList) {
        oppData = await runQuery(`SELECT [id], [probability], [date_deadline] FROM [User].[Odoo].[crm_lead] WHERE [id] IN (${oppIdList}) LIMIT 200`);
      }
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines, soHeaders, pickings, oppData }) };
    }

    if (type === 'confirmed_orders') {
      const soLines = await runQuery(
        `SELECT [order_id], [product_id], [product_uom_qty], [qty_delivered] FROM [User].[Odoo].[sale_order_line] WHERE [product_id] IN (${pidList}) AND [product_uom_qty] > [qty_delivered] LIMIT 500`
      );
      if (!soLines.length) return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines: [], soHeaders: [], pickings: [] }) };
      const ids = [...new Set(soLines.map(l => l.order_id))].join(',');
      const [soHeaders, pickings] = await Promise.all([
        runQuery(`SELECT [id], [name], [partner_id_label], [commitment_date], [state] FROM [User].[Odoo].[sale_order] WHERE [id] IN (${ids}) AND [state] = 'sale' LIMIT 500`),
        runQuery(`SELECT [id], [scheduled_date], [origin] FROM [User].[Odoo].[stock_picking] WHERE [picking_type_id_label] LIKE '%Despatch%' AND [state] NOT IN ('done','cancel') AND [origin] IS NOT NULL LIMIT 2000`),
      ]);
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines, soHeaders, pickings }) };
    }

    if (type === 'phasing_nonkit') {
      const [pickings, moves] = await Promise.all([
        runQuery(`SELECT [id], [name], [scheduled_date], [state], [origin], [partner_id_label] FROM [User].[Odoo].[stock_picking] WHERE [picking_type_id_label] LIKE '%Despatch%' AND [state] NOT IN ('done','cancel') LIMIT 2000`),
        runQuery(`SELECT [picking_id], [product_id], [product_uom_qty], [state] FROM [User].[Odoo].[stock_move] WHERE [product_id] IN (${pidList}) AND [state] NOT IN ('done','cancel','draft') LIMIT 2000`),
      ]);
      let soIdData = [];
      if (soNames) {
        const names = soNames.map(n => `'${n}'`).join(',');
        soIdData = await runQuery(`SELECT [id], [name] FROM [User].[Odoo].[sale_order] WHERE [name] IN (${names}) LIMIT 500`);
      }
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ pickings, moves, soIdData }) };
    }

    if (type === 'phasing_kit') {
      const soLines = await runQuery(
        `SELECT [order_id], [product_id], [product_uom_qty], [qty_delivered] FROM [User].[Odoo].[sale_order_line] WHERE [product_id] IN (${pidList}) AND [product_uom_qty] > [qty_delivered] LIMIT 500`
      );
      if (!soLines.length) return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines: [], soHeaders: [], pickings: [] }) };
      const ids = [...new Set(soLines.map(l => l.order_id))].join(',');
      const [soHeaders, pickings] = await Promise.all([
        runQuery(`SELECT [id], [name], [partner_id_label], [commitment_date], [state] FROM [User].[Odoo].[sale_order] WHERE [id] IN (${ids}) AND [state] = 'sale' LIMIT 500`),
        runQuery(`SELECT [id], [scheduled_date], [origin] FROM [User].[Odoo].[stock_picking] WHERE [picking_type_id_label] LIKE '%Despatch%' AND [state] NOT IN ('done','cancel') AND [origin] IS NOT NULL LIMIT 2000`),
      ]);
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ soLines, soHeaders, pickings }) };
    }

    if (type === 'bare_posts') {
      const inList = pidList; // already formatted as 'CODE1','CODE2',...
      const rows = await runQuery(`SELECT [id], [default_code] FROM [User].[Odoo].[product_product] WHERE [default_code] IN (${inList}) LIMIT 500`);
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rows }) };
    }

    if (type === 'comp_codes') {
      const rows = await runQuery(`SELECT [id], [default_code] FROM [User].[Odoo].[product_product] WHERE [id] IN (${pidList}) LIMIT 200`);
      return { statusCode: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({ rows }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown drill type: ' + type }) };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
