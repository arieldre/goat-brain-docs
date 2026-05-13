import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTextChunk, extractConcept } from '../lib/cohort.js';

const base = {
  game: 'uh', platform: 'Android', objective: 'AEO',
  creative_name: 'UH_UA_MAR26_SeasonLady_Creator_30s_1080x1920',
  performance_tier: 'TOP', is_winner: true,
  cpi: 2.5, cpi_delta: -30, median_cpi: 3.5,
  hook_rate: 0.13, hold_rate: 0.40,
  spend: 2500, installs: 500,
  top_geos: ['CO', 'US', 'AR'],
};

describe('buildTextChunk', () => {
  it('contains game/platform/objective', () => {
    const t = buildTextChunk(base);
    assert.ok(t.includes('UH'));
    assert.ok(t.includes('Android'));
    assert.ok(t.includes('AEO'));
  });

  it('marks winner correctly', () => {
    assert.ok(buildTextChunk({ ...base, is_winner: true }).includes('Winner: yes'));
    assert.ok(buildTextChunk({ ...base, is_winner: false }).includes('Winner: no'));
  });

  it('includes geos when present', () => {
    const t = buildTextChunk(base);
    assert.ok(t.includes('CO') && t.includes('US'));
  });

  it('omits geos when absent', () => {
    const t = buildTextChunk({ ...base, top_geos: [] });
    assert.ok(!t.includes('Primary geos'));
  });

  it('strong hook label when hook_rate >= 0.12', () => {
    assert.ok(buildTextChunk({ ...base, hook_rate: 0.12 }).includes('strong'));
  });

  it('weak hook label when hook_rate < 0.07', () => {
    assert.ok(buildTextChunk({ ...base, hook_rate: 0.05 }).includes('weak'));
  });

  it('omits hook line when hook_rate is null', () => {
    const t = buildTextChunk({ ...base, hook_rate: null });
    assert.ok(!t.includes('Hook strength'));
  });

  it('top-quartile CPI label when cpi_delta <= -20', () => {
    assert.ok(buildTextChunk({ ...base, cpi_delta: -25 }).includes('top-quartile'));
  });

  it('bottom-quartile CPI label when cpi_delta > 30', () => {
    assert.ok(buildTextChunk({ ...base, cpi_delta: 50 }).includes('bottom-quartile'));
  });

  it('always ends with Source: FB', () => {
    assert.ok(buildTextChunk(base).endsWith('Source: FB.'));
  });

  it('high spend tier when spend >= 2000', () => {
    assert.ok(buildTextChunk({ ...base, spend: 2000 }).includes('Spend tier: high'));
  });

  it('includes creative_name when present', () => {
    const t = buildTextChunk(base);
    assert.ok(t.includes('Creative: UH_UA_MAR26_SeasonLady'));
  });

  it('includes extracted concept', () => {
    const t = buildTextChunk(base);
    assert.ok(t.includes('Concept: SeasonLady'));
  });

  it('omits Creative line when creative_name absent', () => {
    const t = buildTextChunk({ ...base, creative_name: undefined });
    assert.ok(!t.includes('Creative:'));
  });
});

describe('extractConcept', () => {
  it('extracts concept from INV name', () => {
    assert.equal(extractConcept('INV_UA_NOV25_Orphan_OleksandrBabak_60s_1080x1920_VD-80QSHIPW-001-ENG-002'), 'Orphan');
  });

  it('extracts concept from UH name', () => {
    assert.equal(extractConcept('UH_UA_MAR26_SeasonLady_Creator_30s_1080x1920'), 'SeasonLady');
  });

  it('extracts multi-word concept', () => {
    assert.equal(extractConcept('INV_UA_APR26_ArenaProgression_Original_30s_1080x1920'), 'ArenaProgression');
  });

  it('returns empty string for unrecognized pattern', () => {
    assert.equal(extractConcept(''), '');
  });
});
