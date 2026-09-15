'use strict';

// Aggregate every probe-log JSON in a given OCR run-tag directory into a single
// timeline.json that a Chart.js viewer can render. The output is a per-video
// row + per-day rollup so the viewer can show both the granular timeline and
// a daily summary.
//
// Usage:
//   node tools/aggregateOcrTimeline.js <run-tag>
//
// Reads:
//   data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>/ocr_probe/logs/*.json
// Writes:
//   data/video_scan_<YYYYMMDD>/<run-tag>/timeline.json

const fs = require('node:fs');
const path = require('node:path');

const tag = process.argv[2];
if (!tag) {
  console.error('Usage: node tools/aggregateOcrTimeline.js <run-tag>');
  process.exit(1);
}

const today = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = `${today.getUTCFullYear()}${pad2(today.getUTCMonth() + 1)}${pad2(today.getUTCDate())}`;

const root = path.resolve('data', `video_scan_${dateKey}`, tag);
const probeLogsBase = path.join(root, tag, 'ocr_probe', 'logs');

if (!fs.existsSync(probeLogsBase)) {
  console.error(`No probe logs at ${probeLogsBase}. Run 'npm run video:scan-ocr' or 'tools/runAllOcr.js' first.`);
  process.exit(1);
}

function safeReadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

const parseLogFilename = (filename) => {
  const match = filename.match(/^(\d{8})_(\d{8})_([A-Za-z0-9_-]{6,15})_([a-f0-9]{8})_whiteboard\.json$/);
  if (!match) return null;
  const [, , uploadDate, videoId] = match;
  return { uploadDate, videoId };
};

const isMockVideo = (videoId) => /^(abc123|def456)$/i.test(videoId);

const files = fs.readdirSync(probeLogsBase).filter((f) => f.endsWith('.json'));
console.log(`[aggregate-timeline] ${files.length} probe logs in ${probeLogsBase}`);

const perVideo = [];
const dailyRollup = new Map();
let totalCaptures = 0;
let totalVideos = 0;
let totalVideosWithCaptures = 0;
const layoutCounts = Object.create(null);
const segCounts = Object.create(null);
const allTickers = new Set();
const tickerFrequency = new Map();
const typeCounts = Object.create(null);
const untypedVideos = [];

for (const file of files) {
  const parsed = parseLogFilename(file);
  if (!parsed) continue;
  const { uploadDate, videoId } = parsed;
  if (isMockVideo(videoId)) continue;

  const log = safeReadJSON(path.join(probeLogsBase, file));
  if (!log) continue;
  if (log.status !== 'done') continue;

  const captures = Array.isArray(log.captures) ? log.captures : [];
  const segments = Array.isArray(log.whiteboard_segments) ? log.whiteboard_segments : [];
  const videoType = log.video_type || 'untagged';
  typeCounts[videoType] = (typeCounts[videoType] || 0) + 1;
  if (videoType === 'untagged') untypedVideos.push({ video_id: videoId, upload_date: uploadDate });

  if (captures.length === 0) {
    perVideo.push({
      upload_date: uploadDate,
      video_id: videoId,
      video_type: videoType,
      video_type_label: log.video_type_label || videoType,
      captures: 0,
      max_score: 0,
      mean_score: 0,
      layouts: [],
      has_dmi_intro: false,
      ticker_union: [],
      segments: segments.length
    });
    upsertDay(uploadDate, 0, 0, 0, [], false, [], 0, segments.length, videoType);
    continue;
  }

  let maxScore = -Infinity;
  let scoreSum = 0;
  const perLayouts = new Map();
  const dayTickers = new Set();
  const hasDMIIntro = segments.some((s) => s.layout === 'dmi' && s.is_intro_card);
  segments.forEach((s) => { segCounts[s.layout || 'unknown'] = (segCounts[s.layout || 'unknown'] || 0) + 1; });

  for (const cap of captures) {
    if (typeof cap.score === 'number') {
      if (cap.score > maxScore) maxScore = cap.score;
      scoreSum += cap.score;
    }
    const layout = cap.screen_layout || 'unknown';
    perLayouts.set(layout, (perLayouts.get(layout) || 0) + 1);
    layoutCounts[layout] = (layoutCounts[layout] || 0) + 1;

    for (const t of cap.tickers || []) {
      if (!t) continue;
      dayTickers.add(t);
      allTickers.add(t);
      tickerFrequency.set(t, (tickerFrequency.get(t) || 0) + 1);
    }
  }

  const meanScore = scoreSum / captures.length;
  const finalMax = captures.length === 0 ? 0 : maxScore;
  const layouts = [...perLayouts.entries()].map(([k, v]) => ({ layout: k, count: v }));
  const tickerUnion = [...dayTickers].sort();

  totalCaptures += captures.length;
  totalVideos += 1;
  totalVideosWithCaptures += 1;

  perVideo.push({
    upload_date: uploadDate,
    video_id: videoId,
    video_type: videoType,
    video_type_label: log.video_type_label || videoType,
    captures: captures.length,
    max_score: Number(finalMax.toFixed(2)),
    mean_score: Number(meanScore.toFixed(2)),
    layouts,
    has_dmi_intro: hasDMIIntro,
    ticker_union: tickerUnion,
    segments: segments.length
  });

  upsertDay(uploadDate, captures.length, captures.length, finalMax, layouts, hasDMIIntro, tickerUnion, meanScore, segments.length, videoType);
}

