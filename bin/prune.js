#!/usr/bin/env node
'use strict';
// Remove things from the library, keeping the index consistent.
//
// Deleting an image alone would leave an orphaned sidecar and a stale snapshot, and the shrink
// guard would then refuse to ingest. So every removal here is paired: image + sidecar, then the
// snapshot and the guard baseline are rebuilt from what actually remains.
//
//   node bin/prune.js --dry-run                    # show what would go
//   node bin/prune.js --orphans                    # sidecars whose image is gone
//   node bin/prune.js --dups                       # files marked dup-of-*
//   node bin/prune.js --id scr_x --id scr_y        # specific screenshots
//   node bin/prune.js --match attribution-probe    # by title substring (from the sidecar)
//   node bin/prune.js --orphans --dups --match probe

const store = require('../lib/store');
const { index, loadCorpus, writeSnapshot, readJsonFile } = store;
const config = require('../lib/config');

function parseArgs(argv) {
  const o = { ids: [], match: [], orphans: false, dups: false, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') o.ids.push(argv[++i]);
    else if (a === '--match') o.match.push(argv[++i].toLowerCase());
    else if (a === '--orphans') o.orphans = true;
    else if (a === '--dups') o.dups = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
  }
  return o;
}

function del(token, label) {
  store.deleteObject(token);
  return label;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.ids.length && !o.match.length && !o.orphans && !o.dups) {
    console.error('nothing selected. use --orphans, --dups, --id <id>, or --match <substring>');
    process.exit(1);
  }

  const idx = index();
  const imgById = new Map(idx.images.map((i) => [i.screenshot_id, i]));
  const targets = [];   // {kind, token, label, screenshot_id?}

  // 1. Specific screenshots, by id or by title substring from the sidecar.
  const wanted = new Set(o.ids);
  if (o.match.length) {
    for (const img of idx.images) {
      const sc = idx.sidecars.get(img.screenshot_id);
      let title = img.step_name || '';
      if (sc) { try { title = readJsonFile(sc.token).title || title; } catch {} }
      const hay = `${title} ${img.filename}`.toLowerCase();
      if (o.match.some((m) => hay.includes(m))) wanted.add(img.screenshot_id);
    }
  }
  for (const id of wanted) {
    const img = imgById.get(id);
    if (!img) { console.log(`? ${id}: not in the index, skipping`); continue; }
    targets.push({ kind: 'image', token: img.token, label: img.filename, screenshot_id: id });
    const sc = idx.sidecars.get(id);
    if (sc) targets.push({ kind: 'sidecar', token: sc.token, label: sc.name, screenshot_id: id });
  }

  // 2. Sidecars whose image no longer exists.
  if (o.orphans) {
    for (const [id, sc] of idx.sidecars) {
      if (!imgById.has(id) && !wanted.has(id)) {
        targets.push({ kind: 'orphan sidecar', token: sc.token, label: sc.name });
      }
    }
  }

  // 3. Drops already judged duplicates and parked with a dup-of- name.
  if (o.dups) {
    for (const f of index().inbox) {
      if (/^dup-of-/i.test(f.name)) targets.push({ kind: 'marked duplicate', token: f.token, label: f.name });
    }
  }

  if (targets.length === 0) { console.log('nothing matched — nothing to remove'); return; }

  const groups = {};
  for (const t of targets) (groups[t.kind] ||= []).push(t);
  console.log(`${targets.length} object(s) selected:\n`);
  for (const [kind, list] of Object.entries(groups)) {
    console.log(`${kind} — ${list.length}`);
    for (const t of list) console.log(`   ${t.label.slice(0, 84)}`);
    console.log();
  }

  if (o.dryRun) { console.log('dry run — nothing deleted'); return; }

  let ok = 0, failed = 0;
  for (const t of targets) {
    try { del(t.token, t.label); ok++; console.log(`deleted  ${t.label.slice(0, 70)}`); }
    catch (e) {
      failed++;
      console.log(`FAILED   ${t.label.slice(0, 60)}`);
      console.log(`         ${e.message.slice(0, 110)}`);
      if (e.missingScopes) { console.log(`         missing scopes: ${e.missingScopes.join(', ')}`); break; }
    }
  }

  // Rebuild the index from what survived, so the shrink guard has an honest baseline.
  if (ok > 0) {
    const fresh = index();
    const { rows } = loadCorpus({ allowShrunkIndex: true });
    const alive = new Set(fresh.images.map((i) => i.screenshot_id));
    writeSnapshot(rows.filter((r) => alive.has(r.screenshot_id)),
                  fresh.snapshot ? fresh.snapshot.token : undefined);
    console.log(`\nindex rebuilt: ${fresh.images.length} screenshot(s) remain`);
    console.log(`guard baseline reset to ${config.read().last_known_count}`);
  }
  console.log(`${ok} deleted${failed ? `, ${failed} failed` : ''}`);
})().catch((e) => {
  console.error('\nfailed:', e.message);
  if (e.missingScopes) console.error('missing Lark scopes:', e.missingScopes.join(', '));
  process.exit(1);
});
