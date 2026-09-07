#!/usr/bin/env node
'use strict';
// Phone -> library in one command. Pulls a screenshot straight off the connected Android device
// over adb, dedupes it, and stores it where the Figma plugin can see it.
//
//   node bin/capture.js --mode manual                     one screenshot, right now (default)
//   node bin/capture.js --mode auto                       keep watching for new phone screenshots
//   node bin/capture.js --collection "competitors/Agoda" --step search-results
//   node bin/capture.js --mode manual --n 5 --delay 3      5 shots, 3s apart
//
// --mode auto polls the phone's own screenshot folders, so screenshots YOU take with
// power+volume are picked up automatically — no cable-side commands, no upload step.
// --watch is kept as a synonym for --mode auto, for anything already scripted against it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const { computeSignature } = require('../lib/signature');
const { newId, encodeSig, findDuplicate } = require('../lib/record');

const THRESHOLD = Number(process.env.HUB_THRESHOLD || 0.85);
const config = require('../lib/config');
const DEDUPE_ENABLED = config.read().dedupe_enabled !== false;
const PHONE_DIRS = ['/sdcard/Pictures/Screenshots', '/sdcard/DCIM/Screenshots'];

function parseArgs(argv) {
  const o = { collection: 'inbox', tags: [], step: '', app: '', version: '', serial: null,
              n: 1, delay: 2, watch: false, interval: 1, force: false, allowShrunk: false, backfill: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--collection') o.collection = argv[++i];
    else if (a === '--tags') o.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--step') o.step = argv[++i];
    else if (a === '--app') o.app = argv[++i];
    else if (a === '--version') o.version = argv[++i];
    else if (a === '--serial') o.serial = argv[++i];
    else if (a === '--n') o.n = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--delay') o.delay = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--interval') o.interval = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--mode') {
      const v = argv[++i];
      if (v !== 'manual' && v !== 'auto') {
        console.error(`--mode must be "manual" or "auto", got "${v}"`);
        process.exit(1);
      }
      o.watch = v === 'auto';
    }
    else if (a === '--watch') o.watch = true;   // synonym for --mode auto
    else if (a === '--backfill') o.backfill = true;
    else if (a === '--force') o.force = true;
    else if (a === '--allow-shrunk-index') o.allowShrunk = true;
  }
  return o;
}

function adb(args, serial, { binary = false, allowFail = false } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  try {
    return execFileSync('adb', full, {
      encoding: binary ? 'buffer' : 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    if (allowFail) return binary ? Buffer.alloc(0) : '';
    throw new Error(`adb ${args.slice(0, 2).join(' ')}: ${(e.stderr || e.message).toString().trim()}`);
  }
}

function pickDevice(preferred) {
  const lines = adb(['devices'], null).split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [serial, state] = l.split(/\s+/); return { serial, state }; });
  const usable = lines.filter((d) => d.state === 'device');
  if (preferred) {
    if (!usable.some((d) => d.serial === preferred)) {
      throw new Error(`device ${preferred} is not connected (adb devices shows: ${lines.map(d => d.serial + ':' + d.state).join(', ') || 'nothing'})`);
    }
    return preferred;
  }
  if (usable.length === 0) {
    const detail = lines.length ? lines.map((d) => `${d.serial} (${d.state})`).join(', ') : 'none';
    throw new Error(
      `no authorised Android device. adb sees: ${detail}\n` +
      `  USB:      plug in and accept the debugging prompt\n` +
      `  wireless: adb connect <ip>:<port>  (port is on Settings > Developer options > Wireless debugging)`
    );
  }
  return usable[0].serial;
}

// Ingest a local file. Returns the record, or null when it was a duplicate.
async function ingest(file, o, known, meta = {}) {
  const sig = await computeSignature(file);
  const dup = DEDUPE_ENABLED ? findDuplicate(sig, known, THRESHOLD) : null;
  if (dup && !o.force) return { duplicate: dup, sig };

  const rec = {
    screenshot_id: newId(),
    title: meta.title || path.basename(file),
    description: '',
    tags: o.tags,
    collection_path: o.collection,
    platform: 'android',
    app_name: o.app || meta.app_name || '',
    app_package: meta.app_package || '',
    app_version: o.version || meta.app_version || '',
    version_source: (o.version || meta.app_version) ? 'declared' : 'unknown',
    step_name: o.step || meta.step_name || '',
    order: meta.order,
    captured_at: meta.captured_at || Date.now(),
    device_model: meta.device_model || '',
    os_version: meta.os_version || '',
    width: sig.width, height: sig.height, aspect: sig.aspect,
    bytes: fs.statSync(file).size,
    mime: /\.png$/i.test(file) ? 'image/png' : 'image/jpeg',
    dhash: sig.dhash,
    structure_sig: encodeSig(sig.structure),
    duplicate_of: '', similarity: 0,
  };
  const res = store.put(file, rec);
  known.push(rec);
  return { stored: rec, filename: res.filename, sig };
}

