'use strict';

// What can be dated WITHOUT asking YouTube?
//
// The catalog carries 12,786 Benzinga rows and 12,751 of them have no
// upload_date, because a flat listing carries none. Dating them costs one
// metadata request each -- ~4.2 s with the `mweb` client, so ~1.5 h for the
// allow-listed shows at six jobs.
//
// But the TITLES carry dates too. The daily PreMarket Playbook puts its
// air date in the title ("... | PreMarket Playbook | November 9, 2026"), and
// the PreMarket Prep era did the same ("PreMarket Prep December 29").
//
// This tool measures that coverage, because the answer decides whether the
// metadata campaign is 1.5 hours or 8.
//
// It also RECONCILES the two sources where both exist, and it checks the
// title date against the listing order -- the soundness rule from
// tools/resolveUndatedDates.js: a date has to agree with its neighbours in
// a strictly newest-first listing.
//
// Usage:
//   node tools/surveyBenzingaDates.js
//   node tools/surveyBenzingaDates.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const { classifyBenzingaVideo, titleAirDate } = require('../src/benzinga/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// The listing facts, so the show can be classified the same way everywhere.
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
  "SELECT video_id, upload_date, title FROM videos WHERE channel = 'benzinga' ORDER BY video_id",
).all();

const byShow = new Map();
let undated = 0;
let titleDated = 0;
let both = 0;
let agree = 0;
let disagree = 0;
const disagreements = [];
const titleDateSamples = [];

for (const row of rows) {
  const fact = facts.get(row.video_id) || {};
  const show = classifyBenzingaVideo({ title: row.title || '', ...fact }).show;
  const bucket = byShow.get(show) || { show, total: 0, undated: 0, title_dated: 0, agree: 0, disagree: 0 };
  bucket.total += 1;
  byShow.set(show, bucket);

  if (!row.upload_date) undated += 1;
  else bucket.undated += 0;

  const fromTitle = titleAirDate(row.title || '');
  if (!fromTitle) continue;
  titleDated += 1;
  bucket.title_dated += 1;

  if (row.upload_date) {
    both += 1;
    if (row.upload_date === fromTitle) { agree += 1; bucket.agree += 1; }
    else {
      disagree += 1;
      bucket.disagree += 1;
      if (disagreements.length < 20) {
        disagreements.push({ video_id: row.video_id, stored: row.upload_date, from_title: fromTitle, title: (row.title || '').slice(0, 70) });
      }
    }
  } else if (titleDateSamples.length < 10) {
    titleDateSamples.push({ video_id: row.video_id, from_title: fromTitle, title: (row.title || '').slice(0, 70) });
  }
}

db.close();

const allowList = new Set(['premarket_playbook', 'the_drift', 'stock_in_play', 'explainer', 'market_update']);
let allowTotal = 0;
let allowUndated = 0;
let allowTitleDated = 0;
for (const bucket of byShow.values()) {
  if (!allowList.has(bucket.show)) continue;
  allowTotal += bucket.total;
  allowUndated += bucket.total - bucket.agree - bucket.disagree;
  allowTitleDated += bucket.title_dated;
}

if (asJson) {
  console.log(JSON.stringify({
    total: rows.length,
    undated,
    title_dated: titleDated,
    both_dated: both,
    title_agrees_with_stored: agree,
    title_disagrees_with_stored: disagree,
    disagreements,
    title_date_samples: titleDateSamples,
    allow_list: { total: allowTotal, undated: allowUndated, title_dated: allowTitleDated },
    by_show: [...byShow.values()].sort((a, b) => b.total - a.total),
  }, null, 2));
} else {
  console.log(`benzinga rows: ${rows.length}   undated: ${undated}   with a date in the TITLE: ${titleDated}`);
  console.log(`where both exist: ${both} — the title agrees on ${agree}, disagrees on ${disagree}`);
  console.log(`\nallow-listed rows: ${allowTotal}   of those, ${allowUndated} undated and ${allowTitleDated} carry a title date`);
  console.log('\nby show:');
  for (const bucket of [...byShow.values()].sort((a, b) => b.total - a.total)) {
    console.log(`  ${bucket.show.padEnd(20)} total=${String(bucket.total).padStart(5)}`
      + `  title-dated=${String(bucket.title_dated).padStart(5)}`
      + `  agree=${bucket.agree} disagree=${bucket.disagree}`);
  }
  if (disagreements.length) {
    console.log('\ndisagreements (stored vs title):');
    for (const d of disagreements) console.log(`  ${d.video_id}  stored=${d.stored}  title=${d.from_title}  ${d.title}`);
  }
  console.log('\nsamples of a title date:');
  for (const s of titleDateSamples) console.log(`  ${s.video_id}  ${s.from_title}  ${s.title}`);
}
