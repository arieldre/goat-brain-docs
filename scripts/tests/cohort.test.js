import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zscore, median, quartiles, assignPerformanceTier, assignConfidenceTier, scoreCreatives } from '../lib/cohort.js';

describe('zscore', () => {
  it('returns 0 for single value', () => assert.equal(zscore([5], 5), 0));
  it('returns 0 for uniform distribution', () => assert.equal(zscore([3, 3, 3], 3), 0));
  it('returns positive for above-mean value', () => assert.ok(zscore([1, 2, 3, 4, 5], 5) > 0));
  it('returns negative for below-mean value', () => assert.ok(zscore([1, 2, 3, 4, 5], 1) < 0));
});

describe('median', () => {
  it('odd length', () => assert.equal(median([1, 3, 5]), 3));
  it('even length', () => assert.equal(median([1, 2, 3, 4]), 2.5));
  it('single element', () => assert.equal(median([7]), 7));
  it('empty array returns null', () => assert.equal(median([]), null));
});

describe('quartiles', () => {
  it('empty returns zeros', () => {
    const q = quartiles([]);
    assert.equal(q.q1, 0); assert.equal(q.q2, 0); assert.equal(q.q3, 0);
  });
  it('known dataset', () => {
    const q = quartiles([1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(q.q1 < q.q2 && q.q2 < q.q3);
    assert.ok(q.q1 >= 2 && q.q1 <= 3);
    assert.ok(q.q2 >= 4 && q.q2 <= 5);
    assert.ok(q.q3 >= 6 && q.q3 <= 7);
  });
});

describe('assignPerformanceTier', () => {
  const qs = { q1: 25, q2: 50, q3: 75 };
  it('above q3 → TOP',  () => assert.equal(assignPerformanceTier(80, qs), 'TOP'));
  it('above q2 → HIGH', () => assert.equal(assignPerformanceTier(60, qs), 'HIGH'));
  it('above q1 → MED',  () => assert.equal(assignPerformanceTier(30, qs), 'MED'));
  it('below q1 → LOW',  () => assert.equal(assignPerformanceTier(10, qs), 'LOW'));
});

describe('assignConfidenceTier', () => {
  it('HIGH: spend>=500 + installs>=10', () => assert.equal(assignConfidenceTier(500, 10), 'HIGH'));
  it('MED: spend>=50 + installs>=5',    () => assert.equal(assignConfidenceTier(50, 5), 'MED'));
  it('LOW: below MED',                  () => assert.equal(assignConfidenceTier(10, 1), 'LOW'));
  it('HIGH requires both conditions',   () => assert.equal(assignConfidenceTier(600, 5), 'MED'));
});

describe('scoreCreatives — insufficient data (<5)', () => {
  const small = [
    { creative_name: 'a', platform: 'iOS', objective: 'MAI', cpi: 2.0, ctr: 1.0, hook_rate: 0.1, hold_rate: 0.3, spend: 100, installs: 5 },
    { creative_name: 'b', platform: 'iOS', objective: 'MAI', cpi: 4.0, ctr: 0.5, hook_rate: 0.05, hold_rate: 0.2, spend: 50, installs: 2 },
  ];
  it('marks _insufficientData', () => {
    const result = scoreCreatives(small);
    assert.ok(result.every(c => c._insufficientData));
  });
  it('efficiency_score is null', () => {
    const result = scoreCreatives(small);
    assert.ok(result.every(c => c.efficiency_score === null));
  });
});

describe('scoreCreatives — full cohort (>=5)', () => {
  const group = [
    { creative_name: 'a', cpi: 1.0, ctr: 2.0, hook_rate: 0.15, hold_rate: 0.40, spend: 600, installs: 100, platform: 'iOS', objective: 'MAI' },
    { creative_name: 'b', cpi: 2.0, ctr: 1.5, hook_rate: 0.10, hold_rate: 0.30, spend: 400, installs: 50,  platform: 'iOS', objective: 'MAI' },
    { creative_name: 'c', cpi: 3.0, ctr: 1.0, hook_rate: 0.08, hold_rate: 0.25, spend: 200, installs: 20,  platform: 'iOS', objective: 'MAI' },
    { creative_name: 'd', cpi: 4.0, ctr: 0.8, hook_rate: 0.06, hold_rate: 0.20, spend: 100, installs: 8,   platform: 'iOS', objective: 'MAI' },
    { creative_name: 'e', cpi: 5.0, ctr: 0.5, hook_rate: 0.04, hold_rate: 0.15, spend: 60,  installs: 4,   platform: 'iOS', objective: 'MAI' },
  ];
  it('all have efficiency_score 0–100', () => {
    const result = scoreCreatives(group);
    assert.ok(result.every(c => c.efficiency_score >= 0 && c.efficiency_score <= 100));
  });
  it('lower CPI → higher efficiency', () => {
    const result = scoreCreatives(group);
    const a = result.find(c => c.creative_name === 'a');
    const e = result.find(c => c.creative_name === 'e');
    assert.ok(a.efficiency_score > e.efficiency_score);
  });
  it('sorted descending by efficiency', () => {
    const result = scoreCreatives(group);
    for (let i = 1; i < result.length; i++) {
      assert.ok((result[i - 1].efficiency_score ?? -1) >= (result[i].efficiency_score ?? -1));
    }
  });
  it('none marked _insufficientData', () => {
    const result = scoreCreatives(group);
    assert.ok(result.every(c => !c._insufficientData));
  });
});

describe('scoreCreatives — null CPI safety (BP-093)', () => {
  it('null cpi does not corrupt avg', () => {
    const group = [
      { creative_name: 'a', cpi: null, ctr: 1.0, hook_rate: null, hold_rate: null, spend: 10, installs: 0, platform: 'iOS', objective: 'MAI' },
      { creative_name: 'b', cpi: 2.0,  ctr: 1.0, hook_rate: null, hold_rate: null, spend: 200, installs: 20, platform: 'iOS', objective: 'MAI' },
      { creative_name: 'c', cpi: 3.0,  ctr: 0.8, hook_rate: null, hold_rate: null, spend: 150, installs: 15, platform: 'iOS', objective: 'MAI' },
      { creative_name: 'd', cpi: 4.0,  ctr: 0.6, hook_rate: null, hold_rate: null, spend: 100, installs: 8,  platform: 'iOS', objective: 'MAI' },
      { creative_name: 'e', cpi: 5.0,  ctr: 0.4, hook_rate: null, hold_rate: null, spend: 60,  installs: 4,  platform: 'iOS', objective: 'MAI' },
    ];
    const result = scoreCreatives(group);
    const nullRow = result.find(c => c.creative_name === 'a');
    assert.equal(nullRow._insufficientData, true);
    const scored = result.filter(c => c.efficiency_score !== null);
    assert.equal(scored.length, 4);
  });
});