// The foreground app, so app/version are recorded rather than guessed.
function foreground(serial) {
  const out = adb(['shell', 'dumpsys', 'activity', 'activities'], serial, { allowFail: true });
  const m = out.match(/(?:mResumedActivity|topResumedActivity)[^\n]*?\s([a-zA-Z0-9_.]+)\/[^\s]+/);
  if (!m) return {};
  const pkg = m[1];
  const dump = adb(['shell', 'dumpsys', 'package', pkg], serial, { allowFail: true });
  const v = dump.match(/versionName=([^\s]+)/);
  return { app_package: pkg, app_name: pkg.split('.').pop(), app_version: v ? v[1] : '' };
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const serial = pickDevice(o.serial);
  const model = adb(['shell', 'getprop', 'ro.product.model'], serial, { allowFail: true }).trim();
  const osVer = adb(['shell', 'getprop', 'ro.build.version.release'], serial, { allowFail: true }).trim();
  console.log(`device: ${model || serial} (Android ${osVer || '?'})`);
  console.log(`library: ${store.root ? store.root() : '(remote)'}  [${store.backend}]`);

  const { rows } = store.loadCorpus({ allowShrunkIndex: o.allowShrunk });
  const known = [...rows];
  console.log(`${rows.length} already stored\n`);

  const report = (r, label) => {
    if (r.duplicate) {
      console.log(`= ${label}: duplicate of ${r.duplicate.screenshot_id} (${r.duplicate.similarity.toFixed(3)}) — skipped`);
      return 0;
    }
    console.log(`+ ${label}: ${r.stored.screenshot_id}  ${r.sig.width}x${r.sig.height}` +
                (r.stored.app_package ? `  [${r.stored.app_package}${r.stored.app_version ? ' ' + r.stored.app_version : ''}]` : ''));
    return 1;
  };

  let stored = 0;

  if (!o.watch) {
    // Pull the screen directly — nothing is saved on the phone.
    for (let i = 0; i < o.n; i++) {
      const tmp = path.join(os.tmpdir(), `hub-cap-${Date.now()}-${i}.png`);
      fs.writeFileSync(tmp, adb(['exec-out', 'screencap', '-p'], serial, { binary: true }));
      if (fs.statSync(tmp).size === 0) { console.log('! empty capture, skipping'); fs.unlinkSync(tmp); continue; }
      try {
        const fg = foreground(serial);
        stored += report(await ingest(tmp, o, known, { ...fg, device_model: model, os_version: osVer,
                                                       title: `capture-${Date.now()}.png`,
                                                       order: o.n > 1 ? i : undefined }), `shot ${i + 1}/${o.n}`);
      } finally { fs.unlinkSync(tmp); }
      if (i < o.n - 1 && o.delay) await new Promise((r) => setTimeout(r, o.delay * 1000));
    }
  } else {
    // Watch the phone's own screenshot folders: you press power+volume, it lands in the library.
    const dirs = PHONE_DIRS.filter((d) =>
      adb(['shell', `ls -1 "${d}" 2>/dev/null | head -1`], serial, { allowFail: true }).trim());
    if (dirs.length === 0) { console.error('no screenshot folder found on the device'); process.exit(1); }
    console.log(`watching ${dirs.join(', ')} — take screenshots on the phone; Ctrl+C to stop`);

    const seen = new Set();
    const list = (d) => adb(['shell', `ls -1 "${d}" 2>/dev/null`], serial, { allowFail: true })
      .split('\n').map((s) => s.trim()).filter((s) => /\.(png|jpe?g)$/i.test(s));
    if (!o.backfill) { for (const d of dirs) for (const f of list(d)) seen.add(`${d}/${f}`); }
    console.log(o.backfill ? '(including screenshots already on the phone)\n'
                           : `(ignoring ${seen.size} already on the phone; --backfill to include)\n`);

    const tick = async () => {
      for (const d of dirs) for (const name of list(d)) {
        const key = `${d}/${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const tmp = path.join(os.tmpdir(), `hub-pull-${Date.now()}-${name}`);
        try { adb(['pull', '-a', key, tmp], serial); } catch { seen.delete(key); continue; }
        if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) { seen.delete(key); continue; }
        try {
          const fg = foreground(serial);
          stored += report(await ingest(tmp, o, known, { ...fg, device_model: model, os_version: osVer,
                                                         title: name,
                                                         captured_at: fs.statSync(tmp).mtimeMs }), name);
          store.writeSnapshot(known);
        } finally { fs.unlinkSync(tmp); }
      }
    };
    await tick();
    const timer = setInterval(() => tick().catch((e) => console.log('! ' + e.message)), o.interval * 1000);
    const bye = () => { clearInterval(timer); store.writeSnapshot(known);
                        console.log(`\nstopped — ${stored} captured this session`); process.exit(0); };
    process.on('SIGINT', bye); process.on('SIGTERM', bye);
    return;
  }

  store.writeSnapshot(known);
  console.log(`\n${stored} captured`);
})().catch((e) => { console.error('\n' + e.message); process.exit(1); });
