#!/usr/bin/env node
'use strict';
// Multi-user ingestion with zero setup for contributors.
//
// Anyone with edit access to the Paparazzi Drive folder can drop screenshots straight in from the
// Lark app — desktop or phone. They need no repo, no CLI, no lark-cli auth, no config. This picks
// up whatever landed, attributes it to whoever uploaded it (Drive reports owner_id per file),
// dedupes it against the library, renames it into the searchable scheme and writes its sidecar.
//
//   node bin/reconcile.js --dry-run
//   node bin/reconcile.js
//   node bin/reconcile.js --collection "competitors/Agoda" --tags pricing
//
// Run it on a schedule (cron, or the /loop skill) and the library keeps itself tidy.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { index, loadCorpus, writeSnapshot, put } = require('../lib/drive-store');
const { downloadFile, resolveUser, run } = require('../lib/lark');
const { computeSignature } = require('../lib/signature');
const { newId, encodeSig, findDuplicate, inferPlatform } = require('../lib/record');
const { encodeName, metaName, slug } = require('../lib/naming');
const { uploadBuffer } = require('../lib/lark');

const THRESHOLD = Number(process.env.HUB_THRESHOLD || 0.85);

function parseArgs(argv) {
  const o = { collection: 'inbox', tags: [], dryRun: false, force: false, allowShrunk: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') o.collection = argv[++i];
    else if (a === '--tags') o.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--allow-shrunk-index') o.allowShrunk = true;
  }
  return o;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));

  const idx = index();
  console.log(`folder holds ${idx.images.length} managed screenshot(s)`);
  console.log(`unprocessed drops: ${idx.inbox.length}\n`);

  if (idx.inbox.length === 0) {
    console.log('nothing to reconcile — every image in the folder is already indexed');
    return;
  }

  const { rows } = loadCorpus({ allowShrunkIndex: o.allowShrunk });
  const known = [...rows];
  let stored = 0, skipped = 0, failed = 0;

  for (const file of idx.inbox) {
    const who = resolveUser(file.owner_id);
    const label = `${file.name.slice(0, 40)}  (${who || file.owner_id || 'unknown uploader'})`;

    const local = path.join(os.tmpdir(), `hub-rec-${Date.now()}-${file.name}`);
    try {
      downloadFile(file.token, local);
    } catch (e) {
      failed++;
      console.log(`! ${label}: download failed — ${e.message.slice(0, 70)}`);
      continue;
    }

    try {
      const sig = await computeSignature(local);
      const dup = findDuplicate(sig, known, THRESHOLD);

      if (dup && !o.force) {
        console.log(`= ${label}`);
        console.log(`    duplicate of ${dup.screenshot_id} (${dup.similarity.toFixed(3)}, ${dup.reason})`);
        if (o.dryRun) { skipped++; continue; }
        // Mark it so a scheduled run does not re-download and re-report this file forever.
        // The name says what it duplicates, so a human can confirm before deleting it in Lark.
        const marked = `dup-of-${dup.screenshot_id}__${file.name}`;
        try {
          run(['drive', '+update-title', '--token', file.token, '--type', 'file', '--title', marked]);
          console.log(`    marked as ${marked.slice(0, 60)}… — delete it in Lark when you agree`);
        } catch (e) {
          console.log(`    could not mark it (${e.message.slice(0, 60)}) — will be re-checked next run`);
        }
        skipped++;
        continue;
      }
      if (o.dryRun) {
        console.log(`+ ${label}: would ingest, ${sig.width}x${sig.height}`);
        continue;
      }

      const meta = {
        screenshot_id: newId(),
        title: file.name,
        description: '',
        tags: o.tags,
        collection_path: o.collection,
        platform: inferPlatform(file.name),
        app_name: '', app_package: '', app_version: '', version_source: 'unknown',
        captured_at: file.modified_time || Date.now(),
        uploader: slug(who || file.owner_id || 'unknown'),
        uploader_open_id: file.owner_id || '',
        width: sig.width, height: sig.height, aspect: sig.aspect,
        bytes: fs.statSync(local).size,
        mime: /\.png$/i.test(file.name) ? 'image/png' : 'image/jpeg',
        dhash: sig.dhash,
        structure_sig: encodeSig(sig.structure),
        duplicate_of: dup ? dup.screenshot_id : '',
        similarity: dup ? dup.similarity : 0,
      };

      // Rename the file the contributor already uploaded rather than re-uploading its bytes:
      // the blob is fine where it is, it just needs an indexed name and a sidecar.
      const filename = encodeName({ ...meta, ext: path.extname(file.name).slice(1) || 'jpg' });
      run(['drive', '+update-title', '--token', file.token, '--type', 'file', '--title', filename]);
      uploadBuffer(
        Buffer.from(JSON.stringify({ ...meta, filename, drive_file_token: file.token,
                                     drive_url: file.url, stored_at: new Date().toISOString() }, null, 2)),
        metaName(meta.screenshot_id)
      );

      known.push(meta);
      stored++;
      console.log(`+ ${label}`);
      console.log(`    ${meta.screenshot_id}  uploader=${meta.uploader}  ${sig.width}x${sig.height}`);
    } finally {
      if (fs.existsSync(local)) fs.unlinkSync(local);
    }
  }

  if (stored > 0) {
    const fresh = index();
    writeSnapshot(known, fresh.snapshot ? fresh.snapshot.token : undefined);
    console.log(`\nsnapshot updated`);
  }
  console.log(`${stored} ingested, ${skipped} duplicates left in place` + (failed ? `, ${failed} failed` : ''));
})().catch((e) => {
  console.error('\nfailed:', e.message);
  if (e.missingScopes) console.error('missing Lark scopes:', e.missingScopes.join(', '));
  process.exit(1);
});
