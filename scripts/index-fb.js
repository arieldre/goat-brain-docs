#!/usr/bin/env node
// Stage 1 — FB Creative Vectorizer
// Usage: node --env-file=scripts/.env scripts/index-fb.js <game> [--days=30] [--dry-run]
// Games: inv, uh

import { getCreds, fbGetAll, adBaseName, adPlatform, adObjective, adInstalls, adRetention, daysAgo } from './lib/fb.js';
import { scoreCreatives, computeCohortStats, assignPerformanceTier, assignConfidenceTier, buildTextChunk } from './lib/cohort.js';
import { embedTexts, upsertVectors } from './lib/pinecone.js';

const FIELDS = [
  'ad_id', 'ad_name', 'campaign_name', 'spend', 'impressions', 'clicks',
  'actions', 'cost_per_action_type',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions',
].join(',');

const EMBED_BATCH = 10; // Pinecone embed limit per request
const SCHEMA_VERSION = 1;

async function fetchInsights(game, since, until) {
  const { token, account } = getCreds(game);
  const params = {
    fields: FIELDS,
    level: 'ad',
    time_range: JSON.stringify({ since, until }),
    action_attribution_windows: JSON.stringify(['7d_click', '1d_view']),
  };
  const rows = await fbGetAll(token, `${account}/insights`, params);
  console.log(`  [fb] fetched ${rows.length} raw ad rows for ${game}`);
  return rows;
}

function parseRows(rows) {
  return rows.map(ad => ({
    ad_id:        ad.ad_id,
    ad_name:      ad.ad_name || '',
    spend:        parseFloat(ad.spend)     || 0,
    impressions:  parseInt(ad.impressions) || 0,
    clicks:       parseInt(ad.clicks)      || 0,
    installs:     adInstalls(ad),
    retention:    adRetention(ad),
    platform:     adPlatform(ad.campaign_name || ''),
    objective:    adObjective(ad.campaign_name || ''),
  }));
}

