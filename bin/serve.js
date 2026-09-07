#!/usr/bin/env node
'use strict';
// Local hub API for the Figma plugin.
//
// Lark's OpenAPI sends no CORS headers and needs an Authorization header, so a browser context
// — which a Figma plugin's UI iframe is — cannot call it directly. This is that missing piece,
// running on the same machine as an already-authenticated lark-cli. No cloud, no credentials in
// the plugin bundle.
//
//   node bin/serve.js            # http://localhost:8899
//
//   GET /v1/health
//   GET /v1/collections                        folder tree
//   GET /v1/screenshots?collection=&platform=&app=&version=&tag=&step=&month=&q=
//   GET /v1/image/:id                          image bytes (cached on disk)
//   GET /v1/live?after=<cursor>                screenshots added since a cursor

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const { search, index } = store;
const config = require('../lib/config');
const { computeSignature } = require('../lib/signature');
const { newId, encodeSig, findDuplicate } = require('../lib/record');
const QRCode = require('qrcode');
const { execSync, spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8899);

function lanIp() {
  for (const ifaces of Object.values(require('os').networkInterfaces())) {
    for (const i of ifaces || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'this-machine';
}

// Best-effort human label for the QR code — falls back to the LAN IP if unavailable.
function friendlyName() {
  try {
    if (process.platform === 'darwin') {
      const n = execSync('scutil --get ComputerName', { timeout: 2000 }).toString().trim();
      if (n) return n;
    }
  } catch {}
  return require('os').hostname() || lanIp();
}

function lanUrl() { return `http://${lanIp()}:${PORT}`; }
const CACHE_DIR = path.join(os.tmpdir(), 'hub-image-cache');
const INDEX_TTL_MS = 15_000;   // Drive listings are slow; serve a short-lived cached index

fs.mkdirSync(CACHE_DIR, { recursive: true });

let indexCache = { at: 0, rows: [] };

// The phone-driven auto-capture watcher (bin/capture.js --mode auto), managed as a child
// process so the phone page can start/stop it remotely instead of needing a Mac terminal.
let watcher = { proc: null, startedAt: null, collection: '', tags: '', log: [], error: null };
const WATCHER_LOG_MAX = 40;

function watcherLog(line) {
  watcher.log.push({ t: Date.now(), line });
  if (watcher.log.length > WATCHER_LOG_MAX) watcher.log.shift();
}

function startWatcher({ collection, tags }) {
  if (watcher.proc) return { ok: false, error: 'already running' };
  const args = ['bin/capture.js', '--mode', 'auto'];
  if (collection) args.push('--collection', collection);
  if (tags) args.push('--tags', tags);

  const child = spawn('node', args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  watcher = { proc: child, startedAt: Date.now(), collection: collection || '', tags: tags || '', log: [], error: null };

  const onOut = (buf) => { for (const l of buf.toString().split('\n')) if (l.trim()) watcherLog(l.trim()); };
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) watcher.error = `exited with code ${code}`;
    watcher.proc = null;
  });
  return { ok: true, pid: child.pid };
}

function stopWatcher() {
  if (!watcher.proc) return { ok: false, error: 'not running' };
  watcher.proc.kill('SIGINT');   // capture.js flushes its snapshot on SIGINT before exiting
  return { ok: true };
}

function rows({ force = false } = {}) {
  if (!force && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.rows;
  const all = search({});
  indexCache = { at: Date.now(), rows: all };
  return all;
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
};
const json = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });

// Public shape for one screenshot. Deliberately excludes the Drive token: the plugin
// addresses images by screenshot_id and never sees a Lark credential or file handle.
const publicRow = (r) => ({
  id: r.screenshot_id,
  collection: r.collection_path || 'inbox',
  platform: r.platform || 'unknown',
  app: r.app_name || null,
  version: r.app_version || null,
  order: r.order ?? null,
  step: r.step_name || null,
  captured: r.captured_stamp || null,
  tags: r.tags || [],
  aspect: r.aspect ?? null,
  image: `/v1/image/${r.screenshot_id}`,
});

// Folder tree from the flat collection paths.
function tree(all) {
  const counts = new Map();
  for (const r of all) {
    const parts = (r.collection_path || 'inbox').split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([p, count]) => ({
      path: p,
      name: p.split('/').pop(),
      depth: p.split('/').length - 1,
      count,
      direct: all.filter((r) => (r.collection_path || 'inbox') === p).length,
    }));
}

