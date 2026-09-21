'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const baselinePath = path.resolve(args[0] || 'data/video_scan_20260913/fields-v1/analysis.json');
const currentPath = path.resolve(args[1] || 'data/video_scan_20260914/fields-v2/analysis.json');

function loadAnalysis(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

const baseline = loadAnalysis(baselinePath);
const current = loadAnalysis(currentPath);

const labelBaseline = path.basename(path.dirname(baselinePath));
const labelCurrent = path.basename(path.dirname(currentPath));

console.log('=== TOTALS COMPARISON ===');
console.log(`metric                          | ${labelBaseline.padEnd(18)} | ${labelCurrent}`);
console.log('--------------------------------|--------------------|--------------');
const b = baseline.totals, c = current.totals;
function row(name, bv, cv) {
  console.log(name.padEnd(31) + ' | ' + String(bv).padEnd(18) + ' | ' + cv);
}
row('videos_scanned',                  b.videos_scanned,                c.videos_scanned);
row('total_captures',                  b.total_captures,                c.total_captures);
row('captures_status_done',            b.captures_status_done,          c.captures_status_done);
row('captures_with_observed_date',     b.captures_with_observed_date,   c.captures_with_observed_date);
row('intro_card_captures',             b.intro_card_captures,           c.intro_card_captures);
row('whiteboard_segments_total',       b.whiteboard_segments_total,     c.whiteboard_segments_total);
row('intro_card_segments',             b.intro_card_segments,           c.intro_card_segments);
row('captures_with_tickers',           b.captures_with_tickers ?? 0,    c.captures_with_tickers);
row('unique_tickers',                  (b.unique_tickers || []).length, (c.unique_tickers || []).length);
row('unique_phashes',                  (b.unique_phashes || []).length, (c.unique_phashes || []).length);
row('phash_collisions',                b.phash_collisions ?? 0,         c.phash_collisions);
row('captures_with_keyframe_ts',       b.captures_with_keyframe_ts ?? 0, c.captures_with_keyframe_ts);
row('videos_with_keyframe_lookup_skipped', b.videos_with_keyframe_lookup_skipped ?? 0, c.videos_with_keyframe_lookup_skipped);
row('unique_screen_layouts',           b.unique_screen_layouts.join(','), c.unique_screen_layouts.join(','));

console.log('');
console.log('=== PER-VIDEO BREAKDOWN ===');
current.videos.forEach((cv, i) => {
  const bv = baseline.videos[i];
  const match = bv && bv.video_path === cv.video_path;
  const name = cv.video_path.split(/[\\/]/).pop().slice(0, 50);
  const obsDates = [...new Set(cv.captures.map((cap) => cap.observed_date).filter(Boolean))];
  const introCap = cv.captures.filter((cap) => cap.is_intro_card).length;
  const tickersCap = cv.captures.filter((cap) => (cap.tickers || []).length > 0).length;
  const phashesSet = new Set(cv.captures.map((cap) => cap.phash).filter(Boolean));
  const segs = cv.whiteboard_segments || [];
  const introSeg = segs.filter((s) => s.is_intro_card).length;
  console.log((match ? 'OK ' : '!! ') + name);
  console.log('  date_key=' + cv.date_key + ' status=' + cv.status);
  console.log('  observed_dates=' + JSON.stringify(obsDates));
  console.log('  intro_card_captures=' + introCap + '/' + cv.captures.length + '  segments=' + segs.length + ' (intro=' + introSeg + ')');
  console.log('  tickers_captures=' + tickersCap + '/' + cv.captures.length + '  unique_phashes=' + phashesSet.size);
  if (cv.ocr_engine_metadata) {
    console.log('  ocr_engine=' + cv.ocr_engine_metadata.tesseract_version + ' lang=' + cv.ocr_engine_metadata.language);
  }
  console.log('  keyframe_lookup=' + (cv.nearest_ffmpeg_keyframe_lookups_skipped ? 'skipped' : `${cv.nearest_ffmpeg_keyframe_pts_total} pts`));
  if (Array.isArray(cv.top_rejected_candidates) && cv.top_rejected_candidates.length) {
    cv.top_rejected_candidates.slice(0, 3).forEach((rej, ri) => {
      console.log(`    rejected #${ri + 1}: t=${rej.timestamp.toFixed(1)}s score=${rej.score.toFixed(1)} layout=${rej.screen_layout}`);
    });
  }
  segs.forEach((seg, si) => {
    console.log('    seg ' + (si + 1) + ': layout=' + seg.layout + ' captures=' + seg.capture_count +
                ' peak=' + seg.peak_score.toFixed(1) + ' intro=' + seg.is_intro_card);
  });
});