'use strict';
// hub.config.json read/write. Holds where the hub lives and how many screenshots it last
// contained — the latter is what makes an unexpectedly empty index detectable.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'hub.config.json');

function read() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function write(patch) {
  const next = { ...read(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

module.exports = { read, write, CONFIG_PATH };
