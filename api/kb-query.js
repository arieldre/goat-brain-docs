// Vercel serverless — KB semantic search via Pinecone claude-memory namespace
// POST /api/kb-query  { query, game?, limit?, password }
// Env vars: PINECONE_API_KEY, PINECONE_HOST, KB_PASSWORD

const CONTROL_HOST = 'api.pinecone.io';
const NAMESPACE = 'claude-memory';

function pcHeaders(apiKey) {
  return {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
    'X-Pinecone-API-Version': '2025-04',
  };
}

async function embedQuery(apiKey, text) {
  const res = await fetch(`https://${CONTROL_HOST}/embed`, {
    method: 'POST',
    headers: pcHeaders(apiKey),
    body: JSON.stringify({
      model: 'multilingual-e5-large',
      inputs: [{ text }],
      parameters: { input_type: 'query' },
    }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const values = data.data?.[0]?.values;
  if (!values?.length) throw new Error('embed returned no values');
  return values;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { query, game, limit = 8, password } = req.body || {};

  const requiredPassword = process.env.KB_PASSWORD;
  if (requiredPassword && password !== requiredPassword) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!query?.trim()) return res.status(400).json({ error: 'query required' });

  const apiKey = process.env.PINECONE_API_KEY;
  const indexHost = process.env.PINECONE_HOST;
  if (!apiKey || !indexHost) {
    return res.status(500).json({ error: 'Pinecone not configured on this deployment' });
  }

  try {
    const vector = await embedQuery(apiKey, query.trim());

    const qRes = await fetch(`https://${indexHost}/query`, {
      method: 'POST',
      headers: pcHeaders(apiKey),
      body: JSON.stringify({
        vector,
        topK: Math.min(limit * 3, 40),
        namespace: NAMESPACE,
        includeMetadata: true,
      }),
    });
    if (!qRes.ok) throw new Error(`query ${qRes.status}: ${(await qRes.text()).slice(0, 120)}`);
    const data = await qRes.json();

    let matches = data.matches || [];

    if (game) {
      const g = game.toLowerCase();
      matches = matches.filter(m => {
        const src = (m.metadata?.source || '').toLowerCase();
        return src.includes(`_${g}_`) || src.includes(`_${g}.`) || !/(_(uh|inv|sh)[_\.])/.test(src);
      });
    }

    matches = matches.slice(0, limit);

    return res.json({
      query,
      count: matches.length,
      results: matches.map(m => ({
        source: (m.metadata?.source || 'unknown').replace(/\.md$/, ''),
        score: Math.round((m.score || 0) * 100),
        text: (m.metadata?.text || '').slice(0, 600),
        timestamp: m.metadata?.timestamp,
      })),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
