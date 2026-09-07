'use strict';
// Thin wrapper over lark-cli. Kept separate so the proxy can later swap in direct
// HTTP calls against Lark OpenAPI without touching the hub logic.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = process.env.LARK_CLI || 'lark-cli';

// Where the hub lives in Drive. Resolution order: env var (for one-off overrides),
// then hub.config.json next to the package, then Drive root.
const CONFIG_PATH = path.join(__dirname, '..', 'hub.config.json');
let configCache;
function config() {
  if (configCache === undefined) {
    try { configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
    catch { configCache = {}; }
  }
  return configCache;
}

function run(args, { cwd = os.tmpdir() } = {}) {
  let out;
  try {
    out = execFileSync(CLI, [...args, '--format', 'json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      // execFileSync inherits stderr by default, which leaks the CLI's pagination
      // progress lines into our output. Capture it and surface it only on failure.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // lark-cli reports API and validation failures as JSON on stderr with a non-zero exit.
    const body = (e.stderr || e.stdout || '').toString().trim();
    let detail = null;
    try { detail = JSON.parse(body).error; } catch {}
    const err = new Error(
      `lark-cli ${args.slice(0, 2).join(' ')}: ${detail ? detail.message : body || e.message}`
    );
    err.detail = detail;
    if (detail && detail.missing_scopes) err.missingScopes = detail.missing_scopes;
    throw err;
  }
  const parsed = JSON.parse(out);
  if (parsed.ok === false) {
    const e = parsed.error || {};
    const err = new Error(`lark-cli ${args.slice(0, 2).join(' ')}: ${e.message || 'failed'}`);
    err.detail = e;
    throw err;
  }
  return parsed.data;
}

// Base record listing comes back column-oriented: `fields` names the columns and
// `data` holds one array per row. Zip them into plain objects.
function rowsToObjects(data) {
  const names = data.fields || [];
  const rows = data.data || [];
  const ids = data.record_id_list || [];
  return rows.map((row, i) => {
    const o = { _record_id: ids[i] };
    names.forEach((name, j) => { o[name] = flatten(row[j]); });
    return o;
  });
}

// Lark cell values arrive in several shapes; reduce them to primitives.
function flatten(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (v.length === 0) return null;
    if (typeof v[0] === 'object' && v[0] !== null) return v[0].text ?? v[0].name ?? v[0];
    return v.length === 1 ? v[0] : v;
  }
  return v;
}

const PAGE = 200;   // hard server maximum for +record-list

// Reads every page. The dedupe check needs all stored signatures, so partial reads
// would silently weaken it.
function listRecords(baseToken, tableId, { max = Infinity } = {}) {
  const all = [];
  let offset = 0;
  for (;;) {
    const data = run(['base', '+record-list', '--base-token', baseToken, '--table-id', tableId,
      '--limit', String(PAGE), '--offset', String(offset)]);
    const page = rowsToObjects(data);
    all.push(...page);
    if (!data.has_more || page.length === 0 || all.length >= max) break;
    offset += page.length;
  }
  return { rows: all, complete: all.length < max };
}

function createRecords(baseToken, tableId, fieldMaps) {
  const tmp = path.join(os.tmpdir(), `hub-create-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ create_records: fieldMaps }));
  try {
    return run(['base', '+record-batch-create', '--base-token', baseToken,
      '--table-id', tableId, '--json', `@${tmp}`]);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function uploadToDrive(localPath, name) {
  // lark-cli restricts --file to cwd, /tmp or ~/files, so stage the file in /tmp.
  const staged = path.join(os.tmpdir(), `hub-up-${Date.now()}-${path.basename(localPath)}`);
  fs.copyFileSync(localPath, staged);
  try {
    return run(['drive', '+upload', '--file', staged, '--name', name || path.basename(localPath)]);
  } finally {
    fs.unlinkSync(staged);
  }
}

module.exports = { run, listRecords, createRecords, uploadToDrive, rowsToObjects, flatten };

// ---- Drive primitives for the Drive-only store ----

// Lists the hub's home. Root listing returns everything unpaginated (documented API
// behaviour); a named folder IS paginated, so that path pages through with --page-all.
// HUB_FOLDER_TOKEN points the store at a dedicated folder; unset means Drive root.
const HUB_FOLDER = () => process.env.HUB_FOLDER_TOKEN || config().folder_token || '';

function listRoot() {
  const folder = HUB_FOLDER();
  const args = folder
    ? ['drive', 'files', 'list', '--folder-token', folder, '--page-all', '--page-limit', '0']
    : ['drive', 'files', 'list'];
  const data = run(args);
  const files = data.files || data.items || [];
  return files.map((f) => ({
    name: f.name,
    type: f.type,
    url: f.url,
    // The CLI redacts `token` in listings, but the URL's last segment is the token.
    token: f.token && f.token !== '[REDACTED]' ? f.token : tokenFromUrl(f.url),
    // Who uploaded it — this is what lets contributions be attributed without any auth work.
    owner_id: f.owner_id || null,
    modified_time: Number(f.modified_time) * 1000 || null,
    created_time: Number(f.created_time) * 1000 || null,
  }));
}

// Move a Drive object into a folder. Needs space:document:move, which IS granted
// (unlike drive:drive, which folder *creation* requires).
function moveToFolder(fileToken, folderToken, type = 'file') {
  return run(['drive', '+move', '--file-token', fileToken, '--folder-token', folderToken,
    '--type', type]);
}

function tokenFromUrl(url) {
  const m = String(url || '').match(/\/([A-Za-z0-9]{20,})(?:\?|$)/);
  return m ? m[1] : null;
}

// Drive search returns hits under `data.results`, with the filename only in
// `title_highlighted` — wrapped in <h> tags AND truncated for long names. So this returns
// tokens, and callers resolve accurate metadata from the root index.
function searchDrive(query) {
  const data = run(['drive', '+search', '--query', query]);
  return (data.results || []).map((r) => {
    const meta = r.result_meta || {};
    return {
      token: meta.token || tokenFromUrl(meta.url),
      url: meta.url,
      file_type: meta.file_type,
      // Truncated and tag-wrapped: usable as a hint, never as the real name.
      titleHint: String(r.title_highlighted || '').replace(/<\/?h>/g, ''),
    };
  });
}

function downloadFile(fileToken, outPath) {
  run(['drive', '+download', '--file-token', fileToken, '--output', outPath, '--overwrite']);
  return outPath;
}

// Every write must land in the same place reads come from, or the store goes split-brain:
// uploads in Drive root while the index reads a folder means dedupe sees an empty library.
function uploadArgs(stagedPath, name, fileToken) {
  const args = ['drive', '+upload', '--file', stagedPath, '--name', name];
  if (fileToken) {
    // Overwriting in place keeps the file where it already is; a folder token would conflict.
    args.push('--file-token', fileToken);
  } else {
    const folder = HUB_FOLDER();
    if (folder) args.push('--folder-token', folder);
  }
  return args;
}

// Passing an existing file token overwrites that file in place, keeping its token stable.
function uploadBuffer(buf, name, { fileToken } = {}) {
  const staged = path.join(os.tmpdir(), `hub-buf-${Date.now()}-${name}`);
  fs.writeFileSync(staged, buf);
  try {
    return run(uploadArgs(staged, name, fileToken));
  } finally {
    fs.unlinkSync(staged);
  }
}

// Upload a local file into the hub's configured home.
function uploadFile(localPath, name) {
  const staged = path.join(os.tmpdir(), `hub-up-${Date.now()}-${name}`);
  fs.copyFileSync(localPath, staged);
  try {
    return run(uploadArgs(staged, name, null));
  } finally {
    fs.unlinkSync(staged);
  }
}

module.exports.listRoot = listRoot;
module.exports.searchDrive = searchDrive;
module.exports.downloadFile = downloadFile;
module.exports.uploadBuffer = uploadBuffer;
module.exports.uploadFile = uploadFile;
module.exports.tokenFromUrl = tokenFromUrl;
module.exports.moveToFolder = moveToFolder;
module.exports.HUB_FOLDER = HUB_FOLDER;

// Resolve a Lark open_id to a display name, so contributions can be attributed.
// Cached per process; failures degrade to the raw id rather than blocking ingestion.
const _people = new Map();
function resolveUser(openId) {
  if (!openId) return null;
  if (_people.has(openId)) return _people.get(openId);
  let name = null;
  try {
    const d = run(['contact', '+get-user', '--user-id', openId]);
    const u = d.user || d;
    name = u.name || u.en_name || null;
  } catch { name = null; }
  _people.set(openId, name);
  return name;
}

module.exports.resolveUser = resolveUser;
