#!/usr/bin/env node
'use strict';

// Which original video files the published reading no longer needs.
//
// REPORTS. NEVER DELETES. There is no flag here that removes a file,
// and `--execute` only writes `videos.analysis_state`. Deleting is a
// separate, deliberate step the user takes after reading this.
//
// A file is disposable only when BOTH are true:
//
//   1. a probe log with status "done" names THIS video (the id is read
//      out of the log's video_path, not out of the date);
//   2. the date is pinned in the ground-truth fixture manifest -- the
//      pixels were checked, not merely OCR'd.
//
// A date being pinned does not make every video on that date
// disposable. 20220606 is three uploads; only the file the scan read
// qualifies. A scanned date that is not pinned stays `scanned`, and
// the file stays: the reading is not verified.
//
// "disposable" is not "never useful again". A future OCR engine would
// need the original. It means the published, pixel-verified reading
// can be reproduced without the file.
//
// Usage:
//   node tools/reportDeletableVideos.js            # report only
//   node tools/reportDeletableVideos.js --execute  # also write the column
//   node tools/reportDeletableVideos.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const {
  ANALYSIS_STATE,
  catalogDateOf,
  decideAnalysisState,
  videoIdFromMediaPath,
} = require('../src/video/analysisState');
const { ensureAnalysisStateColumn, loadPinnedDates, writeAnalysisState } = require('../src/video/analysisStateStore');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const MANIFEST_PATH = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');

/** Probe logs live under video_ocr_probe and every video_scan_* tree. */
function scanRoots(dataDir) {
  const roots = [path.join(dataDir, 'video_ocr_probe')];
  let names = [];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return roots;
  }
  for (const name of names) {
    if (name.startsWith('video_scan')) roots.push(path.join(dataDir, name));
  }
  return roots;
}

const LOG_ROOTS = scanRoots(path.join(ROOT, 'data'));
const DOWNLOAD_DIRS = ['downloads', 'downloads_hires', 'downloads_1080p']
  .map((name) => path.join(ROOT, 'data', 'video_pipeline', name));

const SKIP_DIRS = new Set(['frames', 'snapshots', 'crops', 'node_modules']);

function readFlag(argv, name) {
  return argv.includes(name);
}

/**
 * Probe-log files under the scan roots. `frames/`, `snapshots/` and
 * `crops/` are never entered -- those trees hold the PNGs, and listing
 * them is what freezes a session.
 *
 * @param {string[]} roots
 * @returns {string[]}
 */
function collectLogFiles(roots) {
  const logs = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json') && path.basename(dir) === 'logs') {
        logs.push(full);
      }
    }
  }
  for (const root of roots) walk(root);
  return logs;
}

/**
 * Video ids a done probe log names, and the date each one was scanned on.
 *
 * The id comes from the log's video_path. A log with no path is skipped:
 * flagging by date alone would mark a sibling upload disposable, and
 * 20220606 is three uploads.
 *
 * @param {string[]} logFiles
 * @returns {Map<string, { date: string, log: string }>}
 */
function doneScansFromLogs(logFiles, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const done = new Map();
  for (const file of logFiles) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(file));
    } catch {
      continue;
    }
    if (!parsed || parsed.status !== 'done') continue;
    const videoId = videoIdFromMediaPath(parsed.video_path || '');
    if (!videoId) continue;
    const date = catalogDateOf(parsed.date_key || parsed.upload_date || '');
    const previous = done.get(videoId);
    if (!previous || date) done.set(videoId, { date: date || (previous && previous.date) || '', log: file });
  }
  return done;
}

/**
 * Classify catalog rows. A row whose id a done log names is scanned;
 * if that log's date (or the row's own date) is pinned, it is disposable.
 *
 * The pin is checked against the SCAN's date when the log recorded one,
 * and against the catalog date otherwise. A catalog date that is pinned
 * does not promote a video the scan never read.
 *
 * @param {Array<{video_id: string, upload_date: string}>} rows
 * @param {Map<string, {date: string}>} doneScans
 * @param {Set<string>} pinnedDates
 */
function classifyRows(rows, doneScans, pinnedDates) {
  return rows.map((row) => {
    const scan = doneScans.get(row.video_id);
    const scannedDone = Boolean(scan);
    const date = (scan && scan.date) || catalogDateOf(row.upload_date);
    const datePinned = pinnedDates.has(date);
    return {
      ...row,
      analysis_state: decideAnalysisState({ scannedDone, datePinned }),
      scan_date: date,
    };
  });
}

