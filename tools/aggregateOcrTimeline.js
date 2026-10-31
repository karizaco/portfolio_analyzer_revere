'use strict';

// Aggregate every probe-log JSON in one or more OCR run-tag directories into a
// single timeline.json that a Chart.js viewer can render. The output is a
// per-video row + per-day rollup so the viewer can show both the granular
// timeline and a daily summary. Multiple run-tags can be merged (comma-
// separated) so Qullamaggie + Revere runs in the same scan-date directory
// can produce a unified viewer.
//
// Usage:
//   node tools/aggregateOcrTimeline.js <run-tag>[,<run-tag>...]
//
// Reads:
//   data/video_scan_<YYYYMMDD>/<run-tag>/<run-tag>/ocr_probe/logs/*.json
// Writes:
//   data/video_scan_<YYYYMMDD>/<run-tag>/timeline.json  (uses FIRST tag as
//     the output directory; subsequent tags are merged into the same output).

const fs = require('node:fs');
const path = require('node:path');

// Optional --date-tag YYYYMMDD flag (defaults to today's UTC). Lets the script
// aggregate scans from prior dates — e.g. a `qmg-ocr-20260917-missing19` run
// that lives under `data/video_scan_20260917/` even when the script is invoked
// on a later day.
function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}

const argv = process.argv.slice(2);
const dateTagArg = readFlag(argv, '--date-tag');
const positional = argv.filter((a) => !a.startsWith('--') && a !== dateTagArg);

const tagArg = positional[0];
if (!tagArg) {
  console.error('Usage: node tools/aggregateOcrTimeline.js [--date-tag YYYYMMDD] <run-tag>[,<run-tag>...]');
  process.exit(1);
}
const tags = String(tagArg).split(',').map((value) => value.trim()).filter(Boolean);
if (!tags.length) {
  console.error('No run-tag provided. Usage: node tools/aggregateOcrTimeline.js [--date-tag YYYYMMDD] <run-tag>[,<run-tag>...]');
  process.exit(1);
}

const today = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = dateTagArg
  || `${today.getUTCFullYear()}${pad2(today.getUTCMonth() + 1)}${pad2(today.getUTCDate())}`;
if (!/^\d{8}$/.test(dateKey)) {
  console.error(`Invalid --date-tag '${dateTagArg}' (expected YYYYMMDD)`);
  process.exit(1);
}

function resolveProbeLogsBase(tag) {
  return path.resolve('data', `video_scan_${dateKey}`, tag, 'ocr_probe', 'logs');
}

const missingTags = tags.filter((tag) => !fs.existsSync(resolveProbeLogsBase(tag)));
if (missingTags.length === tags.length) {
  console.error(`No probe logs found for any of: ${tags.join(', ')} under data/video_scan_${dateKey}/. Run 'npm run video:scan-ocr' or 'tools/runAllOcr.js' first, or pass --date-tag to point at a prior scan date.`);
  process.exit(1);
}
if (missingTags.length) {
  console.error(`[aggregate-timeline] warning: missing probe logs for ${missingTags.join(', ')}; continuing with the rest`);
}

function safeReadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

const parseLogFilename = (filename) => {
  const match = filename.match(/^(\d{8})_(\d{8})_([A-Za-z0-9_-]{6,15})_([a-f0-9]{8})_(whiteboard|snapshot)\.json$/);
  if (!match) return null;
  // `outputKind` keeps the value this tool has always written to
  // per_video[].output_kind (the 4th capture group); `logKind` is the real
  // whiteboard|snapshot suffix, used to identify one logical scan per video.
  const [, , uploadDate, videoId, outputKind, logKind] = match;
  return { uploadDate, videoId, outputKind, logKind };
};

