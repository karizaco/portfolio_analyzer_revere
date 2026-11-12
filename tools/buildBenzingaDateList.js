'use strict';

// Build the date work list for the Benzinga corpus.
//
// WHY A LIST AND NOT A FLAG
//
// `fill-dates --build-listing` derives its work list from the channel
// listing, which for Benzinga is 12,786 rows -- and most of them are
// quarantined (earnings calls, Fed pressers, CEO interviews, Shorts) and
// will never be read. Dating them would spend a metadata request each on
// videos the pipeline will not touch.
//
// So the list is built here from the CONTENT FILTER, and it is built in
// the order that matters: the shows that carry calls first, then the
// long-form commentary, then the rest.
//
// WHY DATES AT ALL
//
// The outcome analysis needs `upload_date` -- it is the event date, and it
// is what the price is measured from. 12,751 of the 12,786 rows have none,
// because a flat listing carries none. So the corpus is catalogued but not
// yet placeable in time, and nothing can be scored.
//
// The title carries a date for 2,170 of them ("... | PreMarket Playbook |
// November 9, 2026"), which is free -- and the metadata fetch is what
// CROSS-CHECKS it. Where the two exist they agree (3 of 3 so far).
//
// Usage:
//   node tools/buildBenzingaDateList.js --wave 1
//   node tools/buildBenzingaDateList.js --wave 1 --out data/catalog_flat/benzinga_dates_wave1.tsv

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const { classifyBenzingaVideo } = require('../src/benzinga/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const argv = process.argv.slice(2);

function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

/**
 * The waves, in the order they should be dated.
 *
 * Wave 1 is the corpus that carries CALLS. Wave 2 is the long-form
 * commentary, which is scored at one month rather than one week. Wave 3 is
 * everything else -- the quarantine -- and it is dated only if a reading
 * ever needs it.
 */
const WAVES = {
  1: ['premarket_playbook', 'the_drift', 'stock_in_play'],
  2: ['explainer', 'market_update'],
  3: ['earnings_call', 'fed_presser', 'interview', 'partner_content', 'education', 'product_tutorial', 'short_clip', 'upcoming', 'other'],
};

const wave = Number(readFlag('--wave', '1')) || 1;
const outPath = path.resolve(readFlag('--out', path.join(ROOT, 'data', 'catalog_flat', `benzinga_dates_wave${wave}.tsv`)));

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const facts = new Map();
for (const row of db.prepare(
  'SELECT video_id, duration_sec, live_status, listing_kind FROM video_listing_entries WHERE channel = ?',
).all('benzinga')) {
  const existing = facts.get(row.video_id);
  const duration = row.duration_sec === null ? null : Number(row.duration_sec);
  if (!existing) {
    facts.set(row.video_id, {
      duration_sec: duration,
      live_status: row.live_status === 'NA' ? '' : (row.live_status || ''),
      listing_kind: row.listing_kind || '',
    });
  } else if (duration !== null && (existing.duration_sec === null || duration > existing.duration_sec)) {
    existing.duration_sec = duration;
  }
}

const rows = db.prepare(
  "SELECT video_id, upload_date, title FROM videos WHERE channel = 'benzinga'",
).all();
db.close();

const wanted = new Set(WAVES[wave] || []);
const work = [];
const skipped = { already_dated: 0, not_in_wave: 0 };
for (const row of rows) {
  const fact = facts.get(row.video_id) || {};
  const show = classifyBenzingaVideo({ title: row.title || '', ...fact }).show;
  if (!wanted.has(show)) { skipped.not_in_wave += 1; continue; }
  if (row.upload_date) { skipped.already_dated += 1; continue; }
  work.push({ video_id: row.video_id, title: row.title || '', show });
}

// Newest first, so the corpus is usable from the top down if the run is
// interrupted.
work.sort((a, b) => a.video_id.localeCompare(b.video_id));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${work.map((r) => `${r.video_id}\t${r.title}`).join('\n')}\n`, 'utf8');

const byShow = {};
for (const r of work) byShow[r.show] = (byShow[r.show] || 0) + 1;
console.log(JSON.stringify({
  wave,
  shows: [...wanted],
  rows_to_date: work.length,
  by_show: byShow,
  skipped,
  out: path.relative(ROOT, outPath).replace(/\\/g, '/'),
  command: `node tools/runWhiteboardWorker.js fill-dates --channel benzinga --input ${path.relative(ROOT, outPath).replace(/\\/g, '/')} --jobs 6`,
}, null, 2));