/**
 * Media files on disk whose name is this video's. Both the downloader's
 * `<date>_<id>.mp4` and the older `<id>.mp4` match.
 *
 * @param {string} videoId
 * @param {string[]} dirs
 */
function filesForVideo(videoId, dirs, stat = (p) => fs.statSync(p)) {
  const found = [];
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.mp4$/i.test(name)) continue;
      if (videoIdFromMediaPath(name) !== videoId) continue;
      const full = path.join(dir, name);
      let bytes = 0;
      try {
        bytes = stat(full).size;
      } catch {
        bytes = 0;
      }
      found.push({ path: full, bytes });
    }
  }
  return found;
}

function gib(bytes) {
  return (bytes / (1024 ** 3)).toFixed(2);
}

function main(argv = process.argv.slice(2)) {
  const execute = readFlag(argv, '--execute');
  const asJson = readFlag(argv, '--json');

  const pinnedDates = loadPinnedDates(MANIFEST_PATH);
  const logFiles = collectLogFiles(LOG_ROOTS);
  const doneScans = doneScansFromLogs(logFiles);

  const db = new DatabaseSync(DB_PATH);
  let rows;
  try {
    rows = db.prepare(
      `SELECT video_id, upload_date, channel, status, download_path
       FROM videos ORDER BY channel, upload_date, video_id`,
    ).all();
  } finally {
    if (!execute) db.close();
  }

  const classified = classifyRows(rows, doneScans, pinnedDates);
  const disposable = classified.filter((row) => row.analysis_state === ANALYSIS_STATE.DISPOSABLE);
  const scanned = classified.filter((row) => row.analysis_state === ANALYSIS_STATE.SCANNED);

  const disposableFiles = [];
  for (const row of disposable) {
    for (const file of filesForVideo(row.video_id, DOWNLOAD_DIRS)) {
      disposableFiles.push({ ...file, video_id: row.video_id, upload_date: row.upload_date, channel: row.channel });
    }
  }
  const bytes = disposableFiles.reduce((sum, file) => sum + file.bytes, 0);

  let written = 0;
  if (execute) {
    try {
      ensureAnalysisStateColumn(db);
      for (const row of classified) {
        if (!row.analysis_state) continue;
        written += writeAnalysisState(db, row.video_id, row.analysis_state);
      }
    } finally {
      db.close();
    }
  }

  const summary = {
    pinned_dates: pinnedDates.size,
    probe_logs: logFiles.length,
    done_scans: doneScans.size,
    disposable_videos: disposable.length,
    disposable_files: disposableFiles.length,
    disposable_bytes: bytes,
    scanned_keep: scanned.length,
    written,
    executed: execute,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, files: disposableFiles }, null, 2));
    return summary;
  }

  console.log('analysis_state -- the original file is still needed unless the flag says otherwise');
  console.log('this tool REPORTS. it never deletes. --execute only writes the column.');
  console.log('');
  console.log(`pinned dates in the fixture manifest : ${pinnedDates.size}`);
  console.log(`probe logs read                      : ${logFiles.length}`);
  console.log(`videos a done log names              : ${doneScans.size}`);
  console.log(`disposable (scanned AND pinned)      : ${disposable.length} videos, ${disposableFiles.length} files, ${gib(bytes)} GiB`);
  console.log(`scanned, not pinned -- KEEP          : ${scanned.length}`);
  console.log('');
  console.log('disposable means the published, pixel-verified reading does not need the file.');
  console.log('a future OCR pass would. nothing below has been deleted.');
  console.log('');
  for (const file of disposableFiles.sort((a, b) => b.bytes - a.bytes)) {
    const rel = path.relative(ROOT, file.path);
    console.log(`  ${gib(file.bytes).padStart(6)} GiB  ${file.channel}  ${file.upload_date}  ${rel}`);
  }
  if (execute) console.log(`\nwrote analysis_state on ${written} row(s). no file was deleted.`);
  else console.log('\ndry run. --execute writes the column and still deletes nothing.');
  return summary;
}

module.exports = {
  classifyRows,
  collectLogFiles,
  doneScansFromLogs,
  filesForVideo,
};

if (require.main === module) main();
