'use strict';

// Import a flat YouTube listing (id<TAB>title) into videos.
//
// A flat listing has no upload_date. That is a property of yt-dlp's
// --flat-playlist, not of this importer. An empty date does not overwrite a
// date the catalog already has -- the same rule as upsert_catalog_rows.
//
// Usage:
//   node tools/importFlatListing.js --channel t3live \
//     --source-url https://www.youtube.com/@t3live/videos \
//     --listing data/catalog_flat/t3live_videos.tsv

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

const argv = process.argv.slice(2);

function readFlag(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return '';
  return argv[index + 1] || '';
}

const insertOnly = argv.includes('--insert-only');
const channel = readFlag('--channel');
const sourceUrl = readFlag('--source-url');
const listingPath = path.resolve(readFlag('--listing'));

if (!channel || !sourceUrl || !readFlag('--listing')) {
  console.error('Usage: node tools/importFlatListing.js --channel NAME --source-url URL --listing FILE');
  process.exit(2);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`No SQLite at ${DB_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(listingPath)) {
  console.error(`No listing at ${listingPath}`);
  process.exit(1);
}

function decodeListing(buffer) {
  // yt-dlp's stdout on Windows is the console codepage. 0x92 is a right
  // apostrophe in cp1252, and reading it as UTF-8 or latin1 stores the wrong
  // character. Map the cp1252 0x80-0x9F range, then decode the rest as latin1.
  const CP1252 = {
    0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
    0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
    0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
    0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
    0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
    0x9e: 'ž', 0x9f: 'Ÿ',
  };
  let out = '';
  for (const byte of buffer) {
    if (byte === 0x0d) continue;
    out += CP1252[byte] || String.fromCharCode(byte);
  }
  return out;
}

const text = decodeListing(fs.readFileSync(listingPath));
const rows = [];
const seen = new Set();
let malformed = 0;

for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;
  // A template passed through the shell often prints the two characters
  // backslash-t instead of a tab. Accept both.
  const tab = line.includes('\t') ? line.indexOf('\t') : line.indexOf('\\t');
  const sepLen = line.includes('\t') ? 1 : 2;
  if (tab < 1) {
    malformed += 1;
    continue;
  }
  const videoId = line.slice(0, tab).trim();
  const title = line.slice(tab + sepLen).trim();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
    malformed += 1;
    continue;
  }
  if (seen.has(videoId)) continue;
  seen.add(videoId);
  rows.push({ videoId, title });
}

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));

const existing = new Set(
  db.prepare('SELECT video_id FROM videos').all().map((row) => row.video_id),
);

const upsert = db.prepare(
  `INSERT INTO videos (
     video_id, source_url, video_url, title, upload_date, channel, status, created_at, updated_at
   ) VALUES (?, ?, ?, ?, '', ?, 'pending', ?, ?)
   ON CONFLICT(video_id) DO UPDATE SET
     source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE videos.source_url END,
     video_url = CASE WHEN excluded.video_url <> '' THEN excluded.video_url ELSE videos.video_url END,
     title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE videos.title END,
     upload_date = CASE WHEN excluded.upload_date <> '' THEN excluded.upload_date ELSE videos.upload_date END,
     channel = CASE WHEN excluded.channel <> '' THEN excluded.channel ELSE videos.channel END,
     updated_at = excluded.updated_at`,
);

const now = new Date().toISOString();
let inserted = 0;
let updated = 0;

db.exec('BEGIN');
for (const row of rows) {
  if (insertOnly && existing.has(row.videoId)) {
    updated += 1;
    continue;
  }
  upsert.run(
    row.videoId,
    sourceUrl,
    `https://www.youtube.com/watch?v=${row.videoId}`,
    row.title,
    channel,
    now,
    now,
  );
  if (existing.has(row.videoId)) updated += 1;
  else inserted += 1;
}

const relListing = path.relative(ROOT, listingPath).replace(/\\/g, '/');
db.prepare(
  `INSERT INTO catalog_runs (
     source_url, channel, command_json, raw_output_path, row_count,
     inserted_count, updated_count, missing_upload_dates, malformed_rows,
     created_at, kind, not_listed_count, listing_complete, row_count_kind
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 0, 1, 'listing_rows')`,
).run(
  sourceUrl,
  channel,
  JSON.stringify(process.argv.slice(1)),
  relListing,
  rows.length,
  inserted,
  updated,
  rows.length,
  malformed,
  now,
);
db.exec('COMMIT');
db.close();

console.log(JSON.stringify({
  channel,
  listing: relListing,
  rows: rows.length,
  inserted,
  updated,
  malformed,
  note: 'flat listing has no upload_date; existing dates were kept',
}, null, 2));
