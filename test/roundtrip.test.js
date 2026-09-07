// End-to-end: read what Lark stored, then dedupe a fresh signature against it.
const { listRecords } = require('../lib/lark');
const { computeSignature } = require('../lib/signature');
const { findDuplicate } = require('../lib/record');

const BASE = 'Iy5ibe9iWa15t0sXNlulIXuFgEd';
const TABLE = 'tblpk1VPZ8glkRc8';
const S = '/Users/stepfano/Documents/Claude/RRI/phone-to-figma/relay/shots/';

(async () => {
  const { rows } = listRecords(BASE, TABLE);
  console.log(`read ${rows.length} record(s) from Lark Base\n`);
  const r = rows[0];
  console.log('stored record:');
  for (const k of ['screenshot_id','title','platform','width','height','aspect','dhash','collection_path'])
    console.log(`  ${k.padEnd(17)} ${r[k]}`);
  console.log(`  ${'structure_sig'.padEnd(17)} ${String(r.structure_sig).length} chars`);

  console.log('\n--- dedupe against what Lark holds ---');
  for (const f of ['00002.jpg', '00001.jpg', '00003.jpg']) {
    const sig = await computeSignature(S + f);
    const dup = findDuplicate(sig, rows);
    const label = f === '00002.jpg' ? '(same image already stored)' : '(different screenshot)';
    console.log(`${f} ${label}`);
    console.log(dup
      ? `  -> DUPLICATE of ${dup.screenshot_id}  similarity ${dup.similarity.toFixed(4)}  [${dup.reason}]`
      : `  -> unique, safe to store`);
  }
})();
