'use strict';
// Packing the structural signature into something a Lark Base text field can hold,
// and building the record payload for the screenshots table.

const path = require('path');
const { computeSignature, compare } = require('./signature');

// Pearson correlation is scale-invariant, so we can divide by the max and quantise to
// one byte per block with no effect on the comparison — 512 floats become 684 base64 chars.
function encodeSig(structure) {
  const max = Math.max(...structure) || 1;
  const q = Buffer.alloc(structure.length);
  for (let i = 0; i < structure.length; i++) {
    q[i] = Math.max(0, Math.min(255, Math.round((structure[i] / max) * 255)));
  }
  return q.toString('base64');
}

function decodeSig(b64) {
  const q = Buffer.from(b64, 'base64');
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] / 255;
  return out;
}

// Sortable, collision-resistant id: time prefix + randomness, no dependency.
function newId(when = Date.now()) {
  const t = when.toString(36).padStart(9, '0');
  let r = '';
  for (let i = 0; i < 10; i++) r += '0123456789abcdefghijklmnopqrstuvwxyz'[(Math.random() * 36) | 0];
  return `scr_${t}${r}`;
}

// Filename patterns are a weak signal, used only when the client declares nothing.
function inferPlatform(filename) {
  const f = path.basename(filename);
  if (/^Screenshot[_-]/i.test(f) || /^Screenshot_\d{4}/.test(f)) return 'android';
  if (/^IMG_\d+\.(png|jpe?g)$/i.test(f)) return 'ios';
  if (/^\d{9,}\.(png|jpe?g)$/i.test(f)) return 'android';   // Lark/Android media ids
  return 'unknown';
}

async function buildRecord(filePath, meta = {}) {
  const sig = await computeSignature(filePath);
  const now = Date.now();

  return {
    fields: {
      screenshot_id: meta.screenshot_id || newId(now),
      title: meta.title || path.basename(filePath),
      description: meta.description || '',
      tags: (meta.tags || []).join(','),
      platform: meta.platform || inferPlatform(meta.title || filePath),
      app_name: meta.app_name || '',
      app_package: meta.app_package || '',
      app_version: meta.app_version || '',
      version_source: meta.app_version ? (meta.version_source || 'declared') : 'unknown',
      collection_path: meta.collection_path || 'inbox',
      captured_at: meta.captured_at || now,
      uploader_email: meta.uploader_email || '',
      device_id: meta.device_id || '',
      device_model: meta.device_model || '',
      os_version: meta.os_version || '',
      width: sig.width,
      height: sig.height,
      aspect: sig.aspect,
      bytes: meta.bytes || require('fs').statSync(filePath).size,
      mime: meta.mime || '',
      drive_file_token: meta.drive_file_token || '',
      drive_url: meta.drive_url || '',
      dhash: sig.dhash,
      structure_sig: encodeSig(sig.structure),
      duplicate_of: '',
      similarity: 0,
    },
    signature: sig,
  };
}

// Compare a new signature against rows already in the Base.
function findDuplicate(sig, rows, threshold = 0.85) {
  let best = null;
  for (const row of rows) {
        if (!row.structure_sig) continue;
    const other = { structure: decodeSig(row.structure_sig), dhash: row.dhash, aspect: row.aspect };
    const r = compare(sig, other, threshold);
    if (r.duplicate && (!best || r.structural > best.similarity)) {
      best = { screenshot_id: row.screenshot_id, similarity: r.structural, reason: r.reason };
    }
  }
  return best;
}

// Lark Base cell-value shapes differ per field type: select wants an array, datetime wants
// "YYYY-MM-DD HH:mm", and system/attachment fields must never be written as plain values.
const SELECT_FIELDS = new Set(['platform', 'version_source']);
const DATETIME_FIELDS = new Set(['captured_at', 'last_seen']);
const SKIP_FIELDS = new Set(['uploaded_at', 'registered_at', 'thumbnail']);

function fmtDateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Canonical record fields -> the flat field map `create_records` expects.
function toLarkFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SKIP_FIELDS.has(k)) continue;
    if (v === '' || v === null || v === undefined) continue;
    if (SELECT_FIELDS.has(k)) out[k] = [String(v)];
    else if (DATETIME_FIELDS.has(k)) out[k] = typeof v === 'number' ? fmtDateTime(v) : v;
    else out[k] = v;
  }
  return out;
}

module.exports = { encodeSig, decodeSig, newId, inferPlatform, buildRecord, findDuplicate, toLarkFields, fmtDateTime };
