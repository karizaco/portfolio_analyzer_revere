'use strict';

/**
 * List the videos available for OCR that have no ground truth.
 *
 * The user asked for OCR on videos where the ground truth is unknown — that
 * is how the benchmark gets wider. This script picks the candidates:
 *
 *   - a qullamaggie video that is on disk in the out-of-tree media root,
 *   - with a date (exact from the catalog, or interpolated along the playlist
 *     order by tools/qmgVideoDates.js),
 *   - that has no entry in data/qmg_ground_truth.json,
 *   - and that has no surviving EasyOCR log yet.
 *
 * "Already scanned" is tracked per VIDEO, not per date: several videos share
 * an interpolated date, and one of them being scanned must not hide the rest.
 *
 * Usage:
 *   node tools/listOcrTargets.js
 *   node tools/listOcrTargets.js --limit 20
 *   node tools/listOcrTargets.js --dates 20231201,20231215
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { mediaVideoId } = require('./mediaVideoId.js');
const { mediaRoot } = require('./mediaRoot.js');

const MEDIA_ROOT = mediaRoot();

const argv = process.argv.slice(2);
const limit = Number(argv[argv.indexOf('--limit') + 1]) || 0;
const onlyDates = (() => {
  const i = argv.indexOf('--dates');
  return i === -1 ? null : new Set(argv[i + 1].split(',').filter(Boolean));
})();

/**
 * Collect the videos worth OCR-ing.
 *
 * Exported so tools/qmgOcrSweep.js reuses exactly these selection rules
 * instead of re-deriving them.
 */
function collectTargets() {
  // --- Videos on disk, by bare id -------------------------------------------
  const onDisk = new Map();   // video_id -> { file, dir, resolution }
  for (const [dir, resolution] of [
    [path.join(MEDIA_ROOT, 'downloads_1080p'), '1080p'],
    [path.join(MEDIA_ROOT, 'downloads_720p'), '720p'],
  ]) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.mp4')) continue;
      // The downloader prefixes an 8-digit upload_date, and only that. A
      // video id may itself start with digits ("438_cyYQ888"), so stripping
      // `^\d+_` would truncate a real id. Strip exactly the date prefix.
      const id = mediaVideoId(f);
      onDisk.set(id, { file: f, dir, resolution });
    }
  }

  // --- Dates -----------------------------------------------------------------
  const dates = new Map();      // video_id -> { date, confidence }
  const DATE_FILE = 'data/qmg_video_dates.json';
  try {
    const inferred = JSON.parse(
      fs.readFileSync(path.join(ROOT, DATE_FILE), 'utf8')
    );
    for (const [id, e] of Object.entries(inferred)) {
      const d = typeof e === 'string' ? e : e.date;
      const c = typeof e === 'string' ? 'exact' : e.confidence;
      if (d) dates.set(id, { date: d, confidence: c });
    }
  } catch (_) {
    console.error('[targets] no ' + DATE_FILE + ' — run tools/qmgVideoDates.js first');
    process.exit(1);
  }

  // --- Ground truth ----------------------------------------------------------
  const gt = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8')
  );
  const gtDates = new Set(Object.keys(gt).filter((k) => !k.startsWith('_')));

  // --- Which videos already have an EasyOCR log? ------------------------------
  const scanned = new Set();  // video_id
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.json') || !e.name.includes('_snapshot.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const engine = j.ocr_engine_metadata?.ocr_engine;
        if (engine !== 'easyocr') continue;
        // An ERROR log is not a scan. It records that the video was attempted
        // and produced nothing (e.g. "ffmpeg frame extraction failed"), so
        // counting it as scanned suppresses the video from the work list
        // forever — the scan can never be retried. Only a log that actually
        // captured frames marks the video as done.
        if (j.status === 'error') continue;
        if (!(j.top_candidates || []).length) continue;
        const vp = j.video_path ? String(j.video_path) : '';
        const m = vp.match(/([A-Za-z0-9_-]{11})\.mp4$/);
        if (m) scanned.add(m[1]);
      } catch (_) {}
    }
  }
  walk(path.join(ROOT, 'data'));
  walk(path.join(ROOT, 'data', 'video_scan_test', '_rerun'));

  // --- Candidates --------------------------------------------------------------
  const candidates = [];
  for (const [id, info] of dates) {
    if (!onDisk.has(id)) continue;
    const { date, confidence } = info;
    if (onlyDates && !onlyDates.has(date)) continue;
    if (gtDates.has(date)) continue;          // has ground truth already
    if (scanned.has(id)) continue;             // already scanned with EasyOCR
    candidates.push({ id, date, confidence, ...onDisk.get(id) });
  }
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    candidates,
    stats: {
      onDisk: onDisk.size,
      dated: dates.size,
      scanned: scanned.size,
    },
  };
}

module.exports = { collectTargets };

if (require.main === module) {
  const { candidates, stats } = collectTargets();
  console.log('[targets] ' + stats.onDisk + ' videos on disk, ' +
    stats.dated + ' with a date, ' + stats.scanned + ' videos already EasyOCR-scanned');
  console.log('[targets] ' + candidates.length + ' no-GT candidates' +
    (onlyDates ? ' for the requested dates' : ''));

  const show = limit ? candidates.slice(0, limit) : candidates;
  for (const c of show) {
    console.log('  ' + c.date + '  ' + c.id.padEnd(12) + ' ' + c.resolution +
      '  ' + c.confidence.padEnd(12) + ' ' + c.file);
  }
  if (limit && candidates.length > limit) {
    console.log('  ... and ' + (candidates.length - limit) + ' more');
  }
  console.log('\n[tgt] comma-separated video ids:');
  console.log(show.map((c) => c.id).join(','));
  console.log('\n[tgt] comma-separated dates:');
  console.log(show.map((c) => c.date).join(','));
}
