'use strict';

// Select the pilot sample for the Benzinga source.
//
// WHAT IT DOES
//
// The channel is too large to transcribe blind: 12,786 catalogued videos,
// 9,300 of them on the allow-list, and the daily PreMarket show alone
// accounts for thousands of hours. So the pilot is a SPREAD, chosen to
// answer four questions before any large fetch:
//
//   1. do the captions exist, per show and per era?  The channel started
//      publishing in 2014, and the older episodes are the ones likely to
//      carry no caption track.
//   2. how long is a transcript, and what does it cost to store?
//   3. does the shared extractor read news-style speech correctly?
//   4. what does the title date say, and does it agree with the listing
//      order?  The daily show's title carries its air date, and the
//      listing is newest-first -- so the two are an independent check.
//
// THE ERAS
//
// The streams listing is newest-first, so the FILE ORDER is the era: the
// head is 2026 and the tail is 2014. The sample therefore takes rows from
// the head, the middle and the tail, rather than 40 consecutive videos.
//
// Usage:
//   node tools/selectBenzingaPilot.js
//   node tools/selectBenzingaPilot.js --per-era 3 --out data/catalog_flat/benzinga_pilot_ids.txt

const fs = require('node:fs');
const path = require('node:path');

const { classifyBenzingaVideo, titleAirDate } = require('../src/benzinga/contentFilter');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

const perEra = Number(readFlag('--per-era', '4')) || 4;
const outPath = path.resolve(readFlag('--out', path.join(ROOT, 'data', 'catalog_flat', 'benzinga_pilot_ids.txt')));

function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'latin1').split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, duration, liveStatus, ...rest] = line.split('\t');
    return {
      id,
      duration_sec: Number(duration) || null,
      live_status: liveStatus === 'NA' ? '' : liveStatus,
      title: rest.join('\t'),
    };
  });
}

const streams = readTsv(path.join(ROOT, 'data', 'catalog_flat', 'benzinga_streams.tsv'));
const videos = readTsv(path.join(ROOT, 'data', 'catalog_flat', 'benzinga_videos.tsv'));
if (!streams.length) {
  console.error('No streams listing. Fetch it first.');
  process.exit(1);
}

const withFacts = (row, listingKind) => classifyBenzingaVideo({ ...row, listing_kind: listingKind });
const streamsClassified = streams.map((row) => ({ row, cls: withFacts(row, 'streams') }));
const videosClassified = videos.map((row) => ({ row, cls: withFacts(row, 'videos') }));

/** Take rows spread across the listing's length, which IS its era order. */
function spread(list, count, filter) {
  const picked = [];
  const pool = list.filter(filter);
  if (!pool.length) return picked;
  for (let i = 0; i < count; i += 1) {
    const index = Math.floor((i * pool.length) / count);
    picked.push(pool[index]);
  }
  return picked;
}

const selected = new Map();
const add = (entry, note) => {
  if (!entry || selected.has(entry.row.id)) return;
  selected.set(entry.row.id, { ...entry, note });
};

// 1. The daily show, from three points in the listing: recent, middle, old.
spread(streamsClassified, perEra, (e) => e.cls.show === 'premarket_playbook' && e.row.live_status === 'was_live')
  .forEach((e) => add(e, 'premarket_playbook'));

// 2. The Drift, every episode there is (there are few).
streamsClassified.filter((e) => e.cls.show === 'the_drift').forEach((e) => add(e, 'the_drift'));

// 3. The clips: a small-ticker setup clip and a futures update.
spread(videosClassified, perEra, (e) => e.cls.show === 'stock_in_play').forEach((e) => add(e, 'stock_in_play'));
spread(videosClassified, perEra, (e) => e.cls.show === 'market_update').forEach((e) => add(e, 'market_update'));

// 4. One long-form Benzinga commentary.
spread(streamsClassified, 2, (e) => e.cls.show === 'explainer').forEach((e) => add(e, 'explainer'));

const rows = [...selected.values()];
const out = rows.map((entry) => `${entry.row.id}\t${entry.row.title}\t${entry.note}\t${entry.row.duration_sec || ''}\t${titleAirDate(entry.row.title)}`).join('\n');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${out}\n`, 'utf8');

const byNote = {};
for (const entry of rows) byNote[entry.note] = (byNote[entry.note] || 0) + 1;
const hours = rows.reduce((sum, e) => sum + (e.row.duration_sec || 0), 0) / 3600;
const dated = rows.filter((e) => titleAirDate(e.row.title)).length;
console.log(JSON.stringify({
  selected: rows.length,
  by_note: byNote,
  hours: Number(hours.toFixed(1)),
  with_a_date_in_the_title: dated,
  out: path.relative(ROOT, outPath).replace(/\\/g, '/'),
}, null, 2));

for (const entry of rows) {
  console.log(`  ${entry.note.padEnd(20)} ${Math.round((entry.row.duration_sec || 0) / 60)}m `
    + `${titleAirDate(entry.row.title) || '          '} ${entry.row.title.slice(0, 70)}`);
}
