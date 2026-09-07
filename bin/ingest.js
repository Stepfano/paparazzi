#!/usr/bin/env node
'use strict';
// Ingest screenshots into the Drive-backed hub.
//
//   node bin/ingest.js <file...> [--collection competitors/agoda] [--app Agoda] [--version 12.3.0]
//                                [--platform android] [--tags a,b] [--desc "..."] [--dry-run] [--force]
//   node bin/ingest.js --snapshot          # rebuild the compacted dedupe index
//
// Dedupe is checked before anything is written; a suspected duplicate is reported and skipped
// unless --force, in which case it is stored with duplicate_of/similarity recorded.

const fs = require('fs');
const path = require('path');
const { loadCorpus, put, writeSnapshot } = require('../lib/store');
const { computeSignature } = require('../lib/signature');
const { newId, inferPlatform, encodeSig, findDuplicate } = require('../lib/record');

const THRESHOLD = Number(process.env.HUB_THRESHOLD || 0.85);
const config = require('../lib/config');
const DEDUPE_ENABLED = config.read().dedupe_enabled !== false;

function parseArgs(argv) {
  const o = { files: [], collection: 'inbox', tags: [], desc: '', dryRun: false, force: false,
              snapshotOnly: false, app: '', version: '', platform: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') o.collection = argv[++i];
    else if (a === '--tags') o.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--desc') o.desc = argv[++i];
    else if (a === '--app') o.app = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--allow-shrunk-index') o.allowShrunk = true;
    else if (a === '--snapshot') o.snapshotOnly = true;
    else o.files.push(a);
  }
  return o;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));

  console.log('indexing the hub from Drive filenames…');
  const { rows, index: idx } = loadCorpus({ verbose: true, allowShrunkIndex: o.allowShrunk });
  console.log(`  ${idx.images.length} screenshot(s) stored, ${rows.filter(r => r.structure_sig).length} with signatures\n`);

  if (o.snapshotOnly) {
    const res = writeSnapshot(rows, idx.snapshot ? idx.snapshot.token : undefined);
    console.log(`snapshot rebuilt: ${rows.length} rows -> ${res.file_token}`);
    return;
  }

  if (o.files.length === 0) {
    console.error('usage: node bin/ingest.js <file...> [--collection p] [--app A] [--version V]');
    console.error('                                    [--platform android|ios] [--tags a,b] [--desc "..."]');
    console.error('                                    [--dry-run] [--force]   |   --snapshot');
    process.exit(1);
  }

  const known = [...rows];
  let stored = 0, skipped = 0;

  for (const file of o.files) {
    const base = path.basename(file);
    if (!fs.existsSync(file)) { console.log(`${base}: not found, skipping`); continue; }

    const sig = await computeSignature(file);
    const dup = DEDUPE_ENABLED ? findDuplicate(sig, known, THRESHOLD) : null;

    if (dup && !o.force) {
      console.log(`${base}: DUPLICATE of ${dup.screenshot_id} — ${dup.similarity.toFixed(3)}, ${dup.reason}`);
      console.log(`  skipped; re-run with --force to store it anyway`);
      skipped++;
      continue;
    }
    if (o.dryRun) {
      console.log(`${base}: ${dup ? 'duplicate' : 'unique'} (${sig.width}x${sig.height}) — dry run, nothing written`);
      continue;
    }

    const meta = {
      screenshot_id: newId(),
      title: base,
      description: o.desc,
      tags: o.tags,
      collection_path: o.collection,
      platform: o.platform || inferPlatform(base),
      app_name: o.app,
      app_version: o.version,
      version_source: o.version ? 'declared' : 'unknown',
      captured_at: fs.statSync(file).mtimeMs,
      uploader_email: process.env.HUB_UPLOADER || '',
      width: sig.width,
      height: sig.height,
      aspect: sig.aspect,
      dhash: sig.dhash,
      structure_sig: encodeSig(sig.structure),
      duplicate_of: dup ? dup.screenshot_id : '',
      similarity: dup ? dup.similarity : 0,
    };

    const res = put(file, meta);
    known.push(meta);
    stored++;
    console.log(`${base}: stored ${meta.screenshot_id}`);
    console.log(`  ${res.filename}`);
  }

  if (stored > 0) {
    const res = writeSnapshot(known, idx.snapshot ? idx.snapshot.token : undefined);
    console.log(`\nsnapshot updated (${known.length} rows)`);
  }
  console.log(`${stored} stored, ${skipped} skipped as duplicates`);
})().catch((e) => {
  console.error('\nfailed:', e.message);
  if (e.missingScopes) console.error('missing Lark scopes:', e.missingScopes.join(', '));
  process.exit(1);
});
