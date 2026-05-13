#!/usr/bin/env node
// Stage 5b — Integration smoke tests
// Requires: marketing-creatives namespace populated (run index-fb.js + geo-analyzer.js first)
// Usage: node --env-file=scripts/.env scripts/tests/smoke.js [--game=uh]

import { queryVectors, embedTexts } from '../lib/pinecone.js';

const game    = (process.argv.find(a => a.startsWith('--game=')) || '--game=uh').split('=')[1];
const results = [];

async function check(id, description, fn) {
  try {
    const pass = await fn();
    results.push({ id, description, status: pass ? 'PASS' : 'FAIL' });
    console.log(`${pass ? '✓' : '✗'} ${id}: ${description}`);
  } catch (err) {
    results.push({ id, description, status: 'FAIL', error: err.message });
    console.log(`✗ ${id}: ${description} — ERROR: ${err.message}`);
  }
}

async function queryGame(filter = {}, topK = 5) {
  const [vec] = await embedTexts([`${game.toUpperCase()} video creative`], 'query');
  return queryVectors(vec, { game: { '$eq': game }, ...filter }, topK);
}

console.log(`\n=== Smoke Tests [${game}] ===\n`);

// PAIR-01: query returns results for the game
await check('PAIR-01', `query for game=${game} returns >= 3 results`, async () => {
  const res = await queryGame();
  return (res.matches || []).length >= 3;
});

// PAIR-02: platform filter works
await check('PAIR-02', 'platform=Android filter returns only Android', async () => {
  const res = await queryGame({ platform: { '$eq': 'Android' } });
  return (res.matches || []).every(m => m.metadata?.platform === 'Android');
});

// PAIR-03: winners exist in top results
await check('PAIR-03', 'at least 1 winner in top 10 results', async () => {
  const res = await queryGame({}, 10);
  return (res.matches || []).some(m => m.metadata?.is_winner === true);
});

// PAIR-04: include-low-confidence (no filter) returns more than default
await check('PAIR-04', 'unfiltered query returns results (includes LOW conf)', async () => {
  const [vec] = await embedTexts([`${game.toUpperCase()} video creative`], 'query');
  const res = await queryVectors(vec, { game: { '$eq': game } }, 20);
  return (res.matches || []).length > 0;
});

// PAIR-05: confidence filter excludes LOW by default
await check('PAIR-05', 'confidence_tier filter excludes LOW correctly', async () => {
  const res = await queryGame({ confidence_tier: { '$ne': 'LOW' } }, 20);
  return (res.matches || []).every(m => m.metadata?.confidence_tier !== 'LOW');
});

// PAIR-06: geo data populated (top_geos non-empty on at least half)
await check('PAIR-06', 'top_geos populated on >= 50% of indexed creatives', async () => {
  const res = await queryGame({}, 20);
  const withGeos = (res.matches || []).filter(m => m.metadata?.top_geos?.length > 0);
  return withGeos.length >= (res.matches || []).length * 0.5;
});

// PAIR-07: schema_version present on all results
await check('PAIR-07', 'schema_version=1 on all results', async () => {
  const res = await queryGame({}, 10);
  return (res.matches || []).every(m => m.metadata?.schema_version === 1);
});

// PAIR-08: cohort isolation — AEO filter returns only AEO
await check('PAIR-08', 'objective=AEO filter returns only AEO', async () => {
  const res = await queryGame({ objective: { '$eq': 'AEO' } });
  return (res.matches || []).every(m => m.metadata?.objective === 'AEO');
});

// PAIR-09: efficiency_score in range 0–100 or null
await check('PAIR-09', 'efficiency_score within 0–100 on all scored rows', async () => {
  const res = await queryGame({}, 20);
  return (res.matches || []).every(m => {
    const eff = m.metadata?.efficiency_score;
    return eff === null || eff === undefined || (eff >= 0 && eff <= 100);
  });
});

// PAIR-10: geo_cluster is a number (k-means ran)
await check('PAIR-10', 'geo_cluster is a valid number on geo-analyzed creatives', async () => {
  const res = await queryGame({}, 10);
  const withCluster = (res.matches || []).filter(m => m.metadata?.geo_cluster != null);
  return withCluster.length > 0;
});

// Summary
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''}`);
if (failed) {
  results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  FAIL: ${r.id} — ${r.description}${r.error ? ' ['+r.error+']' : ''}`));
  process.exit(1);
} else {
  console.log('ALL PASS ✓');
}
