// Asserts filtering against the live Drive index. Read-only: writes nothing.
const assert = require('assert');
const { search, index } = require('../lib/drive-store');

const idx = index();
console.log(`index: ${idx.images.length} images, ${idx.sidecars.size} sidecars, snapshot=${!!idx.snapshot}\n`);

const total = search({}).length;
assert.strictEqual(total, idx.images.length, 'empty query returns everything');

const cases = [
  [{ platform: 'android' }, (r) => r.platform === 'android'],
  [{ platform: 'ios' },     (r) => r.platform === 'ios'],
  [{ app: 'agoda' },        (r) => (r.app_name || '').includes('agoda')],
  [{ version: '12.3.0' },   (r) => r.app_version === '12.3.0'],
  [{ tag: 'seed' },         (r) => (r.tags || []).includes('seed')],
  [{ tag: 'pricing' },      (r) => (r.tags || []).includes('pricing')],
  [{ tag: 'nope' },         () => false],
  [{ collection: 'competitors/agoda' },              (r) => (r.collection_path||'').startsWith('competitors/agoda')],
  [{ collection: 'competitors/agoda/hotel-detail' }, (r) => (r.collection_path||'').startsWith('competitors/agoda/hotel-detail')],
  [{ collection: 'inbox' }, (r) => (r.collection_path||'').startsWith('inbox')],
  [{ month: '202609' },     (r) => (r.captured_stamp||'').startsWith('202609')],
  [{ month: '202501' },     () => false],
];

const rows = [];
for (const [q, pred] of cases) {
  const got = search(q).length;
  const want = idx.images.filter(pred).length;
  assert.strictEqual(got, want, `${JSON.stringify(q)}: got ${got}, expected ${want}`);
  rows.push({ query: JSON.stringify(q), matches: got });
}
console.table(rows);

// A filter must never widen the result set.
for (const [q] of cases) assert.ok(search(q).length <= total, 'a filter cannot return more than everything');

console.log('all search assertions passed');
