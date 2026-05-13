// BP-100: standard dense index — /embed then /vectors/upsert (NOT /records/upsert)
// BP-101: input_type is asymmetric — 'passage' for indexing, 'query' for retrieval

const EMBED_URL   = 'https://api.pinecone.io/embed';
const NAMESPACE   = 'marketing-creatives';
const EMBED_MODEL = 'multilingual-e5-large';
const VECTOR_DIM  = 1024;

const key    = () => process.env.PINECONE_API_KEY;
const host   = () => process.env.PINECONE_HOST;
const pcHdrs = () => ({ 'Api-Key': key(), 'Content-Type': 'application/json', 'X-Pinecone-API-Version': '2024-10' });

export async function embedTexts(texts, inputType = 'passage') {
  // BP-101: passage for upsert, query for retrieval — never swap
  const res = await fetch(EMBED_URL, {
    method: 'POST',
    headers: pcHdrs(),
    body: JSON.stringify({
      model: EMBED_MODEL,
      inputs: texts.map(text => ({ text })),
      parameters: { input_type: inputType }, // BP-101 — must not change
    }),
  });
  if (!res.ok) throw new Error(`Pinecone embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map(d => d.values);
}

export async function upsertVectors(vectors) {
  // BP-100: /vectors/upsert — NOT /records/upsert (that's integrated-embedding only)
  const res = await fetch(`https://${host()}/vectors/upsert`, {
    method: 'POST',
    headers: pcHdrs(),
    body: JSON.stringify({ vectors, namespace: NAMESPACE }),
  });
  if (!res.ok) throw new Error(`Pinecone upsert failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function queryVectors(vector, filter = {}, topK = 10) {
  const res = await fetch(`https://${host()}/query`, {
    method: 'POST',
    headers: pcHdrs(),
    body: JSON.stringify({
      vector,
      filter: Object.keys(filter).length ? filter : undefined,
      topK,
      namespace: NAMESPACE,
      includeMetadata: true,
    }),
  });
  if (!res.ok) throw new Error(`Pinecone query failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function fetchVectors(ids) {
  const qs  = ids.map(id => `ids=${encodeURIComponent(id)}`).join('&');
  const res = await fetch(`https://${host()}/vectors/fetch?${qs}&namespace=${NAMESPACE}`, {
    headers: pcHdrs(),
  });
  if (!res.ok) throw new Error(`Pinecone fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export async function updateMetadata(id, metadata) {
  const res = await fetch(`https://${host()}/vectors/update`, {
    method: 'POST',
    headers: pcHdrs(),
    body: JSON.stringify({ id, setMetadata: metadata, namespace: NAMESPACE }),
  });
  if (!res.ok) throw new Error(`Pinecone update failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

export { NAMESPACE, VECTOR_DIM };
