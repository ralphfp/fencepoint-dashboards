exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { query } = JSON.parse(event.body);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-1.0"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: 'You are a data query assistant. When given a SQL query, execute it using the queryData tool and return ONLY a raw JSON object with this exact structure: {"results":[{"rows":[[val1,val2,...],...]}]}. No explanation, no markdown, no code fences.',
      messages: [{ role: "user", content: "Execute this SQL and return results as JSON: " + query }],
      mcp_servers: [{
        type: "url",
        url: "https://mcp.cloud.cdata.com/mcp",
        name: "cdata-mcp"
      }]
    })
  });

  const data = await response.json();
  const textBlock = data.content.find(b => b.type === "text");
  if (!textBlock) throw new Error("No text response from API");
  const cleaned = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: cleaned
  };
};
