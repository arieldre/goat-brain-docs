// Cohort-relative scoring — all tiers computed within game+platform+objective cohort (BP-087)

export function zscore(vals, v) {
  if (vals.length < 2) return 0;
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const std  = Math.sqrt(vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length);
  return std === 0 ? 0 : (v - mean) / std;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(sorted, p) {
  const idx = p * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function quartiles(values) {
  if (!values.length) return { q1: 0, q2: 0, q3: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { q1: percentile(sorted, 0.25), q2: percentile(sorted, 0.50), q3: percentile(sorted, 0.75) };
}

export function assignPerformanceTier(effScore, qs) {
  if (effScore >= qs.q3) return 'TOP';
  if (effScore >= qs.q2) return 'HIGH';
  if (effScore >= qs.q1) return 'MED';
  return 'LOW';
}

export function assignConfidenceTier(spend, installs) {
  if (spend >= 500 && installs >= 10) return 'HIGH';
  if (spend >= 50  && installs >= 5)  return 'MED';
  return 'LOW';
}

export function assignSpendTier(spend, qs) {
  if (spend >= qs.q3) return 'high';
  if (spend >= qs.q1) return 'medium';
  return 'low';
}

export function scoreCreatives(creatives) {
  // BP-093: filter null before reduce — null coerces to 0 and corrupts averages
  if (!creatives.length) return [];

  if (creatives.length < 5) {
    const med = median(creatives.map(c => c.cpi).filter(v => v !== null));
    return creatives.map(c => ({
      ...c,
      efficiency_score: null,
      cpi_delta: c.cpi && med ? +((c.cpi - med) / med * 100).toFixed(0) : null,
      median_cpi: med,
      _insufficientData: true,
    }));
  }

  const cpis      = creatives.map(c => c.cpi).filter(v => v !== null);
  const ctrs      = creatives.map(c => c.ctr);
  const hookRates = creatives.map(c => c.hook_rate || 0);
  const holdRates = creatives.map(c => c.hold_rate || 0);
  const med       = median(cpis);
  const anyRetention = creatives.some(c => (c.hook_rate || 0) > 0);
  const [wCpi, wCtr, wHook, wHold] = anyRetention
    ? [0.50, 0.20, 0.15, 0.15]
    : [0.70, 0.30, 0.00, 0.00];

  return creatives.map(c => {
    if (!c.cpi) return { ...c, efficiency_score: null, _insufficientData: true };
    const composite =
      -zscore(cpis,      c.cpi)          * wCpi +
       zscore(ctrs,      c.ctr)          * wCtr +
       zscore(hookRates, c.hook_rate||0) * wHook +
       zscore(holdRates, c.hold_rate||0) * wHold;
    return {
      ...c,
      efficiency_score: Math.round(Math.max(0, Math.min(100, 50 + composite * 20))),
      cpi_delta:        +((c.cpi - med) / med * 100).toFixed(0),
      median_cpi:       med,
    };
  }).sort((a, b) => (b.efficiency_score ?? -1) - (a.efficiency_score ?? -1));
}

export function computeCohortStats(scored) {
  const cohorts = {};
  for (const c of scored) {
    const k = `${c.platform}|${c.objective}`;
    if (!cohorts[k]) cohorts[k] = [];
    cohorts[k].push(c);
  }
  const stats = {};
  for (const [k, group] of Object.entries(cohorts)) {
    const effs   = group.map(c => c.efficiency_score).filter(v => v !== null);
    const spends = group.map(c => c.spend);
    stats[k] = {
      count:          group.length,
      effQuartiles:   quartiles(effs),
      spendQuartiles: quartiles(spends),
    };
  }
  return stats;
}

export function buildTextChunk(c) {
  const spendTier  = c.spend >= 2000 ? 'high' : c.spend >= 300 ? 'medium' : 'low';
  const hookStr    = c.hook_rate != null
    ? `Hook strength: ${c.hook_rate >= 0.12 ? 'strong' : c.hook_rate >= 0.07 ? 'moderate' : 'weak'} (${(c.hook_rate * 100).toFixed(1)}%).`
    : '';
  const holdStr    = c.hold_rate != null
    ? `Retention: ${c.hold_rate >= 0.35 ? 'strong' : c.hold_rate >= 0.20 ? 'moderate' : 'weak'} (${(c.hold_rate * 100).toFixed(1)}%).`
    : '';
  const cpiTier    = c.cpi_delta != null
    ? (c.cpi_delta <= -20 ? 'top-quartile' : c.cpi_delta <= 0 ? 'above-avg' : c.cpi_delta <= 30 ? 'below-avg' : 'bottom-quartile')
    : 'unknown';
  const geoStr     = c.top_geos?.length ? `Primary geos: ${c.top_geos.join(', ')}.` : '';

  return [
    `${c.game.toUpperCase()} ${c.platform} ${c.objective} video creative.`,
    `Performance tier: ${c.performance_tier || 'unknown'}.`,
    hookStr,
    holdStr,
    `CPI tier: ${cpiTier} within ${c.game}+${c.platform}+${c.objective} cohort.`,
    `Spend tier: ${spendTier}. Winner: ${c.is_winner ? 'yes' : 'no'}.`,
    geoStr,
    `Source: FB.`,
  ].filter(Boolean).join(' ');
}
