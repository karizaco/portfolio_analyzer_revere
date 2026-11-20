'use strict';

// Import a flat YouTube listing (id<TAB>title) into videos.
//
// A flat listing has no upload_date. That is a property of yt-dlp's
// --flat-playlist, not of this importer. An empty date does not overwrite a
// date the catalog already has -- the same rule as upsert_catalog_rows.
//
// THE LISTING ENTRY TABLE
//
// A channel's content is decided by three facts a video id does not carry:
// which listing it came from, how long it is, and whether it had been
// streamed yet. `videos` cannot hold them -- a video can be in the streams
// tab AND the videos tab AND a show playlist, and `videos.source_url` holds
// only the last listing that was fetched -- so they go into
// `video_listing_entries`, one row per (video, listing).
//
// The columns after the title are OPTIONAL, and they are read only when
// present:
//
//   id<TAB>title
//   id<TAB>title<TAB>duration<TAB>live_status
//
// Usage:
//   node tools/importFlatListing.js --channel t3live \
//     --source-url https://www.youtube.com/@t3live/videos \
//     --listing data/catalog_flat/t3live_videos.tsv
//   node tools/importFlatListing.js --channel benzinga \
//     --source-url https://www.youtube.com/@Benzinga/streams \
//     --listing data/catalog_flat/benzinga_streams.tsv --listing-kind streams

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);

function readFlag(flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return '';
  return argv[index + 1] || '';
}

// WHERE the catalog is. A scratch copy is how the tool is tested without
// touching the real one.
const DB_PATH = path.resolve(readFlag('--db') || path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite'));

const insertOnly = argv.includes('--insert-only');
const channel = readFlag('--channel');
const sourceUrl = readFlag('--source-url');
const listingPath = path.resolve(readFlag('--listing'));
// streams | videos | shorts | playlist. It says WHICH listing the rows came
// from, and it is what makes the listing membership queryable.
const listingKind = readFlag('--listing-kind');
// The playlist the rows came from, when the listing is a playlist.
const playlistId = readFlag('--playlist-id');
const playlistTitle = readFlag('--playlist-title');
// A truncated listing cannot claim to have covered the channel. The run row
// says so, because `listing_complete` is what makes "not listed" mean
// something.
const partial = argv.includes('--partial');

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
  // The bytes may not be UTF-8. yt-dlp's stdout passes through the console
  // codepage on Windows, so a title with an em-dash lands as cp1252.
  //
  // Decode as UTF-8 FIRST and fall back to cp1252 -- which is the rule
  // the Python worker uses (tools/whiteboard_worker.py, read_wanted_rows).
  // Decoding as cp1252 ALWAYS mangles every non-ASCII character of a
  // UTF-8 listing, which is what this reader used to do.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  return text.replace(/\r\n?/g, '\n');
}

// The separator in a listing file is not always a tab. The listing
// documented in CLAUDE.md is produced through a shell, and the shell hands
// yt-dlp the two characters backslash-t, which yt-dlp prints verbatim. A
// listing written from Python carries a real tab. Both are read, and the
// choice is made ONCE FOR THE FILE rather than per line, so a title
// containing a tab cannot shift the separator halfway down the file.
// (The Python worker breaks on the first non-empty line even when that
// line has no separator; this one takes the first line that HAS one, so a
// malformed first line does not lose the whole file.)
const LITERAL_TAB = '\\t';

const text = decodeListing(fs.readFileSync(listingPath));
const lines = text.split('\n');
let separator = '';
for (const candidate of lines) {
  if (!candidate.trim()) continue;
  if (candidate.includes('\t')) { separator = '\t'; break; }
  if (candidate.includes(LITERAL_TAB)) { separator = LITERAL_TAB; break; }
}
if (!separator && !lines.some((line) => line.trim())) separator = '\t'; // an empty listing

const rows = [];
const seen = new Set();
let malformed = 0;

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;
  const tab = line.indexOf(separator);
  if (tab < 1) {
    malformed += 1;
    continue;
  }
  const videoId = line.slice(0, tab).trim();
  const rest = line.slice(tab + separator.length);
  const fields = rest.split(separator);
  // The listing's shape is DETECTED, not assumed. Two layouts are in use:
  //
  //   id<TAB>title                                the plain listing
  //   id<TAB>duration<TAB>live_status<TAB>title    what yt-dlp writes with
  //                                                --print-to-file and a
  //                                                template that puts the
  //                                                video's facts first
  //
  // The facts-first layout is recognised by its SECOND field being a live
  // status, or by its first field being a duration. A duration can be "NA"
  // (a stream with no length yet), so the number alone is not enough to
  // tell the layouts apart.
  const LIVE_STATUSES = new Set(['was_live', 'is_live', 'is_upcoming', 'post_live', 'was_upcoming', 'NA']);
  const first = (fields[0] || '').trim();
  const second = (fields[1] || '').trim();
  const numeric = Number(first);
  const factsFirst = fields.length >= 3
    && (LIVE_STATUSES.has(second) || (first !== '' && Number.isFinite(numeric)));

  const title = (factsFirst ? (fields[2] || '') : first).trim();
  const duration = Number(factsFirst ? fields[0] : fields[1]);
  const liveStatus = (factsFirst ? second : (fields[2] || '')).trim();
  if (!/^[A-Za-z0-9_-]{6,}$/.test(videoId)) {
    malformed += 1;
    continue;
  }
  if (seen.has(videoId)) continue;
  seen.add(videoId);
  rows.push({
    videoId,
    title,
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    liveStatus,
  });
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

