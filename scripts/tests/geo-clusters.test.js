import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geoTier, cosineSimilarity, buildCpiProfile, topGeos, kMeans } from '../lib/geo-clusters.js';

describe('geoTier', () => {
  it('US → tier1', () => assert.equal(geoTier('US'), 'tier1'));
  it('CA → tier1', () => assert.equal(geoTier('CA'), 'tier1'));
  it('FR → tier2', () => assert.equal(geoTier('FR'), 'tier2'));
  it('CO → tier3', () => assert.equal(geoTier('CO'), 'tier3'));
  it('unknown → tier3', () => assert.equal(geoTier('XX'), 'tier3'));
});

describe('cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    const v = [1, 2, 3];
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
  });
  it('orthogonal vectors → 0', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-6);
  });
  it('zero vector → 0', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
  });
  it('throws on length mismatch', () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]));
  });
});

describe('buildCpiProfile', () => {
  it('returns array with length = tier1 + tier2 countries', () => {
    const breakdown = { US: { cpi: 10, installs: 100 }, CO: { cpi: 1, installs: 500 } };
    const profile = buildCpiProfile(breakdown);
    assert.ok(profile.length > 0);
    assert.ok(profile.every(v => typeof v === 'number'));
  });
  it('missing country → 0 slot', () => {
    const profile = buildCpiProfile({});
    assert.ok(profile.every(v => v === 0));
  });
  it('US CPI in slot', () => {
    const profile = buildCpiProfile({ US: { cpi: 5.0 }, CA: { cpi: 0 } });
    assert.ok(profile.some(v => v === 5.0));
  });
});

describe('topGeos', () => {
  it('returns top geos by installs', () => {
    const breakdown = { US: { installs: 100 }, CO: { installs: 200 }, FR: { installs: 50 } };
    const top = topGeos(breakdown, 2);
    assert.equal(top[0], 'CO');
    assert.equal(top[1], 'US');
    assert.equal(top.length, 2);
  });
  it('filters out geos with installs < 3', () => {
    const breakdown = { US: { installs: 2 }, CO: { installs: 10 } };
    const top = topGeos(breakdown);
    assert.ok(!top.includes('US'));
    assert.ok(top.includes('CO'));
  });
  it('empty breakdown → empty array', () => {
    assert.deepEqual(topGeos({}), []);
  });
});

describe('kMeans', () => {
  it('assigns all profiles to a cluster', () => {
    const profiles = [[1,0,0],[0,1,0],[0,0,1],[1,1,0],[0,1,1],[1,0,1]];
    const assignments = kMeans(profiles, 3);
    assert.equal(assignments.length, profiles.length);
    assert.ok(assignments.every(a => a >= 0 && a < 3));
  });
  it('k > n uses n clusters', () => {
    const profiles = [[1,0],[0,1]];
    const assignments = kMeans(profiles, 5);
    assert.equal(assignments.length, 2);
  });
});
