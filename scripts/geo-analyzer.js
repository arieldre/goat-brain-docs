#!/usr/bin/env node
// Stage 3 — FB Geo Analyzer
// Usage: node --env-file=scripts/.env scripts/geo-analyzer.js <game> [--creative=name] [--dry-run]
// Pulls per-country breakdowns, clusters by CPI-profile, updates Pinecone metadata.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCreds, fbGetAll, adBaseName, daysAgo } from './lib/fb.js';
import { updateMetadata, queryVectors } from './lib/pinecone.js';
import { geoTier, buildCpiProfile, kMeans, topGeos, TIER1_COUNTRIES, TIER2_COUNTRIES } from './lib/geo-clusters.js';

const __dir    = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, 'cache');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// BP-104: concurrency cap + exponential backoff for country insights
const MAX_CONCURRENT = 3;
const MAX_RETRIES    = 5;

async function withRetry(fn, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Auth errors (code=190/102) do NOT match this pattern — they throw immediately. Intentional.
      const retryable = /17|32|613|rate|limit/i.test(err.message);
      if (!retryable || attempt === MAX_RETRIES) throw err;
      const wait = Math.pow(2, attempt) * 1000;
      console.error(`  [retry] ${label} attempt ${attempt + 1} — waiting ${wait}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

function cacheKey(game, since, until) {
  return join(CACHE_DIR, `geo-${game}-${since}-${until}.json`);
}

function loadCache(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (Date.now() - raw.ts < CACHE_TTL) return raw.data;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`  [cache] load failed (${err.code}): ${err.message}`);
  }
  return null;
}

function saveCache(path, data) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify({ ts: Date.now(), data }));
  } catch (err) {
    console.warn(`  [cache] write failed — continuing without cache: ${err.message}`);
  }
}

async function fetchGeoInsights(game, since, until) {
  const ckPath  = cacheKey(game, since, until);
  const cached  = loadCache(ckPath);
  if (cached) {
    console.log(`  [cache] using cached geo data for ${game} from ${since}`);
    return cached;
  }

  const { token, account } = getCreds(game);
  // BP-110: do NOT include 'country' in fields when using breakdowns=country
  const params = {
    fields:   'ad_id,ad_name,campaign_name,spend,impressions,clicks,actions',
    level:    'ad',
    breakdowns: 'country',
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
  };

  console.log(`  [fb] fetching country breakdown for ${game} (one call, all ads)...`);
  const rows = await withRetry(() => fbGetAll(token, `${account}/insights`, params), `geo-${game}`);
  console.log(`  [fb] received ${rows.length} rows (ad × country)`);

  // Group by creative base name → country → metrics
  const byCreative = {};
  for (const row of rows) {
    const base    = adBaseName(row.ad_name || '');
    const country = row.country;
    if (!country || !base) continue;

    if (!byCreative[base]) byCreative[base] = {};
    if (!byCreative[base][country]) byCreative[base][country] = { spend: 0, impressions: 0, clicks: 0, installs: 0 };

    const entry = byCreative[base][country];
    entry.spend       += parseFloat(row.spend)     || 0;
    entry.impressions += parseInt(row.impressions) || 0;
    entry.clicks      += parseInt(row.clicks)      || 0;
    const install = (row.actions || []).find(a => a.action_type === 'mobile_app_install');
    entry.installs += install ? parseFloat(install.value) : 0;
  }

  // Compute CPI per country per creative
  for (const [creative, countries] of Object.entries(byCreative)) {
    for (const [, data] of Object.entries(countries)) {
      data.cpi = data.installs > 0 ? +(data.spend / data.installs).toFixed(4) : null;
      data.ctr = data.impressions > 0 ? +(data.clicks / data.impressions * 100).toFixed(4) : 0;
    }
  }

  saveCache(ckPath, byCreative);
  return byCreative;
}

async function getIndexedCreatives(game) {
  // Fetch all indexed creative names from Pinecone via metadata filter
  const zeroVec = new Array(1024).fill(0);
  const res     = await queryVectors(zeroVec, { game: { '$eq': game } }, 1000);
  return (res.matches || []).map(m => ({
    id:           m.id,
    creative_name: m.metadata?.creative_name,
    platform:     m.metadata?.platform,
    objective:    m.metadata?.objective,
  })).filter(c => c.creative_name);
}

async function run() {
  const args     = process.argv.slice(2);
  const game     = args.find(a => !a.startsWith('--'));
  const creative = (args.find(a => a.startsWith('--creative=')) || '').split('=')[1] || null;
  const dryRun   = args.includes('--dry-run');

  if (!game) {
    console.error('Usage: node --env-file=scripts/.env scripts/geo-analyzer.js <game> [--creative=name] [--dry-run]');
    process.exit(1);
  }

  console.log(`\n=== Creative Intel — geo-analyzer [${game}]${creative ? ' creative='+creative : ''} ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  // 1. Fetch geo insights (one account-level call with country breakdown)
  const since = daysAgo(30);
  const until = daysAgo(0);
  const geoData = await fetchGeoInsights(game, since, until);
  console.log(`  [geo] ${Object.keys(geoData).length} creatives with country data`);

  // 2. Get indexed creative list from Pinecone
  console.log('  [pinecone] fetching indexed creatives...');
  const indexed = await getIndexedCreatives(game);
  if (indexed.length >= 1000) {
    console.warn(`  [pinecone] WARNING: fetched 1000 results — may be truncated. Index may have >1000 creatives for game=${game}.`);
  }
  const toUpdate = creative
    ? indexed.filter(c => c.creative_name === creative)
    : indexed;
  console.log(`  [pinecone] ${indexed.length} indexed, ${toUpdate.length} to update`);

  if (!toUpdate.length) {
    console.log('Nothing to update. Run index-fb.js first.');
    process.exit(0);
  }

  // 3. Build CPI-profile vectors for clustering
  const withGeo = toUpdate
    .map(c => {
      const breakdown = geoData[c.creative_name];
      if (!breakdown) return null;
      return { ...c, breakdown, profile: buildCpiProfile(breakdown) };
    })
    .filter(Boolean);

  console.log(`  [geo] ${withGeo.length}/${toUpdate.length} creatives have country data`);

  // 4. Cluster by CPI-profile (k-means, k=5)
  let assignments = [];
  if (withGeo.length >= 5) {
    const profiles  = withGeo.map(c => c.profile);
    assignments     = kMeans(profiles, 5);
    const clusterSizes = {};
    assignments.forEach(a => { clusterSizes[a] = (clusterSizes[a] || 0) + 1; });
    console.log(`  [kmeans] clusters: ${JSON.stringify(clusterSizes)}`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] First 5 geo updates:');
    withGeo.slice(0, 5).forEach((c, i) => {
      const geos = topGeos(c.breakdown);
      console.log(`  ${c.creative_name}: top_geos=${geos.join(',')} tier=${geoTier(geos[0] || '')}`);
    });
    return;
  }

  // 5. Update Pinecone metadata with geo data
  let updated = 0, noData = 0, errors = 0;

  // Process in batches respecting concurrency limit
  for (let i = 0; i < toUpdate.length; i += MAX_CONCURRENT) {
    const batch = toUpdate.slice(i, i + MAX_CONCURRENT);
    await Promise.all(batch.map(async (c, bi) => {
      const breakdown = geoData[c.creative_name];
      if (!breakdown) { noData++; return; }

      const geos      = topGeos(breakdown);
      const tier      = geoTier(geos[0] || '');
      const clusterIdx = withGeo.findIndex(w => w.id === c.id);
      const cluster    = clusterIdx >= 0 ? (assignments[clusterIdx] ?? null) : null;

      const metadata = {
        top_geos: geos,
        geo_tier: tier,
        geo_cluster: cluster,
      };

      try {
        await withRetry(() => updateMetadata(c.id, metadata), c.creative_name);
        updated++;
      } catch (err) {
        console.error(`  [error] ${c.creative_name}: ${err.message}`);
        errors++;
      }
    }));
    process.stdout.write(`  updated ${updated}/${toUpdate.length}\r`);
  }

  console.log(`\n\n✓ Done: ${updated} creatives updated with geo data`);
  if (noData) console.log(`  No geo data: ${noData}`);
  if (errors) console.log(`  Errors: ${errors}`);

  // Summary: top performing geos
  const allGeos = {};
  withGeo.forEach(c => {
    Object.entries(c.breakdown).forEach(([cc, d]) => {
      if (!allGeos[cc]) allGeos[cc] = { spend: 0, installs: 0 };
      allGeos[cc].spend    += d.spend;
      allGeos[cc].installs += d.installs;
    });
  });
  const topByInstalls = Object.entries(allGeos)
    .filter(([, d]) => d.installs >= 5)
    .sort(([, a], [, b]) => b.installs - a.installs)
    .slice(0, 10);

  if (topByInstalls.length) {
    console.log('\nTop geos by installs:');
    topByInstalls.forEach(([cc, d]) => {
      const cpi = d.installs > 0 ? `$${(d.spend / d.installs).toFixed(2)}` : 'n/a';
      console.log(`  ${cc.padEnd(4)} installs=${Math.round(d.installs).toString().padEnd(6)} cpi=${cpi} tier=${geoTier(cc)}`);
    });
  }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
