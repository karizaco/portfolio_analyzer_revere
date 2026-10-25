'use strict';

/**
 * Build the best available upload date for every catalogued QMG video.
 *
 * Sources, in decreasing order of trust:
 *
 *   1. `data/qmg_upload_dates.json` — the catalog's own `upload_date`, dumped
 *      from state.sqlite by tools/dumpUploadDates.py. Exact.
 *   2. `data/qmg_date_anchors.json` — the same catalog dates plus the ones
 *      recoverable from scan logs whose video file was named `<date>_<id>.mp4`.
 *      Exact.
 *   3. `data/qmg_extra_dates.json` — hand-probed upload dates for videos the
 *      other sources miss (a single `yt-dlp -J` call each).
 *   4. `data/qmg_tab_dates.tsv` — a flat crawl of the channel's Videos tab
 *      with `--extractor-args youtubetab:approximate_date`. The per-video
 *      timestamp is *approximate*: yt-dlp renders YouTube's "3 years ago"
 *      string as the current day-of-month in that year, so every entry lands
 *      on the same day (2026-10-26 here) and only the YEAR is meaningful.
 *      It is used as a year bucket, not as a date.
 *
 * The playlist (`data/qmg_playlist_full.txt`) is newest-first, so index order
 * is a reliable time axis. Each video is placed by interpolating between the
 * exact anchors that bracket it, with the approximate year as a boundary:
 * a video whose approximate year is Y is never dated outside [Jan 1 of Y,
 * Dec 31 of Y] unless an exact anchor says otherwise.
 *
 * Output: `data/qmg_video_dates.json`
 *   { "<video_id>": { "date": "YYYYMMDD", "confidence": "exact|year|interpolated" } }
 *
 * Usage:
 *   node tools/qmgVideoDates.js
 *   node tools/qmgVideoDates.js --check
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const check = argv.includes('--check');

const PLAYLIST = path.join(ROOT, 'data', 'qmg_playlist_full.txt');
const TAB_DATES = path.join(ROOT, 'data', 'qmg_tab_dates.tsv');
const OUT = path.join(ROOT, 'data', 'qmg_video_dates.json');

// --- Date helpers -------------------------------------------------------------
const DAY = 86400000;
function toMs(s) {
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}
function fromMs(t) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate());
}
function daysBetween(a, b) { return (toMs(b) - toMs(a)) / DAY; }
function addDays(s, n) { return fromMs(toMs(s) + n * DAY); }
function yearStart(y) { return y + '0101'; }
function yearEnd(y) { return y + '1231'; }

// --- Playlist order (newest first) -------------------------------------------
const playlist = fs.readFileSync(PLAYLIST, 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((l) => {
    const m = l.match(/^(\S+)\s+(\S+)\s*(.*)$/);
    return { videoId: m[2], title: m[3] };
  });
const indexOf = new Map();
playlist.forEach((p, i) => { if (!indexOf.has(p.videoId)) indexOf.set(p.videoId, i); });

// --- Approximate tab crawl: video_id -> year ---------------------------------
const approxYear = new Map();
try {
  for (const line of fs.readFileSync(TAB_DATES, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // yt-dlp's --print received "\t" as two characters, not a tab.
    const cols = line.split('\\t');
    const id = cols[0].trim();
    const epoch = parseInt(cols[1], 10);
    if (!id || !Number.isFinite(epoch)) continue;
    approxYear.set(id, fromMs(epoch * 1000).slice(0, 4));
  }
} catch (_) {
  console.log('[dates] no data/qmg_tab_dates.tsv — year buckets unavailable');
}

// --- Exact dates ---------------------------------------------------------------
const exact = new Map();
function loadExact(file, label) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch (_) {
    return 0;
  }
  let n = 0;
  const entries = Array.isArray(j) ? j : Object.entries(j);
  for (const [key, val] of entries) {
    const id = typeof val === 'string' ? key : val.video_id;
    const d = typeof val === 'string' ? val : val.date;
    if (!/^\d{8}$/.test(d || '')) continue;
    if (!indexOf.has(id) || exact.has(id)) continue;
    exact.set(id, d);
    n++;
  }
  console.log('[dates]   ' + label + ': ' + n);
  return n;
}
loadExact('data/qmg_upload_dates.json', 'sqlite upload_date');
loadExact('data/qmg_date_anchors.json', 'scan-log / manifest anchors');
loadExact('data/qmg_extra_dates.json', 'hand-probed dates');

// --- Anchors in playlist-index space ------------------------------------------
// The playlist is strictly newest-first (verified by probing 16 consecutive
// entries against YouTube), so an anchor whose date is NEWER than the anchor
// before it is provably wrong. The catalog's upload_date column is not always
// right — Quo56MNcUxA is catalogued as 20220517 but YouTube says 20211217 —
// so that single check is applied before the anchors are used.
//
// A rate/outlier filter was tried and rejected: QMG's upload rate is irregular
// enough (a two-month gap between two videos is normal) that any smoothness
// test throws away correct dates. The monotonicity check needs no assumption
// about the rate.
const rawAnchors = [];
playlist.forEach((p, i) => {
  const d = exact.get(p.videoId);
  if (d) rawAnchors.push({ index: i, date: d, videoId: p.videoId });
});
rawAnchors.sort((a, b) => a.index - b.index);

const outliers = [];
const anchors = [];
for (const a of rawAnchors) {
  const last = anchors[anchors.length - 1];
  if (last && toMs(a.date) > toMs(last.date)) {
    outliers.push(a);
    continue;   // newer than the previous anchor — the playlist is date-ordered
  }
  anchors.push(a);
}

console.log('[dates] ' + playlist.length + ' playlist videos, ' + exact.size +
  ' exact dates, ' + rawAnchors.length + ' raw anchors, ' + anchors.length +
  ' kept, ' + outliers.length + ' dropped, ' +
  approxYear.size + ' approximate years');
if (outliers.length) {
  console.log('[dates] dropped anchors (catalog date disagrees with playlist order):');
  for (const a of outliers) console.log('[dates]   ' + a.videoId + ' idx=' + a.index + ' claimed ' + a.date);
}

if (anchors.length < 2) {
  console.error('[dates] need at least two anchors');
  process.exit(1);
}

/** The exact anchor at or before `index`, and the one at or after it. */
function bracket(index) {
  let prev = null;
  let next = null;
  for (const a of anchors) {
    if (a.index <= index) prev = a;
    else { next = a; break; }
  }
  return { prev, next };
}

