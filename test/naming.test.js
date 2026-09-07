const { encodeName, parseName, searchTerm, MAX_NAME } = require('../lib/naming');
const assert = require('assert');

const meta = {
  screenshot_id: 'scr_0mtqq5b20jf1ig9v6v8',
  collection_path: 'competitors/Agoda/Hotel Detail',
  app_name: 'Agoda', app_version: '12.3.0', platform: 'android',
  captured_at: new Date('2026-09-07T11:30:00'),
  aspect: 0.4499, dhash: 'c88e3238f9f02250',
  tags: ['pricing', 'badge'], ext: 'jpg',
};

const name = encodeName(meta);
console.log('encoded:\n ', name, `\n  (${name.length} chars)\n`);

const back = parseName(name);
console.log('parsed back:'); console.table(back);

assert.strictEqual(back.screenshot_id, meta.screenshot_id, 'id must round-trip');
assert.strictEqual(back.collection_path, 'competitors/agoda/hotel-detail', 'collection round-trip');
assert.strictEqual(back.platform, 'android');
assert.strictEqual(back.app_version, '12.3.0');
assert.strictEqual(back.dhash, meta.dhash, 'dhash must round-trip exactly');
assert.deepStrictEqual(back.tags, ['pricing','badge']);
assert.ok(Math.abs(back.aspect - 0.45) < 0.001, 'aspect round-trip');
console.log('\nround-trip assertions passed');

console.log('\nsearch terms:');
for (const q of [{platform:'android'},{app:'Agoda'},{collection:'competitors/agoda'},{tag:'pricing'},{month:'202609'},{}])
  console.log(' ', JSON.stringify(q).padEnd(38), '->', searchTerm(q));

// Adversarial inputs
console.log('\nedge cases:');
const nasty = encodeName({ screenshot_id:'scr_x1', collection_path:'a/b__c/d', app_name:'Foo__Bar Baz!',
  app_version:'1.0 (beta)', platform:'ios', tags:['a b','c__d'], aspect:2.1, dhash:'ff00', ext:'PNG' });
console.log('  separator injection ->', nasty);
assert.strictEqual(parseName(nasty).screenshot_id, 'scr_x1', 'id survives injected separators');

const long = encodeName({ screenshot_id:'scr_long', collection_path:'x'.repeat(300),
  app_name:'y'.repeat(100), platform:'android', tags:Array(40).fill('tag'), dhash:'abc', ext:'jpg' });
console.log('  overlong ->', long.length, 'chars');
assert.ok(long.length <= MAX_NAME + 8, 'must stay near the cap');
assert.strictEqual(parseName(long).screenshot_id, 'scr_long', 'id survives truncation');

assert.strictEqual(parseName('random-photo.jpg'), null, 'foreign files ignored');
assert.strictEqual(parseName('hub__meta__scr_x.json').screenshot_id, 'scr_x');
console.log('  foreign file       -> ignored correctly');
console.log('\nall naming tests passed');