// Ticker list for one capture, matching getCaptureTickers() in
// tools/aggregateScanResults.js for whiteboard layouts: whiteboard captures
// use the structured GRO/TURBO holdings from the bbox parser
// (tickers_from_bbox), not the raw clusterer output in capture.tickers.
// The scanner stores bbox tickers per parsed observation
// (capture.parsed_observations[].tickers_from_bbox); a capture-level
// tickers_from_bbox array is honoured too. Legacy logs written before the
// bbox parser existed carry no tickers_from_bbox field at all, so they keep
// falling back to capture.tickers. Other layouts are unchanged.
function getTimelineCaptureTickers(cap) {
  const layout = cap.screen_layout;
  if (layout === 'whiteboard' || layout === 'structured_whiteboard') {
    const observations = Array.isArray(cap.parsed_observations) ? cap.parsed_observations : [];
    const hasCaptureBbox = Array.isArray(cap.tickers_from_bbox);
    const obsWithBbox = observations.filter((o) => o && Array.isArray(o.tickers_from_bbox));
    if (hasCaptureBbox || obsWithBbox.length) {
      const bbox = new Set(hasCaptureBbox ? cap.tickers_from_bbox : []);
      for (const o of obsWithBbox) for (const t of o.tickers_from_bbox) bbox.add(t);
      return [...bbox];
    }
  }
  return Array.isArray(cap.tickers) ? cap.tickers : [];
}

const isMockVideo = (videoId) => /^(abc123|def456)$/i.test(videoId);

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
const channelCounts = Object.create(null);
const allChartStreamTickers = new Set();
const untypedVideos = [];

// Retry / re-scan handling: one logical scan is (video_id, whiteboard|snapshot).
// Retries in this repo are separate run-tags merged on the command line after
// the original (e.g. `ocr-20260915,ocr-20260915-p4`, `...-missing19`,
// `...-backfill`), or a later-dated log in the same tag directory. Only
// status=done logs are candidates; among them the LAST one wins, in
// command-line tag order and then filename order (the filename starts with the
// scan date, so a later-dated attempt sorts last). Earlier attempts are
// counted in totals.superseded_attempts instead of being aggregated again.
let processedFiles = 0;
let supersededAttempts = 0;
const attempts = new Map();
for (const tag of tags) {
  const probeLogsBase = resolveProbeLogsBase(tag);
  if (!fs.existsSync(probeLogsBase)) continue;
  const files = fs.readdirSync(probeLogsBase).filter((f) => f.endsWith('.json')).sort();
  console.log(`[aggregate-timeline] ${files.length} probe logs in ${probeLogsBase} (tag=${tag})`);

  for (const file of files) {
    const parsed = parseLogFilename(file);
    if (!parsed) continue;
    if (isMockVideo(parsed.videoId)) continue;

    const log = safeReadJSON(path.join(probeLogsBase, file));
    if (!log) continue;
    if (log.status !== 'done') continue;

    processedFiles += 1;
    const key = `${parsed.videoId}|${parsed.logKind}`;
    if (attempts.has(key)) {
      supersededAttempts += 1;
      attempts.delete(key);
    }
    attempts.set(key, { parsed, log });
  }
}

