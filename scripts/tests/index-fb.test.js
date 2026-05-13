import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// inline — same logic as index-fb.js sanitizeId
function sanitizeId(str) {
  return str.replace(/[–—]/g, '-').replace(/[^\x00-\x7F]/g, '');
}

describe('sanitizeId', () => {
  it('passes clean ASCII unchanged', () => {
    assert.equal(sanitizeId('inv|Orphan|Android|MAI'), 'inv|Orphan|Android|MAI');
  });

  it('replaces en dash with hyphen', () => {
    assert.equal(sanitizeId('inv|Name – Copy|Android|MAI'), 'inv|Name - Copy|Android|MAI');
  });

  it('replaces em dash with hyphen', () => {
    assert.equal(sanitizeId('inv|Name—Copy|Android|MAI'), 'inv|Name-Copy|Android|MAI');
  });

  it('strips other non-ASCII chars', () => {
    assert.equal(sanitizeId('inv|Naïve|Android|MAI'), 'inv|Nave|Android|MAI');
  });

  it('handles empty string', () => {
    assert.equal(sanitizeId(''), '');
  });
});
