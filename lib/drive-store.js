'use strict';
// Drive-only store. No database: the filename carries every searchable field, a per-screenshot
// sidecar JSON carries what a filename cannot (the 512-dim signature, free-text description),
// and a compacted snapshot keeps dedupe from needing one download per screenshot.
//
// Concurrency: every write creates its OWN file and never mutates shared state, so two people
// uploading at the same moment cannot lose each other's record. The snapshot is only a cache —
// a stale one is detected and topped up from the sidecars it is missing, so racing snapshot
// rebuilds are harmless.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listRoot, searchDrive, downloadFile, uploadBuffer, uploadFile } = require('./lark');
const config = require('./config');
const { encodeName, parseName, searchTerm, metaName, SNAPSHOT_NAME } = require('./naming');

// Every hub object in Drive, classified by filename alone — no downloads.
function index() {
  const files = listRoot().filter((f) => f.type === 'file');
  const images = [];
  const sidecars = new Map();
  const inbox = [];
  let snapshot = null;

  for (const f of files) {
    if (f.name === SNAPSHOT_NAME) { snapshot = f; continue; }
    const parsed = parseName(f.name);
    if (!parsed) {
      // Someone dropped a file straight into the folder from the Lark app. If it looks like an
      // image it is an unprocessed contribution; anything else is left strictly alone.
      // `dup-of-*` are drops already judged duplicates — skipping them keeps a scheduled
      // reconcile from re-downloading and re-reporting the same file every run.
      if (/\.(png|jpe?g|webp)$/i.test(f.name) && !/^dup-of-/i.test(f.name)) inbox.push(f);
      continue;
    }
    if (/\.json$/i.test(f.name) && f.name.includes('__meta__')) {
      sidecars.set(parsed.screenshot_id, f);
    } else {
      images.push({ ...parsed, token: f.token, url: f.url, modified_time: f.modified_time,
                    owner_id: f.owner_id });
    }
  }
  return { images, sidecars, snapshot, inbox };
}