const insertListing = db.prepare(
  `INSERT INTO video_listing_entries (
     video_id, channel, listing_kind, listing_url, playlist_id, playlist_title,
     duration_sec, live_status, last_seen_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(video_id, listing_kind, playlist_id) DO UPDATE SET
     duration_sec = COALESCE(excluded.duration_sec, video_listing_entries.duration_sec),
     live_status = CASE WHEN excluded.live_status <> '' THEN excluded.live_status ELSE video_listing_entries.live_status END,
     listing_url = CASE WHEN excluded.listing_url <> '' THEN excluded.listing_url ELSE video_listing_entries.listing_url END,
     last_seen_at = excluded.last_seen_at`,
);

// THE AUDIT ROW GOES IN FIRST, IN ITS OWN TRANSACTION.
//
// It used to be written INSIDE the transaction that wrote the rows, so an
// interrupted import left neither the rows nor the record of the run --
// the exact failure the `fill-dates` run of 2026-10-26 made (1,582 rows
// across 66 batches with no audit row at all). A run that is interrupted
// must still leave a row, and that row must report what it DID.
//
// The counters are filled in afterwards, so a row left behind by an
// interrupted run says "nothing was inserted" -- which is true.
const relListing = path.relative(ROOT, listingPath).replace(/\\/g, '/');
const auditRow = db.prepare(
  `INSERT INTO catalog_runs (
     source_url, channel, command_json, raw_output_path, row_count,
     inserted_count, updated_count, missing_upload_dates, malformed_rows,
     created_at, kind, not_listed_count, listing_complete, row_count_kind
   ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'live', 0, ?, 'listing_rows')`,
).run(
  sourceUrl,
  channel,
  JSON.stringify(process.argv.slice(1)),
  relListing,
  rows.length,
  malformed,
  now,
  partial ? 0 : 1,
);
const runId = Number(auditRow.lastInsertRowid);

db.exec('BEGIN');
for (const row of rows) {
  if (insertOnly && existing.has(row.videoId)) {
    updated += 1;
    insertListing.run(
      row.videoId, channel, listingKind, sourceUrl, playlistId, playlistTitle,
      row.durationSec, row.liveStatus, now,
    );
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
  insertListing.run(
    row.videoId, channel, listingKind, sourceUrl, playlistId, playlistTitle,
    row.durationSec, row.liveStatus, now,
  );
  if (existing.has(row.videoId)) updated += 1;
  else inserted += 1;
}
db.exec('COMMIT');

// The rows that are STILL without a date. A flat listing supplies none,
// so this counts the rows the catalog had a date for already -- which is
// the number a reader wants, and not the number of rows in the file.
db.exec('CREATE TEMP TABLE IF NOT EXISTS imported_ids (video_id TEXT PRIMARY KEY)');
db.exec('DELETE FROM imported_ids');
const insertId = db.prepare('INSERT OR IGNORE INTO imported_ids (video_id) VALUES (?)');
for (const row of rows) insertId.run(row.videoId);
const missingUploadDates = db.prepare(
  `SELECT COUNT(*) AS n FROM videos JOIN imported_ids USING (video_id)
   WHERE videos.upload_date IS NULL OR videos.upload_date = ''`,
).get().n;

db.prepare(
  `UPDATE catalog_runs SET inserted_count = ?, updated_count = ?, missing_upload_dates = ? WHERE run_id = ?`,
).run(inserted, updated, missingUploadDates, runId);
db.close();

console.log(JSON.stringify({
  channel,
  listing: relListing,
  listing_kind: listingKind || '',
  playlist_id: playlistId || '',
  rows: rows.length,
  inserted,
  updated,
  malformed,
  missing_upload_dates: missingUploadDates,
  catalog_run_id: runId,
  listing_complete: partial ? 0 : 1,
  note: 'flat listing has no upload_date; existing dates were kept',
}, null, 2));
