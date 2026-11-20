'use strict';

// The session date is the date in the title, not YouTube's upload timestamp.
// A catalog run stores whatever yt-dlp printed. This rewrites martinlukkt
// upload_date from the title when the two differ. A title with no date is
// left alone. Dry-run unless --execute.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { MARTINLUKKT_CHANNEL } = require('../src/martinlukkt/channel');
const { sessionKind, uploadDateFromTitle } = require('../src/martinlukkt/contentFilter');

const execute = process.argv.includes('--execute');
const dbPath = path.resolve('data/video_pipeline/state.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: !execute });

const rows = db.prepare(
  'SELECT video_id, title, upload_date FROM videos WHERE channel = ? ORDER BY video_id',
).all(MARTINLUKKT_CHANNEL);

const changes = [];
let noDate = 0;
let review = 0;
for (const row of rows) {
  if (sessionKind(row.title) === 'review') review += 1;
  const next = uploadDateFromTitle(row);
  if (!next) {
    if (!row.upload_date) noDate += 1;
    continue;
  }
  changes.push({ video_id: row.video_id, from: row.upload_date || '', to: next, title: row.title });
}

if (execute && changes.length) {
  const update = db.prepare('UPDATE videos SET upload_date = ? WHERE video_id = ? AND channel = ?');
  db.exec('BEGIN');
  for (const change of changes) update.run(change.to, change.video_id, MARTINLUKKT_CHANNEL);
  db.exec('COMMIT');
}

const summary = {
  channel: MARTINLUKKT_CHANNEL,
  changed: changes.length,
  execute,
  no_title_date: noDate,
  review,
  rows: rows.length,
  sample: changes.slice(0, 8),
};
console.log(JSON.stringify(summary, null, 2));
db.close();
