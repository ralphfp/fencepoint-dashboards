// stock-forecast-query.js — Netlify function for Stock Forecasting dashboard
// Runs all main load queries via CData MCP Claude API

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const LOC_IDS = '8,11,23,24,25,26,27,28,29,30,31,32,33,34,35,36';
  const today = new Date();
  const threeMonthsAgo = new Date(Date.now() - 91 * 86400000).toISOString().slice(0,10);
  const oneMonthAgo    = new Date(Date.now() - 31 * 86400000).toISOString().slice(0,10);
  const histStart      = new Date(Date.now() - 182 * 86400000).toISOString().slice(0,10);
  const yearStart      = today.getFullYear() + '-01-01';

  const queries = {
    // Step 0a: Stocked product template IDs (FP_Odoo connection)
    stockedTmpls: `SELECT [id] FROM [FP_Odoo].[Odoo].[product_template] WHERE [x_studio_stocked_item] = 1 AND [active] = 1 LIMIT 2000`,

    // Step 0b: Supplier lead times + cost
    suppliers: `SELECT [product_tmpl_id], MIN([delay]) as lead_days, MIN([price]) as unit_cost FROM [User].[Odoo].[product_supplierinfo] WHERE [delay] > 0 GROUP BY [product_tmpl_id] LIMIT 5000`,

    // Step 1: Stock levels by location
    stock: `SELECT [product_id], SUM([quantity]) as current_stock, SUM([reserved_quantity]) as reserved_qty FROM [User].[Odoo].[stock_quant] WHERE [location_id] IN (${LOC_IDS}) GROUP BY [product_id] LIMIT 3000`,

    // Step 2a: Kit BoM headers (phantom type)
    bomHeaders: `SELECT [id], [product_tmpl_id], [product_qty] FROM [User].[Odoo].[mrp_bom] WHERE [type] = 'phantom' LIMIT 500`,

    // Step 2b: Kit BoM lines
    bomLines: `SELECT [bom_id], [product_id], [product_qty] FROM [User].[Odoo].[mrp_bom_line] LIMIT 3000`,

    // Step 3a: CRM-weighted pipeline demand (draft/sent quotes)
    pipelineDemand: `SELECT sol.[product_id],
       SUM(sol.[product_uom_qty] * COALESCE(cl.[probability], 20) / 100.0) as weighted_qty,
       SUM(sol.[product_uom_qty]) as nominal_qty
     FROM [User].[Odoo].[sale_order_line] sol
     INNER JOIN [User].[Odoo].[sale_order] so ON sol.[order_id] = so.[id]
     LEFT JOIN [User].[Odoo].[crm_lead] cl ON so.[opportunity_id] = cl.[id]
     WHERE so.[state] IN ('draft', 'sent')
       AND (cl.[id] IS NULL OR cl.[active] = 1)
     GROUP BY sol.[product_id]
     LIMIT 1000`,

    // Step 3b: Confirmed undelivered demand
    confirmedDemand: `SELECT sol.[product_id], SUM(sol.[product_uom_qty] - sol.[qty_delivered]) as confirmed_qty
     FROM [User].[Odoo].[sale_order_line] sol
     INNER JOIN [User].[Odoo].[sale_order] so ON sol.[order_id] = so.[id]
     WHERE so.[state] = 'sale'
       AND sol.[product_uom_qty] > sol.[qty_delivered]
     GROUP BY sol.[product_id]
     LIMIT 1000`,

    // Step 3c: Pipeline lines with close dates for time-phased urgency
    pipelineLines: `SELECT sol.[product_id], sol.[product_uom_qty],
       COALESCE(cl.[probability], 20) as probability,
       cl.[date_deadline] as close_date
     FROM [User].[Odoo].[sale_order_line] sol
     INNER JOIN [User].[Odoo].[sale_order] so ON sol.[order_id] = so.[id]
     LEFT JOIN [User].[Odoo].[crm_lead] cl ON so.[opportunity_id] = cl.[id]
     WHERE so.[state] IN ('draft', 'sent')
       AND (cl.[id] IS NULL OR cl.[active] = 1)
     LIMIT 3000`,

    // Step 3d: Invoice headers for run rate (last 26 weeks)
    invoiceHeaders: `SELECT [id], [invoice_date] FROM [User].[Odoo].[account_move] WHERE [move_type] = 'out_invoice' AND [state] = 'posted' AND [invoice_date] >= '${histStart}' LIMIT 3000`,

    // Step 3e: Invoice lines for run rate (last 26 weeks)
    invoiceLines: `SELECT [move_id], [product_id], SUM([quantity]) as qty_sold FROM [User].[Odoo].[account_move_line] WHERE [quantity] > 0 AND [product_id] IS NOT NULL AND [move_name] LIKE 'UK1I/%' LIMIT 5000`,

    // Step 4a: Confirmed PO headers
    poHeaders: `SELECT [id], [name], [partner_id_label], [date_order] FROM [User].[Odoo].[purchase_order] WHERE [state] IN ('purchase', 'done') LIMIT 5000`,

    // Step 4b: Outstanding PO lines (not fully received)
    poLines: `SELECT [order_id], [product_id], [product_qty], [qty_received], [date_planned], [price_unit] FROM [User].[Odoo].[purchase_order_line] WHERE [qty_received] < [product_qty] LIMIT 2000`,

    // Step 4c: 3-month run rate
    runRate: `SELECT [product_id], SUM([quantity]) / 3.0 as monthly_rate FROM [User].[Odoo].[account_move_line] WHERE [move_name] LIKE 'UK1I/%' AND [account_id_label] LIKE '%Sales%' AND [credit] > 0 AND [date] >= '${threeMonthsAgo}' GROUP BY [product_id] LIMIT 2000`,

    // Step 4d: Last month rate
    lastMonthRate: `SELECT [product_id], SUM([quantity]) as last_month_qty FROM [User].[Odoo].[account_move_line] WHERE [move_name] LIKE 'UK1I/%' AND [account_id_label] LIKE '%Sales%' AND [credit] > 0 AND [date] >= '${oneMonthAgo}' GROUP BY [product_id] LIMIT 2000`,
  };

  try {
    // Run all queries via Claude API with CData MCP
    const MCP_SERVER = { type: 'url', url: 'https://mcp.cloud.cdata.com/mcp', name: 'cdata-odoo' };

    const runQuery = async (sql) => {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          system: 'Run the SQL query via CData and return ONLY a raw JSON array starting with [ and ending with ]. No explanation, no markdown, no backticks. Each row as an object with column names as keys. If no data return [].',
          messages: [{ role: 'user', content: `Query: ${sql}\n\nReturn ONLY: [{col:val,...},...]` }],
          mcp_servers: [MCP_SERVER],
        }),
      });
      if (!resp.ok) throw new Error(`API error ${resp.status}`);
      const data = await resp.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s === -1) return [];
      try { return JSON.parse(text.slice(s, e+1)); } catch { return []; }
    };

    // Run independent queries in parallel groups to stay within timeout
    // Group 1: Products/suppliers/stock/BoMs (no dependencies)
    const [stockedTmpls, suppliers, stock, bomHeaders, bomLines] = await Promise.all([
      runQuery(queries.stockedTmpls),
      runQuery(queries.suppliers),
      runQuery(queries.stock),
      runQuery(queries.bomHeaders),
      runQuery(queries.bomLines),
    ]);

    // Group 2: Demand + invoice data (independent of group 1)
    const [pipelineDemand, confirmedDemand, pipelineLines, invoiceHeaders, poHeaders, runRate, lastMonthRate] = await Promise.all([
      runQuery(queries.pipelineDemand),
      runQuery(queries.confirmedDemand),
      runQuery(queries.pipelineLines),
      runQuery(queries.invoiceHeaders),
      runQuery(queries.poHeaders),
      runQuery(queries.runRate),
      runQuery(queries.lastMonthRate),
    ]);

    // Group 3: Invoice lines + PO lines (depend on headers from group 2)
    const [invoiceLines, poLines] = await Promise.all([
      runQuery(queries.invoiceLines),
      runQuery(queries.poLines),
    ]);

    // Fetch products for stocked templates
    const stockedIds = stockedTmpls.map(r => r.id || r.ID).filter(Boolean);
    let products = [];
    if (stockedIds.length > 0) {
      // Batch in 500s
      for (let i = 0; i < stockedIds.length; i += 500) {
        const chunk = stockedIds.slice(i, i+500).join(',');
        const batch = await runQuery(
          `SELECT [id], [product_tmpl_id], [default_code], [product_tmpl_id_label] FROM [User].[Odoo].[product_product] WHERE [active] = 1 AND [product_tmpl_id] IN (${chunk}) LIMIT 3000`
        );
        products = products.concat(batch);
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        products, suppliers, stock, bomHeaders, bomLines,
        pipelineDemand, confirmedDemand, pipelineLines,
        invoiceHeaders, invoiceLines,
        poHeaders, poLines, runRate, lastMonthRate,
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
