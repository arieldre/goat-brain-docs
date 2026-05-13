import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const GEO_MAP = JSON.parse(readFileSync(join(__dir, '../geo_code_map.json'), 'utf8'));

const TIER1 = new Set(GEO_MAP.tier1);
const TIER2 = new Set(GEO_MAP.tier2);

export function geoTier(countryCode) {
  if (TIER1.has(countryCode)) return 'tier1';
  if (TIER2.has(countryCode)) return 'tier2';
  return 'tier3';
}

export function buildCpiProfile(countryBreakdown) {
  // Fixed-dimension vector: one slot per Tier1+Tier2 country, 0 if no data
  const countries = [...GEO_MAP.tier1, ...GEO_MAP.tier2];
  return countries.map(c => countryBreakdown[c]?.cpi || 0);
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

export function kMeans(profiles, k = 5, maxIter = 50) {
  if (profiles.length < k) k = profiles.length;
  const dim = profiles[0].length;

  // Initialize centroids by picking k random profiles
  let centroids = profiles.slice().sort(() => Math.random() - 0.5).slice(0, k);

  let assignments = new Array(profiles.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each profile to nearest centroid
    const newAssignments = profiles.map(p => {
      let best = 0, bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const sim = cosineSimilarity(p, centroids[c]);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      return best;
    });

    // Check convergence
    if (newAssignments.every((a, i) => a === assignments[i])) break;
    assignments = newAssignments;

    // Update centroids
    centroids = Array.from({ length: k }, (_, c) => {
      const members = profiles.filter((_, i) => assignments[i] === c);
      if (!members.length) return centroids[c]; // keep old centroid if empty
      const mean = new Array(dim).fill(0);
      for (const p of members) p.forEach((v, d) => { mean[d] += v; });
      return mean.map(v => v / members.length);
    });
  }

  return assignments;
}

export function topGeos(countryBreakdown, maxCount = 5) {
  return Object.entries(countryBreakdown)
    .filter(([, d]) => d.installs >= 3)
    .sort(([, a], [, b]) => (b.installs || 0) - (a.installs || 0))
    .slice(0, maxCount)
    .map(([cc]) => cc);
}

export const TIER1_COUNTRIES = GEO_MAP.tier1;
export const TIER2_COUNTRIES = GEO_MAP.tier2;
