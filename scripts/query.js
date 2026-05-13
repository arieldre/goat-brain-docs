#!/usr/bin/env node
// Stage 2 — Similarity Query Tool
// Usage: node --env-file=scripts/.env scripts/query.js "<creative_name>" --game=<game> [options]
// Options:
//   --game=inv|uh      required
//   --platform=iOS|Android
//   --objective=MAI|AEO
//   --top=5            number of results (default 5)
//   --include-low      include LOW confidence results
//   --json             output as JSON

import { embedTexts, fetchVectors, queryVectors } from './lib/pinecone.js';
import { buildTextChunk } from './lib/cohort.js';

const STALE_DAYS = 14;

function parseArgs() {
  const args    = process.argv.slice(2);
  const name    = args.find(a => !a.startsWith('--'));
  const game    = (args.find(a => a.startsWith('--game='))      || '').split('=')[1];
  const platform = (args.find(a => a.startsWith('--platform=')) || '').split('=')[1] || null;
  const objective = (args.find(a => a.startsWith('--objective='))|| '').split('=')[1] || null;
  const top     = parseInt((args.find(a => a.startsWith('--top=')) || '--top=5').split('=')[1]);
  const inclLow = args.includes('--include-low');
  const asJson  = args.includes('--json');
  return { name, game, platform, objective, top, inclLow, asJson };
}

function staleFlag(indexedAt) {
  const ageDays = (Date.now() / 1000 - indexedAt) / 86400;
  return ageDays > STALE_DAYS ? ` [STALE ${Math.round(ageDays)}d]` : ` [${Math.round(ageDays)}d ago]`;
}

function formatResult(match, rank) {
  const m = match.metadata;
  const winner  = m.is_winner ? ' WINNER' : '';
  const conf    = m.confidence_tier === 'LOW' ? ' [LOW-CONF]' : '';
  const stale   = staleFlag(m.indexed_at || 0);
  const cpi     = m.cpi ? `$${parseFloat(m.cpi).toFixed(2)}` : 'n/a';
  const eff     = m.efficiency_score != null ? m.efficiency_score : 'n/a';
  return `#${rank} ${(m.creative_name || '').padEnd(45)} score=${match.score.toFixed(3)}  CPI=${cpi}  eff=${eff}  ${m.platform}/${m.objective}${winner}${conf}${stale}`;
}

async function fetchSourceVector(name, game, platform, objective) {
  // Try exact ID fetch first
  if (platform && objective) {
    const id = `${game}|${name}|${platform}|${objective}`;
    try {
      const res = await fetchVectors([id]);
      const vec = res.vectors?.[id];
      if (vec?.values?.length) {
        console.error(`  [query] found exact vector for ${id}`);
        return { vector: vec.values, metadata: vec.metadata };
      }
    } catch (_) {}
  }

  // Fallback: query by metadata filter to find any match by name
  const filter = { game: { '$eq': game }, creative_name: { '$eq': name } };
  if (platform)  filter.platform  = { '$eq': platform };
  if (objective) filter.objective = { '$eq': objective };

  // Use small dummy query to do metadata-only lookup
  const zeroVec = new Array(1024).fill(0);
  const res = await queryVectors(zeroVec, filter, 1);
  const match = res.matches?.[0];
  if (match?.values?.length) return { vector: match.values, metadata: match.metadata };

  // Creative not indexed yet — re-embed on the fly from known metadata
  return null;
}

async function run() {
  const { name, game, platform, objective, top, inclLow, asJson } = parseArgs();

  if (!name || !game) {
    console.error('Usage: node --env-file=scripts/.env scripts/query.js "<name>" --game=<game> [--platform=iOS] [--objective=MAI] [--top=5] [--include-low] [--json]');
    process.exit(1);
  }

  if (!asJson) console.error(`\nQuerying similar to "${name}" [game=${game}${platform ? ' plat='+platform : ''}${objective ? ' obj='+objective : ''}] top=${top}\n`);

  // 1. Get or build the query vector
  let queryVector;
  const stored = await fetchSourceVector(name, game, platform, objective);

  if (stored?.vector) {
    queryVector = stored.vector;
    if (!asJson) console.error(`  [source] using stored vector for ${name}`);
  } else {
    // Build a synthetic text chunk for embedding
    if (!asJson) console.error(`  [source] "${name}" not indexed — embedding synthetic query`);
    const syntheticText = `${game.toUpperCase()} ${platform || 'unknown'} ${objective || 'unknown'} video creative. Name: ${name}.`;
    const vectors = await embedTexts([syntheticText], 'query'); // BP-101: query for retrieval
    queryVector = vectors[0];
  }

  // 2. Build filter
  const filter = {};
  if (game !== 'all') filter.game = { '$eq': game };
  if (platform)        filter.platform  = { '$eq': platform };
  if (objective)       filter.objective = { '$eq': objective };
  if (!inclLow)        filter.confidence_tier = { '$ne': 'LOW' };

  // 3. Query — fetch extra to exclude self
  const fetchK = top + 5;
  const res = await queryVectors(queryVector, filter, fetchK);

  // 4. Filter self from results
  const matches = (res.matches || [])
    .filter(m => m.metadata?.creative_name !== name)
    .slice(0, top);

  if (asJson) {
    console.log(JSON.stringify({ query: name, game, platform, objective, results: matches.map(m => ({ ...m.metadata, score: m.score })) }, null, 2));
    return;
  }

  if (!matches.length) {
    console.log('No results found. Try --include-low or check if creatives are indexed.');
    return;
  }

  matches.forEach((m, i) => console.log(formatResult(m, i + 1)));

  const winners = matches.filter(m => m.metadata?.is_winner);
  if (winners.length) console.log(`\n${winners.length}/${matches.length} results are winners.`);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
