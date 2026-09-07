#!/usr/bin/env node
'use strict';
// Rename stored screenshots so their filenames match the current naming scheme.
//
// The filename IS the index, so a change to the scheme (a new field, a fixed separator) leaves
// existing files encoded the old way. This recomputes each name from its sidecar — the sidecar
// holds the full metadata, so it is the source of truth — and renames only what differs.
//
//   node bin/reindex.js --dry-run
//   node bin/reindex.js

const { index, readJsonFile, writeSnapshot, loadCorpus } = require('../lib/store');
const { encodeName } = require('../lib/naming');
const { run } = require('../lib/lark');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const idx = index();
  console.log(`${idx.images.length} screenshot(s) stored, ${idx.sidecars.size} sidecar(s)\n`);

  let renamed = 0, same = 0, noSidecar = 0, failed = 0;

  for (const img of idx.images) {
    const sc = idx.sidecars.get(img.screenshot_id);
    if (!sc) {
      noSidecar++;
      console.log(`? ${img.screenshot_id}: no sidecar, cannot recompute — left alone`);
      continue;
    }

    let meta;
    try { meta = readJsonFile(sc.token); }
    catch (e) { failed++; console.log(`! ${img.screenshot_id}: sidecar unreadable (${e.message})`); continue; }

    const want = encodeName({ ...meta, ext: img.ext });
    if (want === img.filename) { same++; continue; }

    console.log(`~ ${img.screenshot_id}`);
    console.log(`    old: ${img.filename}`);
    console.log(`    new: ${want}`);
    if (dryRun) { renamed++; continue; }

    try {
      run(['drive', '+update-title', '--token', img.token, '--type', 'file', '--title', want]);
      // Keep the sidecar's own record of the filename accurate.
      const { uploadBuffer } = require('../lib/lark');
      const { metaName } = require('../lib/naming');
      uploadBuffer(Buffer.from(JSON.stringify({ ...meta, filename: want }, null, 2)),
                   metaName(img.screenshot_id), { fileToken: sc.token });
      renamed++;
    } catch (e) {
      failed++;
      console.log(`    FAILED: ${e.message}`);
    }
  }

  console.log(`\n${renamed} ${dryRun ? 'would be renamed' : 'renamed'}, ${same} already correct` +
              (noSidecar ? `, ${noSidecar} without a sidecar` : '') +
              (failed ? `, ${failed} failed` : ''));

  if (!dryRun && renamed > 0) {
    const { rows, index: fresh } = loadCorpus({ allowShrunkIndex: true });
    writeSnapshot(rows, fresh.snapshot ? fresh.snapshot.token : undefined);
    console.log(`snapshot rebuilt (${rows.length} rows)`);
  }
})().catch((e) => { console.error('\nfailed:', e.message); process.exit(1); });