/**
 * Interpolate a date for one playlist index.
 *
 * Between two exact anchors, interpolate linearly in index. Outside the
 * anchor range, fall back to the approximate year's own span.
 */
function dateAt(index) {
  const { prev, next } = bracket(index);
  if (prev && next) {
    const span = next.index - prev.index;
    const frac = span === 0 ? 0 : (index - prev.index) / span;
    const days = daysBetween(prev.date, next.date);
    return addDays(prev.date, Math.round(frac * days));
  }
  const yr = approxYear.get(playlist[index].videoId);
  if (prev) {
    // Older than the last anchor: walk backwards from the anchor, bounded
    // by the approximate year.
    const start = yr ? yearStart(yr) : addDays(prev.date, -365);
    const end = prev.date;
    const span = Math.max(1, next ? next.index - prev.index : 30);
    const frac = Math.min(1, (index - prev.index) / span);
    const d = addDays(end, -Math.round(frac * Math.abs(daysBetween(start, end))));
    return d < start ? start : d;
  }
  const yr2 = approxYear.get(playlist[index].videoId);
  const start = yr2 ? yearStart(yr2) : next.date;
  const end = yr2 ? yearEnd(yr2) : next.date;
  const span = Math.max(1, next.index - (prev ? prev.index : 0));
  const frac = Math.max(0, (index - (prev ? prev.index : 0)) / span);
  const d = addDays(start, Math.round(frac * Math.abs(daysBetween(start, end))));
  return d > end ? end : d;
}

// --- Leave-one-out accuracy ----------------------------------------------------
if (check) {
  let e0 = 0, w1 = 0, w3 = 0, total = 0;
  const errors = [];
  for (let a = 0; a < anchors.length - 1; a++) {
    const prev = a > 0 ? anchors[a - 1] : null;
    const next = a + 1 < anchors.length ? anchors[a + 1] : null;
    if (!prev || !next) continue;
    const span = next.index - prev.index;
    const frac = span === 0 ? 0 : (anchors[a].index - prev.index) / span;
    const days = daysBetween(prev.date, next.date);
    const guess = addDays(prev.date, Math.round(frac * days));
    const err = Math.abs(daysBetween(anchors[a].date, guess));
    total++;
    if (err === 0) e0++;
    if (err <= 1) w1++;
    if (err <= 3) w3++;
    if (err > 7) errors.push(anchors[a].date + ' -> ' + guess + ' (' + err + 'd)');
  }
  console.log('[dates] leave-one-out over ' + total + ' interior anchors:');
  console.log('  exact:        ' + e0 + ' (' + Math.round(100 * e0 / total) + '%)');
  console.log('  within 1 day: ' + w1 + ' (' + Math.round(100 * w1 / total) + '%)');
  console.log('  within 3 days:' + w3 + ' (' + Math.round(100 * w3 / total) + '%)');
  errors.forEach((e) => console.log('    ' + e));
}

// --- Build the output ----------------------------------------------------------
const dates = playlist.map((p, i) => (exact.has(p.videoId) ? exact.get(p.videoId) : dateAt(i)));

// Enforce strict monotonicity (the playlist is strictly newest-first).
for (let i = 1; i < dates.length; i++) {
  if (toMs(dates[i]) > toMs(dates[i - 1])) dates[i] = dates[i - 1];
}

const out = {};
let nExact = 0, nYear = 0, nInterp = 0;
playlist.forEach((p, i) => {
  const yr = approxYear.get(p.videoId);
  let confidence;
  if (exact.has(p.videoId)) { confidence = 'exact'; nExact++; }
  else if (yr && dates[i].slice(0, 4) === yr) { confidence = 'year'; nYear++; }
  else { confidence = 'interpolated'; nInterp++; }
  out[p.videoId] = { date: dates[i], confidence };
});

fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('[dates] wrote ' + Object.keys(out).length + ' dates to ' +
  path.relative(ROOT, OUT) + ' (' + nExact + ' exact, ' + nYear + ' year, ' +
  nInterp + ' interpolated)');

const byYear = {};
for (const v of Object.values(out)) byYear[v.date.slice(0, 4)] = (byYear[v.date.slice(0, 4)] || 0) + 1;
console.log('[dates] by year: ' + JSON.stringify(byYear));
const ds = Object.values(out).map((v) => v.date).sort();
console.log('[dates] span ' + ds[0] + ' .. ' + ds[ds.length - 1]);