// The store decides where bytes come from: a local path, or a cached Drive download.
function imageBytes(id) {
  const row = rows().find((r) => r.screenshot_id === id);
  if (!row) return null;
  const p = store.imagePath(row);
  if (!fs.existsSync(p)) return null;
  return { buf: fs.readFileSync(p), ext: row.ext || 'jpg', local: store.backend === 'local' };
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sniffExt(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0,4).toString() === 'RIFF' && buf.subarray(8,12).toString() === 'WEBP') return 'webp';
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    // Any phone-side client pushes here: a custom app, an automation app, or the web page.
    // Body is the raw image bytes; metadata rides on the query string.
    if (req.method === 'POST' && p === '/v1/upload') {
      let buf;
      try { buf = await readBody(req); }
      catch (e) { return json(res, 413, { error: e.message }); }

      const ext = sniffExt(buf);
      if (!ext) return json(res, 415, { error: 'body is not a PNG, JPEG or WebP image' });

      const tmp = path.join(os.tmpdir(), `hub-up-${Date.now()}.${ext}`);
      fs.writeFileSync(tmp, buf);
      try {
        const q = (k, d = '') => url.searchParams.get(k) || d;
        const sig = await computeSignature(tmp);
        const { rows } = store.loadCorpus({ allowShrunkIndex: true });
        const dedupeOn = config.read().dedupe_enabled !== false;
        const dup = dedupeOn ? findDuplicate(sig, rows, Number(config.read().dedupe_threshold || 0.85)) : null;
        if (dup && q('force') !== '1') {
          return json(res, 200, { ok: true, duplicate: true, duplicateOf: dup.screenshot_id,
                                  similarity: dup.similarity, reason: dup.reason });
        }
        const rec = {
          screenshot_id: newId(),
          title: q('name', `upload-${Date.now()}.${ext}`),
          description: q('desc'),
          tags: q('tags') ? q('tags').split(',').map((t) => t.trim()).filter(Boolean) : [],
          collection_path: q('collection', 'inbox'),
          platform: q('platform', 'android'),
          app_name: q('app'), app_package: q('package'), app_version: q('version'),
          version_source: q('version') ? 'declared' : 'unknown',
          step_name: q('step'),
          captured_at: Number(q('captured')) || Date.now(),
          device_model: q('device'), os_version: q('os'),
          width: sig.width, height: sig.height, aspect: sig.aspect,
          bytes: buf.length, mime: ext === 'png' ? 'image/png' : 'image/jpeg',
          dhash: sig.dhash, structure_sig: encodeSig(sig.structure),
          duplicate_of: dup ? dup.screenshot_id : '', similarity: dup ? dup.similarity : 0,
        };
        store.put(tmp, rec);
        store.writeSnapshot([...rows, rec]);
        indexCache.at = 0;                       // force the next read to see it
        console.log(`[+] ${rec.screenshot_id}  ${rec.title}  ${sig.width}x${sig.height}` +
                    (rec.app_package ? `  [${rec.app_package}]` : ''));
        return json(res, 201, { ok: true, id: rec.screenshot_id, width: sig.width, height: sig.height });
      } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      }
    }

    if (p === '/v1/health') {
      const cfg = config.read();
      return json(res, 200, {
        ok: true,
        backend: store.backend,
        library: store.root ? store.root() : (cfg.folder_url || null),
        screenshots: rows().length,
        threshold: cfg.dedupe_threshold ?? null,
      });
    }

    if (p === '/v1/watcher/status') {
      return json(res, 200, {
        running: !!watcher.proc,
        pid: watcher.proc ? watcher.proc.pid : null,
        startedAt: watcher.startedAt,
        collection: watcher.collection,
        tags: watcher.tags,
        error: watcher.error,
        log: watcher.log.slice(-10),
      });
    }

    if (req.method === 'POST' && p === '/v1/watcher/start') {
      const collection = url.searchParams.get('collection') || '';
      const tags = url.searchParams.get('tags') || '';
      const r = startWatcher({ collection, tags });
      return json(res, r.ok ? 200 : 409, r);
    }

    if (req.method === 'POST' && p === '/v1/watcher/stop') {
      const r = stopWatcher();
      return json(res, r.ok ? 200 : 409, r);
    }

    // What a phone should point at to reach THIS hub, and a friendly label for it — used to
    // build the QR code and to let a scanning phone label the entry sensibly instead of a
    // generic "This hub" for every laptop it has ever scanned.
    if (p === '/v1/lan') {
      return json(res, 200, { url: lanUrl(), name: friendlyName() });
    }

    // A QR code encoding this hub's own LAN address. Scanning it with a phone camera opens
    // the upload page as a normal top-level navigation — not a fetch from an HTTPS context,
    // so the mixed-content restriction that affects the Figma plugin iframe does not apply here.
    if (p === '/v1/qrcode') {
      const target = `${lanUrl()}/?hubname=${encodeURIComponent(friendlyName())}`;
      try {
        const png = await QRCode.toBuffer(target, { type: 'png', width: 320, margin: 2 });
        return send(res, 200, png, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      } catch (e) {
        return json(res, 500, { error: 'could not render QR: ' + e.message });
      }
    }

    if (p === '/v1/collections') return json(res, 200, { collections: tree(rows()) });

    if (p === '/v1/screenshots') {
      const q = {};
      for (const k of ['collection', 'platform', 'app', 'version', 'tag', 'step', 'month', 'id']) {
        const v = url.searchParams.get(k);
        if (v) q[k] = v;
      }
      let hits = search(q);
      // Free-text `q` matches the indexed fields we do have, since Drive never indexed
      // descriptions for binary files.
      const text = (url.searchParams.get('q') || '').toLowerCase().trim();
      if (text) {
        hits = hits.filter((r) => [r.step_name, r.app_name, r.collection_path,
          (r.tags || []).join(' '), r.screenshot_id]
          .filter(Boolean).join(' ').toLowerCase().includes(text));
      }
      hits.sort((a, b) => (a.collection_path || '').localeCompare(b.collection_path || '') ||
                          (a.order ?? 99) - (b.order ?? 99) ||
                          String(a.captured_stamp).localeCompare(String(b.captured_stamp)));
      return json(res, 200, { count: hits.length, screenshots: hits.map(publicRow) });
    }

    if (p === '/v1/live') {
      // Cursor is the highest screenshot_id already seen; ids are time-prefixed so they sort.
      const after = url.searchParams.get('after') || '';
      const all = rows({ force: true });
      const fresh = all.filter((r) => r.screenshot_id > after)
                       .sort((a, b) => a.screenshot_id.localeCompare(b.screenshot_id));
      const cursor = all.reduce((m, r) => (r.screenshot_id > m ? r.screenshot_id : m), after);
      return json(res, 200, { cursor, count: fresh.length, screenshots: fresh.map(publicRow) });
    }

    const m = p.match(/^\/v1\/image\/([A-Za-z0-9_]+)$/);
    if (m) {
      const got = imageBytes(m[1]);
      if (!got) return json(res, 404, { error: 'no such screenshot' });
      return send(res, 200, got.buf, {
        'Content-Type': MIME[got.ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
        'X-Hub-Backend': store.backend,
      });
    }

    // `/` is the phone-facing upload page — the zero-install way to get screenshots in.
    if (p === '/' || p === '/mobile') {
      const mob = path.join(__dirname, '..', 'web', 'mobile.html');
      if (fs.existsSync(mob)) {
        return send(res, 200, fs.readFileSync(mob), { 'Content-Type': 'text/html; charset=utf-8' });
      }
    }

    // Dev affordance: the plugin UI in a normal browser. Figma loads ui.html from the bundle.
    if (p === '/dev/ui') {
      const uiPath = path.join(__dirname, '..', 'figma-plugin', 'ui.html');
      if (fs.existsSync(uiPath)) {
        return send(res, 200, fs.readFileSync(uiPath), { 'Content-Type': 'text/html; charset=utf-8' });
      }
    }

    return json(res, 404, { error: 'not found', endpoints: [
      '/v1/health', '/v1/lan', '/v1/qrcode', '/v1/collections', '/v1/screenshots',
      '/v1/image/:id', '/v1/live', 'POST /v1/upload',
      '/v1/watcher/status', 'POST /v1/watcher/start', 'POST /v1/watcher/stop'] });
  } catch (e) {
    return json(res, 500, { error: e.message, missingScopes: e.missingScopes || undefined });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Check it:   curl http://localhost:${PORT}/v1/health`);
    console.error(`  Free it:    lsof -ti tcp:${PORT} | xargs kill`);
    console.error(`  Other port: PORT=8900 node bin/serve.js\n`);
    process.exit(1);
  }
  throw err;
});

const HOST = process.env.HUB_BIND || '0.0.0.0';

server.listen(PORT, HOST, () => {
  const cfg = config.read();
  console.log(`\n  Hub API on http://localhost:${PORT}`);
  console.log(`  From your phone: http://${lanIp()}:${PORT}    (POST /v1/upload)`);
  console.log(`  Drive folder: ${cfg.folder_url || cfg.folder_token || '(root)'}`);
  console.log(`  Image cache:  ${CACHE_DIR}`);
  console.log(`\n  Add to the Figma plugin manifest allowedDomains:`);
  console.log(`    "http://localhost:${PORT}"\n`);
});
