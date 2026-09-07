'use strict';
// The filename IS the index.
//
// Lark Drive only content-indexes documents, not binary files — for a JPEG it matches the title
// and nothing else. So every field we need to search on has to live in the name. Each field
// carries a short key prefix so a substring search is unambiguous:
//
//   hub__c-competitors.agoda.hotel-detail__a-agoda__v-12.3.0__p-android__d-20260907-1130__
//   ar-0450__h-c88e3238f9f02250__t-pricing.badge__scr_0mtqq5b20jf1ig9v6v8.jpg
//
//   search "p-android"          -> every Android screenshot
//   search "a-agoda"            -> every Agoda screenshot
//   search "c-competitors.agoda"-> that folder and everything under it (substring prefix)
//   search "t-pricing"          -> one tag
//   search "d-202609"           -> one month
//   search "hub__"              -> the whole library
//
// Fields are separated by "__", so "__" is stripped from every value. Single underscores are
// safe, which is why the id (scr_xxx) survives intact.

const SEP = '__';
const PREFIX = 'hub';
const MAX_NAME = 200;          // leave headroom under filesystem/API limits
const LIMITS = { c: 60, a: 24, v: 16, t: 48, s: 32, u: 20 };

// `~` joins multiple values (path levels, tag lists). It is therefore stripped from values,
// while `.` stays a legal character — an app really is called "Trip.com", and treating its dot
// as a path separator invented a phantom folder level.
const JOIN = '~';

// Lowercase, keep [a-z0-9.-], collapse runs, trim separators.
function slug(v, max) {
  let s = String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[\/\\~]+/g, '-')     // separators are not allowed inside a value
    .replace(/[^a-z0-9.\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (max && s.length > max) s = s.slice(0, max).replace(/[-.]+$/, '');
  return s;
}

// A collection path keeps its levels: slug each segment, then join with `~`.
function slugPath(v, max) {
  const joined = String(v == null ? '' : v)
    .split(/[\/\\]+/)
    .map((seg) => slug(seg))
    .filter(Boolean)
    .join(JOIN);
  return max && joined.length > max ? joined.slice(0, max).replace(/[-.~]+$/, '') : joined;
}

function encodeName(meta) {
  const ext = (meta.ext || 'jpg').replace(/^\./, '').toLowerCase();
  const parts = [PREFIX];

  const add = (key, value, max) => {
    const s = slug(value, max);
    if (s) parts.push(`${key}-${s}`);
  };

  {
    const c = slugPath(meta.collection_path || 'inbox', LIMITS.c);
    if (c) parts.push(`c-${c}`);
  }
  add('a', meta.app_name || meta.app_package, LIMITS.a);
  add('v', meta.app_version, LIMITS.v);
  add('p', meta.platform || 'unknown');
  // Journey position, so an ordered capture sequence survives a flat store.
  if (meta.order !== undefined && meta.order !== null && meta.order !== '')
    parts.push(`o-${String(meta.order).padStart(2, '0')}`);
  add('s', meta.step_name, LIMITS.s);
  // Who contributed it — makes "my screenshots" a search, and scopes the live feed.
  add('u', meta.uploader, LIMITS.u);
  if (meta.captured_at) parts.push(`d-${stampOf(meta.captured_at)}`);
  if (meta.aspect) parts.push(`ar-${String(Math.round(meta.aspect * 1000)).padStart(4, '0')}`);
  if (meta.dhash) parts.push(`h-${slug(meta.dhash)}`);
  {
    const t = (meta.tags || []).map((x) => slug(x)).filter(Boolean).join(JOIN);
    if (t) parts.push(`t-${t.slice(0, LIMITS.t).replace(/[-.~]+$/, '')}`);
  }
  parts.push(meta.screenshot_id);

  let name = parts.join(SEP);
  if (name.length + ext.length + 1 > MAX_NAME) {
    // Drop the least load-bearing fields first; the id and hash must always survive.
    const keep = parts.filter((p) => !/^t-/.test(p));
    name = keep.join(SEP);
    if (name.length + ext.length + 1 > MAX_NAME) {
      name = keep.filter((p) => !/^c-/.test(p)).join(SEP);
    }
  }
  return `${name}.${ext}`;
}

function stampOf(when) {
  const d = when instanceof Date ? when : new Date(when);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Recover the metadata a filename carries. Returns null for anything not ours.
function parseName(filename) {
  const m = String(filename).match(/^(.*)\.([a-z0-9]+)$/i);
  const stem = m ? m[1] : String(filename);
  const ext = m ? m[2].toLowerCase() : '';
  const parts = stem.split(SEP);
  if (parts[0] !== PREFIX || parts.length < 2) return null;

  const out = { screenshot_id: parts[parts.length - 1], ext, filename: String(filename), tags: [] };
  for (const p of parts.slice(1, -1)) {
    const i = p.indexOf('-');
    if (i < 1) continue;
    const key = p.slice(0, i), val = p.slice(i + 1);
    switch (key) {
      case 'c': out.collection_path = val.split(JOIN).join('/'); break;
      case 'a': out.app_name = val; break;
      case 'v': out.app_version = val; break;
      case 'p': out.platform = val; break;
      case 'o': out.order = Number(val); break;
      case 's': out.step_name = val; break;
      case 'u': out.uploader = val; break;
      case 'd': out.captured_stamp = val; break;
      case 'ar': out.aspect = Number(val) / 1000; break;
      case 'h': out.dhash = val; break;
      case 't': out.tags = val.split(JOIN).filter(Boolean); break;
    }
  }
  return out;
}

// Turn a user query into the substring Drive should match.
function searchTerm({ collection, app, version, platform, tag, month, id, step, uploader } = {}) {
  if (id) return id;
  if (collection) return `c-${slugPath(collection, LIMITS.c)}`;
  if (step) return `s-${slug(step, LIMITS.s)}`;
  if (uploader) return `u-${slug(uploader, LIMITS.u)}`;
  if (app) return `a-${slug(app, LIMITS.a)}`;
  if (version) return `v-${slug(version, LIMITS.v)}`;
  if (platform) return `p-${slug(platform)}`;
  if (tag) return `t-${slug(tag)}`;
  if (month) return `d-${slug(month)}`;
  return `${PREFIX}${SEP}`;
}

const metaName = (id) => `${PREFIX}${SEP}meta${SEP}${id}.json`;
const SNAPSHOT_NAME = `${PREFIX}${SEP}snapshot.json`;

module.exports = { encodeName, parseName, searchTerm, slug, slugPath, stampOf, metaName, SNAPSHOT_NAME, PREFIX, SEP, JOIN, MAX_NAME };
