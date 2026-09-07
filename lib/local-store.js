'use strict';
// Local filesystem store: same interface as the Lark Drive store, backed by a directory.
//
// Chosen when hub.config.json has storage:"local". Everything the Drive store gave us is kept —
// the filename index, sidecars, snapshot, dedupe — minus the network, the OAuth token that
// expires, and the delete scope we could never get. Images serve straight off disk, so the
// plugin sees them instantly instead of after a Drive round trip.

const fs = require('fs');
const path = require('path');
const { encodeName, parseName, metaName, SNAPSHOT_NAME } = require('./naming');
const config = require('./config');

function root() {
  const dir = process.env.HUB_LOCAL_DIR || config.read().local_dir ||
              path.join(__dirname, '..', 'library');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Every object in the library, classified by filename alone.
function index() {
  const dir = root();
  const images = [];
  const sidecars = new Map();
  const inbox = [];
  let snapshot = null;

  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;

    if (name === SNAPSHOT_NAME) { snapshot = { name, token: full, path: full }; continue; }

    const parsed = parseName(name);
    if (!parsed) {
      // A file dropped in by hand. Images are unprocessed contributions; leave the rest alone.
      if (/\.(png|jpe?g|webp)$/i.test(name) && !/^dup-of-/i.test(name)) {
        inbox.push({ name, token: full, path: full, modified_time: fs.statSync(full).mtimeMs });
      }
      continue;
    }
    if (/\.json$/i.test(name) && name.includes('__meta__')) {
      sidecars.set(parsed.screenshot_id, { name, token: full, path: full });
    } else {
      images.push({ ...parsed, token: full, path: full, url: 'file://' + full,
                    modified_time: fs.statSync(full).mtimeMs });
    }
  }
  return { images, sidecars, snapshot, inbox };
}

const readJsonFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function loadCorpus({ verbose = false, allowShrunkIndex = false } = {}) {
  const idx = index();

  // Same guard as the Drive store: an index that lost entries must not be treated as an empty
  // library, or the next ingest re-adds everything as new.
  const lastKnown = Number(config.read().last_known_count || 0);
  if (!allowShrunkIndex && lastKnown > 0 && idx.images.length < lastKnown) {
    const err = new Error(
      `the library index shrank: expected at least ${lastKnown}, found ${idx.images.length}.\n` +
      `  Refusing to continue — ingesting now would duplicate existing screenshots.\n` +
      `  If files were removed deliberately, re-run with --allow-shrunk-index.`
    );
    err.indexShrunk = true;
    throw err;
  }

  const corpus = new Map();
  if (idx.snapshot) {
    try {
      for (const row of (readJsonFile(idx.snapshot.path).rows || [])) corpus.set(row.screenshot_id, row);
      if (verbose) console.log(`  snapshot: ${corpus.size} signature(s)`);
    } catch { /* rebuilt from sidecars below */ }
  }
  for (const img of idx.images) {
    if (corpus.has(img.screenshot_id)) continue;
    const sc = idx.sidecars.get(img.screenshot_id);
    if (sc) { try { corpus.set(img.screenshot_id, readJsonFile(sc.path)); continue; } catch {} }
    corpus.set(img.screenshot_id, { screenshot_id: img.screenshot_id, dhash: img.dhash, aspect: img.aspect });
  }
  return { rows: [...corpus.values()], index: idx };
}

function put(localFile, meta) {
  const dir = root();
  const filename = encodeName({ ...meta, ext: path.extname(localFile).slice(1) || 'jpg' });
  const dest = path.join(dir, filename);
  fs.copyFileSync(localFile, dest);

  const sidecar = { ...meta, filename, path: dest, bytes: fs.statSync(dest).size,
                    stored_at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, metaName(meta.screenshot_id)), JSON.stringify(sidecar, null, 2));
  return { filename, image: { file_token: dest, url: 'file://' + dest, size: sidecar.bytes }, sidecar };
}

function writeSnapshot(rows) {
  const payload = {
    version: 1, built_at: new Date().toISOString(), count: rows.length,
    rows: rows.map((r) => ({
      screenshot_id: r.screenshot_id, dhash: r.dhash, aspect: r.aspect,
      structure_sig: r.structure_sig, collection_path: r.collection_path,
      platform: r.platform, title: r.title,
    })),
  };
  fs.writeFileSync(path.join(root(), SNAPSHOT_NAME), JSON.stringify(payload));
  config.write({ last_known_count: rows.length });
  return { file_token: path.join(root(), SNAPSHOT_NAME) };
}

function search(query = {}) {
  return index().images.filter((row) => {
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

// Local files need no download step; the "token" IS the path.
const imagePath = (row) => row.path || row.token;

// Deleting is trivial locally — the thing the Lark backend could never do.
function remove(screenshotId) {
  const idx = index();
  const img = idx.images.find((i) => i.screenshot_id === screenshotId);
  const sc = idx.sidecars.get(screenshotId);
  let removed = 0;
  if (img && fs.existsSync(img.path)) { fs.unlinkSync(img.path); removed++; }
  if (sc && fs.existsSync(sc.path)) { fs.unlinkSync(sc.path); removed++; }
  return removed;
}

// Delete one stored object by its handle. Locally the handle IS the path.
function deleteObject(token) {
  if (fs.existsSync(token)) { fs.unlinkSync(token); return true; }
  return false;
}

module.exports = { index, loadCorpus, put, writeSnapshot, search, readJsonFile, imagePath, remove, deleteObject, root };