function dedupeByBase(parsed) {
  const byKey = new Map();
  for (const ad of parsed) {
    const base = adBaseName(ad.ad_name);
    const key  = `${base}|${ad.platform}|${ad.objective}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...ad, creative_name: base, _count: 1 });
    } else {
      const e = byKey.get(key);
      e.spend      += ad.spend;
      e.impressions += ad.impressions;
      e.clicks     += ad.clicks;
      e.installs   += ad.installs;
      e._count++;
      // keep retention from whichever ad has the most impressions
      if (!e.retention && ad.retention) e.retention = ad.retention;
    }
  }
  return [...byKey.values()];
}

function toCreativeRow(ad) {
  const ctr  = ad.impressions > 0 ? (ad.clicks / ad.impressions) * 100 : 0;
  const cpi  = ad.installs > 0 ? ad.spend / ad.installs : null;
  return {
    creative_name: ad.creative_name,
    platform:      ad.platform,
    objective:     ad.objective,
    spend:         +ad.spend.toFixed(2),
    impressions:   ad.impressions,
    clicks:        ad.clicks,
    installs:      ad.installs,
    cpi:           cpi  ? +cpi.toFixed(4)  : null,
    ctr:           +ctr.toFixed(4),
    hook_rate:     ad.retention?.hookRate ?? null,
    hold_rate:     ad.retention?.holdRate ?? null,
    efficiency_score: null, // filled by scoreCreatives
  };
}

async function run() {
  const args    = process.argv.slice(2);
  const game    = args.find(a => !a.startsWith('--'));
  const days    = parseInt((args.find(a => a.startsWith('--days=')) || '--days=30').split('=')[1]);
  const dryRun  = args.includes('--dry-run');

  if (!game) {
    console.error('Usage: node --env-file=scripts/.env scripts/index-fb.js <game> [--days=30] [--dry-run]');
    process.exit(1);
  }

  console.log(`\n=== Creative Intel — index-fb [${game}] days=${days} ${dryRun ? '(DRY RUN)' : ''} ===\n`);

  // 1. Fetch raw insights
  const since = daysAgo(days);
  const until = daysAgo(0);
  console.log(`Fetching insights ${since} → ${until}...`);
  const rawRows = await fetchInsights(game, since, until);

  // 2. Parse + filter
  const parsed  = parseRows(rawRows).filter(a => a.spend >= 10 && a.impressions >= 100);
  console.log(`  [parse] ${parsed.length} ads after spend/imp filter`);

  if (!parsed.length) {
    console.log('No eligible ads. Exiting.');
    process.exit(0);
  }

  // 3. Dedupe by base name + platform + objective
  const deduped = dedupeByBase(parsed);
  console.log(`  [dedup] ${deduped.length} unique creative+platform+objective combos`);

  // 4. Build creative rows with CPI/CTR
  const creatives = deduped.map(toCreativeRow);

  // 5. Score within cohorts (game+platform+objective groups)
  const cohortGroups = {};
  for (const c of creatives) {
    const k = `${c.platform}|${c.objective}`;
    if (!cohortGroups[k]) cohortGroups[k] = [];
    cohortGroups[k].push(c);
  }

  const scoredAll = [];
  for (const [cohortKey, group] of Object.entries(cohortGroups)) {
    const scored = scoreCreatives(group);
    scoredAll.push(...scored);
    console.log(`  [cohort] ${cohortKey}: ${group.length} creatives, ${scored.filter(c => !c._insufficientData).length} scored`);
  }

  // 6. Assign tiers using cohort quartile stats
  const cohortStats = computeCohortStats(scoredAll);
  const tiered = scoredAll.map(c => {
    const cohortKey  = `${c.platform}|${c.objective}`;
    const stats      = cohortStats[cohortKey];
    const confTier   = assignConfidenceTier(c.spend, c.installs);
    const perfTier   = stats && c.efficiency_score !== null
      ? assignPerformanceTier(c.efficiency_score, stats.effQuartiles)
      : 'unknown';
    const isWinner   = perfTier === 'TOP' && c.spend >= 500 && confTier !== 'LOW';
    return {
      ...c,
      game,
      performance_tier:  perfTier,
      confidence_tier:   confTier,
      is_winner:         isWinner,
      top_geos:          [], // populated in Stage 3
      geo_tier:          'unknown',
      schema_version:    SCHEMA_VERSION,
      indexed_at:        Math.floor(Date.now() / 1000),
    };
  });

  console.log(`\n  Winners: ${tiered.filter(c => c.is_winner).length}`);
  console.log(`  HIGH confidence: ${tiered.filter(c => c.confidence_tier === 'HIGH').length}`);
  console.log(`  MED confidence: ${tiered.filter(c => c.confidence_tier === 'MED').length}`);
  console.log(`  LOW confidence (will skip embed): ${tiered.filter(c => c.confidence_tier === 'LOW').length}`);

  // 7. Filter: skip LOW confidence unless small game
  const toIndex = tiered.filter(c => c.confidence_tier !== 'LOW' || tiered.length < 10);
  console.log(`\n  To index: ${toIndex.length} creatives`);

  if (dryRun) {
    console.log('\n[DRY RUN] First 3 text chunks:');
    toIndex.slice(0, 3).forEach(c => console.log(`  • ${buildTextChunk(c)}`));
    return;
  }

  // 8. Embed in batches of EMBED_BATCH
  console.log('\nEmbedding and upserting...');
  let upserted = 0, skipped = 0, errors = 0;

  for (let i = 0; i < toIndex.length; i += EMBED_BATCH) {
    const batch     = toIndex.slice(i, i + EMBED_BATCH);
    const texts     = batch.map(buildTextChunk);

    let vectors;
    try {
      vectors = await embedTexts(texts, 'passage'); // BP-101: passage for indexing
    } catch (err) {
      console.error(`  [embed error] batch ${i}–${i + batch.length}: ${err.message}`);
      errors += batch.length;
      continue;
    }

    const pineconeVecs = batch.map((c, j) => ({
      id: `${game}|${c.creative_name}|${c.platform}|${c.objective}`, // BP-105: game prefix
      values: vectors[j],
      metadata: {
        game,
        creative_name:    c.creative_name,
        platform:         c.platform,
        objective:        c.objective,
        source:           'fb',
        cpi:              c.cpi,
        ctr:              +c.ctr.toFixed(4),
        hook_rate:        c.hook_rate,
        hold_rate:        c.hold_rate,
        efficiency_score: c.efficiency_score,
        spend:            c.spend,
        installs:         c.installs,
        performance_tier: c.performance_tier,
        is_winner:        c.is_winner,
        confidence_tier:  c.confidence_tier,
        schema_version:   SCHEMA_VERSION,
        indexed_at:       c.indexed_at,
        top_geos:         c.top_geos,
        geo_tier:         c.geo_tier,
      },
    }));

    try {
      await upsertVectors(pineconeVecs);
      upserted += batch.length;
      process.stdout.write(`  upserted ${upserted}/${toIndex.length}\r`);
    } catch (err) {
      console.error(`  [upsert error] batch ${i}–${i + batch.length}: ${err.message}`);
      errors += batch.length;
    }
  }

  console.log(`\n\n✓ Done: ${upserted} vectors upserted to marketing-creatives`);
  if (skipped) console.log(`  Skipped: ${skipped}`);
  if (errors)  console.log(`  Errors: ${errors}`);

  // Summary table
  const winners = tiered.filter(c => c.is_winner);
  if (winners.length) {
    console.log('\nWinners:');
    winners.forEach(c => console.log(`  ${c.creative_name.padEnd(40)} ${c.platform.padEnd(8)} ${c.objective.padEnd(5)} eff=${c.efficiency_score} cpi=$${c.cpi?.toFixed(2)} spend=$${c.spend}`));
  }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
