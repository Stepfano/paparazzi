#!/usr/bin/env node
'use strict';
// Bridge a hand-sorted folder of screenshots into the library.
//
// Pairs with the raw inbox watcher (bin/inbox-watch.js): screenshots land unsorted in
// Downloads/Paparazzi/Inbox, you drag them into named folders (Flight, Hotel, Flight + Hotel,
// ...), then this ingests one such folder — filename becomes the step name, folder name becomes
// the collection, same dedupe as everything else.
//
//   node bin/ingest-folder.js "~/Downloads/Paparazzi/Flight + Hotel"
//   node bin/ingest-folder.js <dir> --collection "competitors/Ctrip/Flight + Hotel"
//   node bin/ingest-folder.js <dir> --app ctrip --tags bundle,promo --dry-run

const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadCorpus, put, writeSnapshot } = require('../lib/store');
const { computeSignature } = require('../lib/signature');
const { newId, encodeSig, findDuplicate } = require('../lib/record');

const THRESHOLD = Number(process.env.HUB_THRESHOLD || 0.85);
const config = require('../lib/config');
const DEDUPE_ENABLED = config.read().dedupe_enabled !== false;

function parseArgs(argv) {
  const o = { dir: null, collection: null, tags: [], app: '', version: '', platform: 'android',
              dryRun: false, force: false, allowShrunk: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') o.collection = argv[++i];
    else if (a === '--tags') o.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--app') o.app = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--platform') o.platform = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--allow-shrunk-index') o.allowShrunk = true;
    else if (!o.dir) o.dir = a;
  }
  return o;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.dir) {
    console.error('usage: node bin/ingest-folder.js <dir> [--collection p] [--tags a,b] ' +
                   '[--app name] [--version v] [--platform p] [--dry-run] [--force]');
    process.exit(1);
  }
  const dir = path.resolve(o.dir.replace(/^~/, os.homedir()));
  if (!fs.statSync(dir).isDirectory()) { console.error(`not a directory: ${dir}`); process.exit(1); }

  const collection = o.collection || path.basename(dir);
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
  if (files.length === 0) { console.log('no images in this folder'); return; }

  console.log(`folder: ${dir}`);
  console.log(`collection: ${collection}`);
  console.log(`${files.length} image(s)\n`);

  const { rows } = loadCorpus({ allowShrunkIndex: o.allowShrunk });
  const known = [...rows];
  let stored = 0, skipped = 0;

  for (const name of files) {
    const file = path.join(dir, name);
    const step = path.basename(name, path.extname(name));
    const sig = await computeSignature(file);
    const dup = DEDUPE_ENABLED ? findDuplicate(sig, known, THRESHOLD) : null;

    if (dup && !o.force) {
      console.log(`= ${name}: duplicate of ${dup.screenshot_id} (${dup.similarity.toFixed(3)}) — skipped`);
      skipped++;
      continue;
    }
    if (o.dryRun) { console.log(`+ ${name}: would ingest as "${step}"`); continue; }

    const rec = {
      screenshot_id: newId(),
      title: step,
      description: '',
      tags: o.tags,
      collection_path: collection,
      platform: o.platform,
      app_name: o.app,
      app_package: '',
      app_version: o.version,
      version_source: o.version ? 'declared' : 'unknown',
      step_name: step,
      order: undefined,
      captured_at: fs.statSync(file).mtimeMs,
      device_model: '', os_version: '',
      width: sig.width, height: sig.height, aspect: sig.aspect,
      bytes: fs.statSync(file).size,
      mime: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
      dhash: sig.dhash,
      structure_sig: encodeSig(sig.structure),
      duplicate_of: '', similarity: 0,
    };
    put(file, rec);
    known.push(rec);
    console.log(`+ ${name}: ${rec.screenshot_id}  ${sig.width}x${sig.height}`);
    stored++;
  }

  if (!o.dryRun) writeSnapshot(known);
  console.log(`\n${stored} ingested, ${skipped} duplicate(s) skipped`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
