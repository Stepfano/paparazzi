// Does byte-quantising the signature change any verdict? It must not.
const { computeSignature, structuralSimilarity } = require('../lib/signature');
const { encodeSig, decodeSig, inferPlatform } = require('../lib/record');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');
// Fixtures come from the library itself: no external paths to rot.
const FILES = store.index().images.slice(0, 4).map((i) => i.path || i.token);

(async () => {
  if (FILES.length < 2) { console.log('need at least 2 screenshots in the library; skipping'); return; }
  const files = FILES.map((f, i) => `#${i + 1}`);
  const sigs = {};
  for (let i = 0; i < FILES.length; i++) sigs[files[i]] = await computeSignature(FILES[i]);

  const rows = [];
  for (let i = 0; i < files.length; i++)
    for (let j = i; j < files.length; j++) {
      const a = sigs[files[i]].structure, b = sigs[files[j]].structure;
      const exact = structuralSimilarity(a, b);
      const quant = structuralSimilarity(decodeSig(encodeSig(a)), decodeSig(encodeSig(b)));
      rows.push({ pair: `${i+1}v${j+1}`, float: +exact.toFixed(4), quantised: +quant.toFixed(4),
                  drift: +Math.abs(exact - quant).toFixed(5) });
    }
  console.table(rows);
  const worst = Math.max(...rows.map(r => r.drift));
  console.log('worst drift from quantising:', worst, worst < 0.005 ? '-> negligible' : '-> TOO HIGH');
  console.log('encoded size:', encodeSig(sigs[files[0]].structure).length, 'chars');
  console.log('\nplatform inference:');
  for (const n of ['Screenshot_2026-09-04-12-00-00.png','IMG_4021.PNG','1000134475.jpg','foo.png'])
    console.log(' ', n.padEnd(34), '->', inferPlatform(n));
})();
