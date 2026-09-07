#!/usr/bin/env node
'use strict';
// Search the hub. Every indexed dimension lives in the filename, so this is a Drive
// title search under the hood.
//
//   node bin/search.js --platform android
//   node bin/search.js --app agoda --version 12.3.0
//   node bin/search.js --collection competitors/agoda
//   node bin/search.js --tag pricing
//   node bin/search.js --month 202609
//   node bin/search.js --all
//
// Multiple filters: Drive matches one substring, so the first filter is pushed to the server
// and the rest are applied locally to the returned set.

const { search } = require('../lib/store');

const KEYS = ['platform', 'app', 'version', 'collection', 'tag', 'month', 'id'];

function parseArgs(argv) {
  const q = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].replace(/^--/, '');
    if (KEYS.includes(a)) q[a] = argv[++i];
    else if (a === 'all') q.all = true;
  }
  return q;
}

const q = parseArgs(process.argv.slice(2));
const hits = search(q.all ? {} : q);

if (hits.length === 0) {
  console.log('no matches');
} else {
  console.log(`${hits.length} match(es):\n`);
  console.table(hits.map((r) => ({
    id: r.screenshot_id,
    collection: r.collection_path,
    platform: r.platform,
    app: r.app_name || '-',
    version: r.app_version || '-',
    captured: r.captured_stamp || '-',
    tags: (r.tags || []).join(','),
  })));
}
