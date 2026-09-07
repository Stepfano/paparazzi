'use strict';
// Picks the storage backend. `storage` in hub.config.json: "local" (default) or "lark".
//
// Both backends expose the same interface, so bin/* and serve.js never know which is in use.
// Lark is kept intact rather than deleted — switching back is a one-line config change.

const config = require('./config');
const backend = (process.env.HUB_STORAGE || config.read().storage || 'local').toLowerCase();

const impl = backend === 'lark' ? require('./drive-store') : require('./local-store');

// The Drive backend needs a download step; the local one serves straight off disk.
if (!impl.imagePath) {
  const os = require('os'), path = require('path'), fs = require('fs');
  const { downloadFile } = require('./lark');
  const cache = path.join(os.tmpdir(), 'hub-image-cache');
  impl.imagePath = (row) => {
    fs.mkdirSync(cache, { recursive: true });
    const p = path.join(cache, `${row.screenshot_id}.${row.ext || 'jpg'}`);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) downloadFile(row.token, p);
    return p;
  };
}

module.exports = { ...impl, backend };
