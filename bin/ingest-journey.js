#!/usr/bin/env node
'use strict';
// Bridge from competitor-screenshot-insights-android into the hub.
//
// That skill captures an ordered journey into a directory:
//   screenshots/<slug>/00-launch.png … 08-promo-code-panel.png  +  target.json
//
// This reads the whole folder, derives app metadata from target.json, preserves the capture
// order, and ingests every frame with dedupe.
//
//   node bin/ingest-journey.js ../screenshots/tripcom-novotel-bsd-2026-09-04
//   node bin/ingest-journey.js <dir> --collection "competitors/Trip.com/Novotel BSD"
//   node bin/ingest-journey.js <dir> --dry-run

const fs = require('fs');
const path = require('path');
const { loadCorpus, put, writeSnapshot } = require('../lib/store');
const { computeSignature } = require('../lib/signature');
const { newId, encodeSig, findDuplicate } = require('../lib/record');

const THRESHOLD = Number(process.env.HUB_THRESHOLD || 0.85);
const config = require('../lib/config');
const DEDUPE_ENABLED = config.read().dedupe_enabled !== false;
const FRAME_RE = /^(\d+)[-_](.+)\.(png|jpe?g|webp)$/i;

function parseArgs(argv) {
  const o = { dir: null, collection: null, tags: [], desc: '', version: '',
              dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') o.collection = argv[++i];
    else if (a === '--tags') o.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--desc') o.desc = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--allow-shrunk-index') o.allowShrunk = true;
    else if (!o.dir) o.dir = a;
  }
  return o;
}

// A journey slug like "tripcom-novotel-bsd-2026-09-04" carries the app and subject, and
// often a trailing date. Turn it into a sensible collection path.
function collectionFromSlug(slug, app) {
  const withoutDate = slug.replace(/[-_]\d{4}-\d{2}-\d{2}$/, '');
  const appSlug = (app || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  let subject = withoutDate;
  if (appSlug && withoutDate.toLowerCase().startsWith(appSlug)) {
    subject = withoutDate.slice(appSlug.length).replace(/^[-_]+/, '');
  }
  const appPart = app ? app : withoutDate.split(/[-_]/)[0];
  return ['competitors', appPart, subject || 'journey'].filter(Boolean).join('/');
}

function readTarget(dir) {
  const p = path.join(dir, 'target.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.dir) {
    console.error('usage: node bin/ingest-journey.js <journey-dir> [--collection p] [--tags a,b] [--version V] [--dry-run] [--force]');
    process.exit(1);
  }
  const dir = path.resolve(o.dir);
  if (!fs.statSync(dir).isDirectory()) { console.error(`not a directory: ${dir}`); process.exit(1); }

  const slug = path.basename(dir);
  const target = readTarget(dir);
  const app = target && target.target ? target.target.app : '';
  const pkg = target && (target.target && target.target.bundle_id) ||
              (target && target.observed && target.observed.foreground_bundle) || '';
  const collection = o.collection || collectionFromSlug(slug, app);

  const frames = fs.readdirSync(dir)
    .map((f) => ({ file: f, m: FRAME_RE.exec(f) }))
    .filter((x) => x.m)
    .map((x) => ({ file: x.file, order: Number(x.m[1]), step: x.m[2] }))
    .sort((a, b) => a.order - b.order);

  console.log(`journey:    ${slug}`);
  console.log(`app:        ${app || '(unknown)'}${pkg ? `  [${pkg}]` : ''}`);
  console.log(`collection: ${collection}`);
  console.log(`frames:     ${frames.length}\n`);
  if (frames.length === 0) { console.error('no NN-name.png frames found'); process.exit(1); }

  console.log('indexing the hub…');
  const { rows, index: idx } = loadCorpus({ allowShrunkIndex: o.allowShrunk });
  const known = [...rows];
  console.log(`  ${idx.images.length} already stored\n`);

  let stored = 0, skipped = 0;
  for (const fr of frames) {
    const full = path.join(dir, fr.file);
    const sig = await computeSignature(full);
    const dup = DEDUPE_ENABLED ? findDuplicate(sig, known, THRESHOLD) : null;

    if (dup && !o.force) {
      console.log(`${String(fr.order).padStart(2,'0')} ${fr.step.padEnd(26)} duplicate of ${dup.screenshot_id} (${dup.similarity.toFixed(3)}) — skipped`);
      skipped++;
      continue;
    }
    if (o.dryRun) {
      console.log(`${String(fr.order).padStart(2,'0')} ${fr.step.padEnd(26)} ${dup ? 'duplicate' : 'unique'} ${sig.width}x${sig.height}`);
      continue;
    }

    const meta = {
      screenshot_id: newId(),
      title: fr.file,
      description: o.desc || `${app || slug} — ${fr.step.replace(/-/g, ' ')}`,
      tags: o.tags.length ? o.tags : ['journey', slug.replace(/[-_]\d{4}-\d{2}-\d{2}$/, '')],
      collection_path: collection,
      platform: 'android',
      app_name: app || '',
      app_package: pkg || '',
      app_version: o.version || '',
      version_source: o.version ? 'declared' : 'unknown',
      order: fr.order,
      step_name: fr.step,
      captured_at: fs.statSync(full).mtimeMs,
      uploader_email: process.env.HUB_UPLOADER || '',
      width: sig.width, height: sig.height, aspect: sig.aspect,
      bytes: fs.statSync(full).size,
      mime: /\.png$/i.test(fr.file) ? 'image/png' : 'image/jpeg',
      dhash: sig.dhash,
      structure_sig: encodeSig(sig.structure),
      duplicate_of: dup ? dup.screenshot_id : '',
      similarity: dup ? dup.similarity : 0,
    };

    put(full, meta);
    known.push(meta);
    stored++;
    console.log(`${String(fr.order).padStart(2,'0')} ${fr.step.padEnd(26)} stored ${meta.screenshot_id}`);
  }

  if (stored > 0) {
    writeSnapshot(known, idx.snapshot ? idx.snapshot.token : undefined);
    console.log(`\nsnapshot updated (${known.length} rows)`);
  }
  console.log(`${stored} stored, ${skipped} skipped as duplicates`);
})().catch((e) => { console.error('\nfailed:', e.message); process.exit(1); });
