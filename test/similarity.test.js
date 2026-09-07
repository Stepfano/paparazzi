const sharp = require('sharp');
const path = require('path');
const { computeSignature, compare } = require('../lib/signature.js');

const store = require('../lib/store');
const LIB = store.index().images.map((i) => i.path || i.token);

const TMP = '/tmp/simvars';
require('fs').mkdirSync(TMP, { recursive: true });

(async () => {
  const src = LIB[0];                                // a real screenshot from the library
  const meta = await sharp(src).metadata();
  const { width: W, height: H } = meta;

  // --- build controlled variants of one real screenshot ---
  const v = {};
  v.identical   = src;
  v.resized55   = `${TMP}/resized.jpg`;
  v.jpegQ35     = `${TMP}/q35.jpg`;
  v.brighter    = `${TMP}/bright.jpg`;
  v.statusBar   = `${TMP}/status.jpg`;
  v.contentBand = `${TMP}/band.jpg`;
  v.scrolled8pc = `${TMP}/scroll.jpg`;
  v.flipped     = `${TMP}/flip.jpg`;

  await sharp(src).resize(Math.round(W * 0.55)).toFile(v.resized55);
  await sharp(src).jpeg({ quality: 35 }).toFile(v.jpegQ35);
  await sharp(src).modulate({ brightness: 1.35 }).linear(1.2, -20).toFile(v.brighter);
  // different clock/battery: paint over the top 4%
  await sharp(src).composite([{
    input: { create: { width: W, height: Math.round(H*0.04), channels: 3, background: '#101010' } },
    top: 0, left: 0 }]).toFile(v.statusBar);
  // different content inside the layout: paint over a mid band (a card's contents changed)
  await sharp(src).composite([{
    input: { create: { width: Math.round(W*0.9), height: Math.round(H*0.12), channels: 3, background: '#8899aa' } },
    top: Math.round(H*0.35), left: Math.round(W*0.05) }]).toFile(v.contentBand);
  // scrolled: shift content up 8%, same skeleton
  await sharp(src).extract({ left:0, top: Math.round(H*0.08), width: W, height: Math.round(H*0.92) })
    .resize(W, H, { fit:'fill' }).toFile(v.scrolled8pc);
  await sharp(src).flop().toFile(v.flipped);

  const baseSig = await computeSignature(src);

  console.log('\n=== variants of ONE real screenshot (00002.jpg, 1220x2712) ===');
  console.log('expectation: all except "flipped" are the same screen and should score high\n');
  const rows = [];
  for (const [name, file] of Object.entries(v)) {
    const sig = await computeSignature(file);
    const r = compare(baseSig, sig);
    rows.push({ variant: name, structural: r.structural, dhash: r.dhashDistance, duplicate: r.duplicate, reason: r.reason });
  }
  console.table(rows);

  console.log('\n=== the 4 real screenshots cross-compared ===');
  console.log('expectation: these are different screens and should score LOW\n');
  const files = LIB.slice(0, 4);
  const sigs = {};
  for (const f of files) sigs[f] = await computeSignature(f);
  const cross = [];
  for (let i = 0; i < files.length; i++)
    for (let j = i+1; j < files.length; j++) {
      const r = compare(sigs[files[i]], sigs[files[j]]);
      cross.push({ pair: `#${i + 1} vs #${j + 1}`,
        structural: r.structural, dhash: r.dhashDistance,
        aspectDelta: r.aspectDelta, framing: r.comparableFraming ? 'same' : 'differs',
        duplicate: r.duplicate });
    }
  console.table(cross);
})();