perVideo.sort((a, b) => (a.upload_date || '').localeCompare(b.upload_date || '') || (a.video_id || '').localeCompare(b.video_id || ''));

const perDay = [...dailyRollup.values()].sort((a, b) => a.date.localeCompare(b.date));

// finalize mean + union + type counts (must run BEFORE writeFileSync below)
for (const row of perDay) {
  row.mean_score = row.mean_score_count ? Number((row.mean_score_sum / row.mean_score_count).toFixed(2)) : 0;
  row.ticker_union_size = row.ticker_union.size;
  row.ticker_union = [...row.ticker_union].sort();
  row.video_type_counts = row.video_type_counts || {};
  // If this day had zero unclassified-tagged videos at rollup start, the
  // object is sparse; convert to a stable sorted array of {type, count}.
  delete row.mean_score_sum;
  delete row.mean_score_count;
}

const timeline = {
  run_tag: tag,
  generated_at: new Date().toISOString(),
  totals: {
    videos: totalVideos,
    videos_with_captures: totalVideosWithCaptures,
    captures: totalCaptures,
    layouts: layoutCounts,
    segment_layouts: segCounts,
    video_type_counts: typeCounts,
    unique_tickers: allTickers.size,
    top_tickers: [...tickerFrequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([ticker, count]) => ({ ticker, count })),
    untyped_videos: untypedVideos
  },
  per_video: perVideo,
  per_day: perDay
};

const outPath = path.join(root, 'timeline.json');
fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2));
console.log(`[aggregate-timeline] wrote ${outPath}`);
const typeSummary = Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`[aggregate-timeline] totals: ${totalVideos} videos (${totalVideosWithCaptures} with captures), ${totalCaptures} captures, ${allTickers.size} unique tickers, ${perDay.length} active days`);
if (typeSummary) console.log(`[aggregate-timeline] video types: ${typeSummary}`);
if (untypedVideos.length) console.log(`[aggregate-timeline] ${untypedVideos.length} untagged videos: ${untypedVideos.slice(0, 5).map((v) => `${v.upload_date}/${v.video_id}`).join(', ')}…`);

function upsertDay(date, capturedDelta, capturedCount, maxScore, layouts, hasDmiIntro, tickerUnion, meanScore, segments, videoType) {
  if (!date || date === 'unknown') return;
  const row = dailyRollup.get(date) || {
    date,
    captures: 0,
    videos: 0,
    max_score: 0,
    mean_score_sum: 0,
    mean_score_count: 0,
    has_dmi_intro_count: 0,
    layouts: Object.create(null),
    ticker_union: new Set(),
    segments: 0,
    video_type_counts: Object.create(null)
  };
  row.captures += capturedCount;
  row.videos += 1;
  if (maxScore > row.max_score) row.max_score = Number(maxScore.toFixed(2));
  if (typeof meanScore === 'number') {
    row.mean_score_sum += meanScore;
    row.mean_score_count += 1;
  }
  if (hasDmiIntro) row.has_dmi_intro_count += 1;
  for (const { layout, count } of layouts || []) row.layouts[layout] = (row.layouts[layout] || 0) + count;
  for (const t of tickerUnion) row.ticker_union.add(t);
  row.segments += segments;
  const t = videoType || 'untagged';
  row.video_type_counts[t] = (row.video_type_counts[t] || 0) + 1;
  dailyRollup.set(date, row);
}

