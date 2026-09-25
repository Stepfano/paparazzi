#!/usr/bin/env node
'use strict';
// Raw phone -> a plain local folder (default: Downloads/Paparazzi/Inbox). No dedupe, no
// filename encoding, no library index — just the new screenshot, as-is, so it's ready to drag
// straight into Figma or anywhere else.
//
// The destination is configurable, not just the historical default, because it lives outside
// the project (Downloads) and gets renamed by hand as work is organized (e.g. to Trademark/) —
// a hardcoded path would silently recreate an empty folder at the old name after a rename.
//
//   node bin/inbox-watch.js                       keep watching for new phone screenshots
//   node bin/inbox-watch.js --dest ~/Downloads/Trademark/Inbox
//   HUB_INBOX_DIR=~/Downloads/Trademark/Inbox node bin/inbox-watch.js
//   node bin/inbox-watch.js --backfill            also pull whatever is already on the phone
//   node bin/inbox-watch.js --interval 2          poll every 2s instead of the 1s default

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PHONE_DIRS = ['/sdcard/Pictures/Screenshots', '/sdcard/DCIM/Screenshots'];
const DEFAULT_DEST_DIR = path.join(os.homedir(), 'Downloads', 'Paparazzi', 'Inbox');
const LOCK = path.join(__dirname, '..', '.inbox-watch.lock');

function acquireLock() {
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    const alive = pid && (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    if (alive) {
      console.error(`another inbox watcher is already running (pid ${pid})`);
      process.exit(1);
    }
  }
  fs.writeFileSync(LOCK, String(process.pid));
}

function releaseLock() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8').trim()) === process.pid) fs.unlinkSync(LOCK); }
  catch {}
}

function parseArgs(argv) {
  const o = { interval: 1, backfill: false, serial: null,
              dest: process.env.HUB_INBOX_DIR || DEFAULT_DEST_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interval') o.interval = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--backfill') o.backfill = true;
    else if (a === '--serial') o.serial = argv[++i];
    else if (a === '--dest') o.dest = argv[++i].replace(/^~/, os.homedir());
  }
  return o;
}

function adb(args, serial, { allowFail = false } = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  try {
    return execFileSync('adb', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return '';
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
      throw new Error(`device ${preferred} is not connected`);
    }
    return preferred;
  }
  if (usable.length === 0) {
    throw new Error('no authorised Android device — plug in and accept the debugging prompt');
  }
  return usable[0].serial;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  acquireLock();
  fs.mkdirSync(o.dest, { recursive: true });

  const serial = pickDevice(o.serial);
  console.log(`device: ${serial}`);
  console.log(`destination: ${o.dest}`);

  const dirs = PHONE_DIRS.filter((d) =>
    adb(['shell', `ls -1 "${d}" 2>/dev/null | head -1`], serial, { allowFail: true }).trim());
  if (dirs.length === 0) { console.error('no screenshot folder found on the device'); process.exit(1); }
  console.log(`watching ${dirs.join(', ')} — take screenshots on the phone; Ctrl+C to stop`);

  const list = (d) => adb(['shell', `ls -1 "${d}" 2>/dev/null`], serial, { allowFail: true })
    .split('\n').map((s) => s.trim()).filter((s) => /\.(png|jpe?g)$/i.test(s));

  const seen = new Set();
  if (!o.backfill) { for (const d of dirs) for (const f of list(d)) seen.add(`${d}/${f}`); }
  console.log(o.backfill ? '(including screenshots already on the phone)\n'
                         : `(ignoring ${seen.size} already on the phone; --backfill to include)\n`);

  let pulled = 0;
  const tick = async () => {
    for (const d of dirs) for (const name of list(d)) {
      const key = `${d}/${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dest = path.join(o.dest, name);
      if (fs.existsSync(dest)) continue;   // already pulled by a previous run
      try {
        adb(['pull', '-a', key, dest]);
        pulled++;
        console.log(`+ ${name}`);
      } catch (e) {
        seen.delete(key);
        console.log(`! ${name}: ${e.message}`);
      }
    }
  };

  await tick();
  const timer = setInterval(() => tick().catch((e) => console.log('! ' + e.message)), o.interval * 1000);
  const bye = () => { clearInterval(timer); releaseLock(); console.log(`\nstopped — ${pulled} pulled this session`); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
})().catch((e) => { releaseLock(); console.error('\n' + e.message); process.exit(1); });
