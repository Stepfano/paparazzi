#!/usr/bin/env node
'use strict';
// Move every hub object into a dedicated folder.
//
//   node bin/organize.js <folder-url-or-token> [--dry-run]
//
// Folder *creation* needs the drive:drive scope, which is not granted — create the folder in the
// Lark UI and pass its URL here. Moving only needs space:document:move, which is granted.
//
// Afterwards, point the store at that folder:
//   export HUB_FOLDER_TOKEN=<token>

const { listRoot, moveToFolder, tokenFromUrl } = require('../lib/lark');
const { SNAPSHOT_NAME } = require('../lib/naming');

const arg = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!arg) {
  console.error('usage: node bin/organize.js <folder-url-or-token> [--dry-run]');
  console.error('\ncreate the folder in the Lark UI first (folder creation needs a scope we lack),');
  console.error('then pass its URL, e.g.');
  console.error('  node bin/organize.js https://traveloka.sg.larksuite.com/drive/folder/XXXX');
  process.exit(1);
}

const folderToken = arg.startsWith('http') ? tokenFromUrl(arg) : arg;
if (!folderToken) {
  console.error(`could not read a folder token from: ${arg}`);
  process.exit(1);
}

// Read from wherever the store currently points (root, unless HUB_FOLDER_TOKEN is already set).
const files = listRoot();
const ours = files.filter((f) => f.name === SNAPSHOT_NAME || f.name.startsWith('hub__'));

if (ours.length === 0) {
  console.log('nothing to move — no hub files found where the store is currently pointed');
  process.exit(0);
}

console.log(`moving ${ours.length} hub object(s) into folder ${folderToken}\n`);
let moved = 0, failed = 0;

for (const f of ours) {
  const label = f.name.length > 70 ? f.name.slice(0, 67) + '…' : f.name;
  if (dryRun) { console.log(`  would move  ${label}`); continue; }
  try {
    moveToFolder(f.token, folderToken, 'file');
    moved++;
    console.log(`  moved       ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAILED      ${label}`);
    console.log(`              ${e.message}`);
    if (e.missingScopes) console.log(`              missing scopes: ${e.missingScopes.join(', ')}`);
  }
}

if (!dryRun) {
  console.log(`\n${moved} moved, ${failed} failed`);
  if (moved > 0) {
    console.log(`\nNow point the store at the folder — add this to your shell profile:`);
    console.log(`  export HUB_FOLDER_TOKEN=${folderToken}`);
    console.log(`\nThen verify:  HUB_FOLDER_TOKEN=${folderToken} node bin/search.js --all`);
  }
}