function readJsonFile(token) {
  const tmp = path.join(os.tmpdir(), `hub-dl-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    downloadFile(token, tmp);
    return JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// Signatures for every stored screenshot: snapshot in bulk, sidecars for the tail.
//
// Guarded: if the store previously held screenshots and the listing now returns far fewer, we
// refuse rather than proceed. Proceeding on an empty corpus is silently destructive — dedupe
// would pass everything and the next ingest would re-upload the whole library as "unique".
// Files deleted in the Lark UI, a listing outage, or a mis-set folder token all look identical
// from here, so the safe move is to stop and make a human look.
function loadCorpus({ verbose = false, allowShrunkIndex = false } = {}) {
  const idx = index();

  const lastKnown = Number(config.read().last_known_count || 0);
  const now = idx.images.length;
  if (!allowShrunkIndex && lastKnown > 0 && now < lastKnown) {
    const gone = lastKnown - now;
    const err = new Error(
      `the hub index shrank: expected at least ${lastKnown} screenshot(s), the store now lists ${now} (${gone} missing).\n\n` +
      `  Refusing to continue — ingesting now would treat existing screenshots as new and duplicate the library.\n\n` +
      `  Likely causes:\n` +
      `    - files were deleted or trashed in the Lark UI (check Drive > Trash and restore)\n` +
      `    - hub.config.json folder_token points at the wrong folder\n` +
      `    - a transient Lark listing failure — retry in a minute\n\n` +
      `  If the shrink is intentional, re-run with --allow-shrunk-index to accept it and reset the baseline.`
    );
    err.indexShrunk = { lastKnown, now };
    throw err;
  }
  const corpus = new Map();

  if (idx.snapshot) {
    try {
      const snap = readJsonFile(idx.snapshot.token);
      for (const row of snap.rows || []) corpus.set(row.screenshot_id, row);
      if (verbose) console.log(`  snapshot: ${corpus.size} signatures in 1 download`);
    } catch (e) {
      if (verbose) console.log(`  snapshot unreadable (${e.message}) — falling back to sidecars`);
    }
  }

  const missing = idx.images.filter((i) => !corpus.has(i.screenshot_id) && idx.sidecars.has(i.screenshot_id));
  if (verbose && missing.length) console.log(`  topping up ${missing.length} sidecar(s) not yet in the snapshot`);
  for (const img of missing) {
    try {
      corpus.set(img.screenshot_id, readJsonFile(idx.sidecars.get(img.screenshot_id).token));
    } catch (e) {
      if (verbose) console.log(`  ! sidecar for ${img.screenshot_id} unreadable: ${e.message}`);
    }
  }

  // Filenames alone still carry dhash + aspect, enough for near-identical detection even
  // when a signature is missing entirely.
  for (const img of idx.images) {
    if (!corpus.has(img.screenshot_id)) {
      corpus.set(img.screenshot_id, { screenshot_id: img.screenshot_id, dhash: img.dhash, aspect: img.aspect });
    }
  }

  return { rows: [...corpus.values()], index: idx };
}

// Store one screenshot: the image (named for search) plus its sidecar.
function put(localFile, meta) {
  const filename = encodeName({ ...meta, ext: path.extname(localFile).slice(1) || 'jpg' });
  const image = uploadFile(localFile, filename);

  const sidecar = {
    ...meta,
    filename,
    drive_file_token: image.file_token,
    drive_url: image.url,
    bytes: image.size,
    stored_at: new Date().toISOString(),
  };
  uploadBuffer(Buffer.from(JSON.stringify(sidecar, null, 2)), metaName(meta.screenshot_id));

  return { filename, image, sidecar };
}

// Rebuild the compacted snapshot so the next dedupe pass is a single download.
function writeSnapshot(rows, existingToken) {
  const payload = {
    version: 1,
    built_at: new Date().toISOString(),
    count: rows.length,
    rows: rows.map((r) => ({
      screenshot_id: r.screenshot_id,
      dhash: r.dhash,
      aspect: r.aspect,
      structure_sig: r.structure_sig,
      collection_path: r.collection_path,
      platform: r.platform,
      title: r.title,
    })),
  };
  const res = uploadBuffer(Buffer.from(JSON.stringify(payload)), SNAPSHOT_NAME, { fileToken: existingToken });
  // Baseline for the shrink guard, plus the token so the snapshot stays reachable without listing.
  config.write({ last_known_count: rows.length, snapshot_token: res.file_token });
  return res;
}

// Search filters the root index rather than trusting Drive's search payload: root listing
// returns every entry with its FULL name in one unpaginated call, whereas search results carry
// only a truncated title. Same filename index either way — this one just can't lose the tail
// of a long name.
function search(query = {}) {
  const { images } = index();
  return images.filter((row) => {
    if (query.id && row.screenshot_id !== query.id) return false;
    if (query.platform && row.platform !== String(query.platform).toLowerCase()) return false;
    if (query.app && !(row.app_name || '').includes(String(query.app).toLowerCase())) return false;
    if (query.version && (row.app_version || '') !== String(query.version).toLowerCase()) return false;
    if (query.collection) {
      const want = String(query.collection).toLowerCase().replace(/^\/+|\/+$/g, '');
      if (!(row.collection_path || '').startsWith(want)) return false;
    }
    if (query.tag && !(row.tags || []).includes(String(query.tag).toLowerCase())) return false;
    if (query.step && !(row.step_name || '').includes(String(query.step).toLowerCase())) return false;
    if (query.uploader && (row.uploader || '') !== String(query.uploader).toLowerCase()) return false;
    if (query.month && !(row.captured_stamp || '').startsWith(String(query.month))) return false;
    return true;
  });
}

// Server-side narrowing, for when the library grows past comfortable local filtering.
// Returns tokens; join them against index() for accurate metadata.
function searchTokens(query) {
  return searchDrive(searchTerm(query)).map((r) => r.token);
}

// Delete one stored object by its Drive token. Needs space:document:delete, which this
// tenant does not grant — hence the local backend being the default.
function deleteObject(token) {
  const { run } = require('./lark');
  run(['drive', '+delete', '--file-token', token, '--type', 'file', '--yes']);
  return true;
}

module.exports = { index, loadCorpus, put, writeSnapshot, search, searchTokens, readJsonFile, deleteObject };