for (const { parsed, log } of attempts.values()) {
  const { uploadDate, videoId, outputKind } = parsed;
  const captures = Array.isArray(log.captures) ? log.captures : [];
  const segments = Array.isArray(log.whiteboard_segments) ? log.whiteboard_segments : [];
  const videoType = log.video_type || 'untagged';
  typeCounts[videoType] = (typeCounts[videoType] || 0) + 1;
  const channel = log.channel || (log.basename && log.basename !== 'revere' ? log.basename : 'revere');
  channelCounts[channel] = (channelCounts[channel] || 0) + 1;
  if (videoType === 'untagged') untypedVideos.push({ video_id: videoId, upload_date: uploadDate, channel });

  if (captures.length === 0) {
    perVideo.push({
      upload_date: uploadDate,
      video_id: videoId,
      video_type: videoType,
      video_type_label: log.video_type_label || videoType,
      channel,
      output_kind: outputKind,
      captures: 0,
      max_score: 0,
      mean_score: 0,
      layouts: [],
      has_dmi_intro: false,
      ticker_union: [],
      chart_stream_tickers: [],
      segments: segments.length
    });
    totalVideos += 1; // count scanned videos with zero captures
    upsertDay(uploadDate, 0, 0, 0, [], false, [], 0, segments.length, videoType);
    continue;
  }

  let maxScore = -Infinity;
  let scoreSum = 0;
  const perLayouts = new Map();
  const dayTickers = new Set();
  const dayChartStreamTickers = new Set();
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

    for (const t of getTimelineCaptureTickers(cap)) {
      if (!t) continue;
      dayTickers.add(t);
      allTickers.add(t);
      tickerFrequency.set(t, (tickerFrequency.get(t) || 0) + 1);
    }

    const capChartStream = cap.chart_stream;
    if (capChartStream && Array.isArray(capChartStream.position_list)) {
      for (const t of capChartStream.position_list) {
        if (!t) continue;
        dayChartStreamTickers.add(t);
        allChartStreamTickers.add(t);
      }
    }
  }

  const meanScore = scoreSum / captures.length;
  const finalMax = captures.length === 0 ? 0 : maxScore;
  const layouts = [...perLayouts.entries()].map(([k, v]) => ({ layout: k, count: v }));
  const tickerUnion = [...dayTickers].sort();
  const chartStreamTickers = [...dayChartStreamTickers].sort();

  totalCaptures += captures.length;
  totalVideos += 1;
  totalVideosWithCaptures += 1;

  perVideo.push({
    upload_date: uploadDate,
    video_id: videoId,
    video_type: videoType,
    video_type_label: log.video_type_label || videoType,
    channel,
    output_kind: outputKind,
    captures: captures.length,
    max_score: Number(finalMax.toFixed(2)),
    mean_score: Number(meanScore.toFixed(2)),
    layouts,
    has_dmi_intro: hasDMIIntro,
    ticker_union: tickerUnion,
    chart_stream_tickers: chartStreamTickers,
    segments: segments.length
  });

  upsertDay(uploadDate, captures.length, captures.length, finalMax, layouts, hasDMIIntro, tickerUnion, meanScore, segments.length, videoType);
}

console.log(`[aggregate-timeline] merged ${processedFiles} done probe logs across ${tags.length} run-tag(s)`);
if (supersededAttempts) console.log(`[aggregate-timeline] ${supersededAttempts} earlier attempt(s) superseded by a later retry of the same video`);

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
  run_tag: tags.join(','),
  run_tags: tags,
  generated_at: new Date().toISOString(),
  totals: {
    videos: totalVideos,
    videos_with_captures: totalVideosWithCaptures,
    captures: totalCaptures,
    layouts: layoutCounts,
    segment_layouts: segCounts,
    video_type_counts: typeCounts,
    channel_counts: channelCounts,
    unique_tickers: allTickers.size,
    unique_chart_stream_tickers: allChartStreamTickers.size,
    top_tickers: [...tickerFrequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([ticker, count]) => ({ ticker, count })),
    untyped_videos: untypedVideos,
    superseded_attempts: supersededAttempts
  },
  per_video: perVideo,
  per_day: perDay
};

const outRoot = path.resolve('data', `video_scan_${dateKey}`, tags[0]);
const outPath = path.join(outRoot, 'timeline.json');
fs.writeFileSync(outPath, JSON.stringify(timeline, null, 2));
console.log(`[aggregate-timeline] wrote ${outPath}`);
const typeSummary = Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(' ');
const channelSummary = Object.entries(channelCounts).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`[aggregate-timeline] totals: ${totalVideos} videos (${totalVideosWithCaptures} with captures), ${totalCaptures} captures, ${allTickers.size} unique tickers, ${perDay.length} active days`);
if (typeSummary) console.log(`[aggregate-timeline] video types: ${typeSummary}`);
if (channelSummary) console.log(`[aggregate-timeline] channels: ${channelSummary}`);
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
