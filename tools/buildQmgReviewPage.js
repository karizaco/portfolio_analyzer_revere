'use strict';

/**
 * buildQmgReviewPage.js
 *
 * Reads data/video_ocr_probe/analysis.json and
 * data/video_ocr_probe/qmg-1080p-batch1/snapshots/
 * and writes tools/qmg_snapshot_review.html
 *
 * Usage: node tools/buildQmgReviewPage.js
 */

const fs = require('fs');
const path = require('path');

const ANALYSIS_JSON = 'data/video_ocr_probe/analysis.json';
const SNAPSHOT_DIR_BATCH1 = 'data/video_ocr_probe/qmg-1080p-batch1/snapshots';
const SNAPSHOT_DIR_BATCH2 = 'data/video_ocr_probe/qmg-1080p-batch2/snapshots';
const OUTPUT_HTML = path.join(__dirname, 'qmg_snapshot_review.html');

// Snapshot dirs map: probe-tag → snapshot dir
const SNAPSHOT_DIRS = {
  'qmg-1080p-batch1': SNAPSHOT_DIR_BATCH1,
  'qmg-1080p-batch2': SNAPSHOT_DIR_BATCH2,
};

// Probe log layout is identical to batch2 (one log file per video under
// <batch>/ocr_probe/logs/*.json). Auto-discover any such subdir under
// data/video_ocr_probe/ — keeps the review page in sync with future
// validation runs (val_baseline_*, val_filtered_*, qmg-1080p-batch3, ...).
const PROBE_ROOT = 'data/video_ocr_probe';
const KNOWN_BATCHES = new Set(Object.keys(SNAPSHOT_DIRS));
if (fs.existsSync(PROBE_ROOT)) {
  for (const entry of fs.readdirSync(PROBE_ROOT)) {
    const logDir = path.join(PROBE_ROOT, entry, 'ocr_probe', 'logs');
    if (!fs.existsSync(logDir)) continue;
    if (KNOWN_BATCHES.has(entry)) continue;
    // Skip the legacy batch1 folder — it reads from analysis.json, not
    // per-video log files.
    if (entry === 'qmg-1080p-batch1') continue;
    SNAPSHOT_DIRS[entry] = path.join(PROBE_ROOT, entry, 'snapshots');
  }
}

// Human-verified ground truth tickers per snapshot (dateKey → capture-index → gt list)
// For captures beyond the first: ci=0 → no suffix, ci=1 → "_2", ci=2 → "_3", etc.
// Crop coordinates are pixel bounds (x1,y1 top-left → x2,y2 bottom-right) on the source frame.
const GROUND_TRUTH = {
  '20220606': {
    0: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    // ci=1 and ci=2 were later corrected from direct user GT for qmg_20220606_2/_3.
    1: ['BOIL','LABU','UCO','ALB','CBIO','TNA','NFLX','SIGA'],
    2: ['BOIL','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    3: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    4: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    5: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    6: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    7: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    8: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    9: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    10: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
    11: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
  },
  '20220607': {
    0: ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM'],
    1: ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM'],
    2: ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM'],
  },
  '20220608': {
    0: ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC'],
    1: ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC'],
    2: ['SIGA','TNA','VLO','UCO','NFLX','ALB','BOIL','LTHM','AERC'],
  },
  '20220614': {
    0: { tickers: ['UVXY','VLO','UCO'], crop: [1716, 706, 1907, 778] },
    1: { tickers: ['UVXY','VLO','UCO'], crop: [1716, 706, 1907, 778] },
    2: { tickers: ['UVXY','VLO','UCO'], crop: [1716, 706, 1907, 778] },
  },
  '20220323': {
    1: { tickers: ['BOIL','JNUG','NUGT','X','URA','FCX','WEAT','COPX','URNM','REGN','KWEB'], crop: [1766, 705, 1911, 906] },
  },
  '20220510': {
    1: { tickers: ['VRM','TSLA'], crop: [1757, 703, 1903, 1022] },
  },
  '20220427': {
    6: { tickers: ['TSLA','BOIL','WEAT','KOLD','KWEB','CWEB'], crop: [1776, 653, 1916, 1023] },
  },
  '20220421': {
    1: ['FCX','JNUG','NUGT','COPX','WEAT','VERU','URNM','URA','REGN','X','GUSH','LAC','FTNT','BOIL','TSLA'],
    2: ['FCX','JNUG','NUGT','COPX','WEAT','VERU','URNM','URA','REGN','X','GUSH','LAC','FTNT','BOIL','TSLA'],
  },
  '20220425': {
    1: ['KOLD','WEAT','VERU','BOIL'],
  },
  '20220428': {
    1: { tickers: ['CWEB','KWEB','TSLA','WEAT'], crop: [1735, 653, 1912, 1024] },
  },
  '20220506': {
    1: ['UCO','WEAT','TSLA','LTHM'],
  },
  '20221104': {
    0: [],   // not in ground truth set
    1: [],
    2: ['OIH'],
  },
  '20221117': {
    0: ['FREY','OIH','ASML','U','SI','SOXL'],
    1: ['FREY','OIH','ASML','U','SI','SOXL'],
    2: ['FREY','OIH','ASML','U','SI','SOXL'],
  },
  '20230126': {
    0: ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS'],
    1: ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS'],
    2: ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS'],
  },
  '20230609': {
    2: ['RGTI','QBTS','IMGN','CVNA','IOT','ARQQ','AI','PLTR','DNA','GTLB','GSIT','APLD','MNDY'],
  },
};

// Probe run timestamps (directory mtime used as approximate run date)
// _batch value → run date
const BATCH_RUN_DATE = {
  'batch1':   '2026-09-20',
  'batch2':   '2026-09-21',
};

// Resolve snapshot paths relative to OUTPUT_HTML's directory
// OUTPUT_HTML is in tools/, so relative from tools/ to snapshots is ../data/...
const SNAPSHOT_RELATIVE_PATH = path.relative(path.dirname(OUTPUT_HTML), SNAPSHOT_DIR_BATCH1).replace(/\\/g, '/');

const d = fs.existsSync(ANALYSIS_JSON)
  ? JSON.parse(fs.readFileSync(ANALYSIS_JSON, 'utf8'))
  : { videos: [] };
const batch1Videos = d.videos || [];

// Also read batch2 probe logs directly
const BATCH2_LOG_DIR = 'data/video_ocr_probe/qmg-1080p-batch2/ocr_probe/logs';
const batch2Videos = [];

function snapPath(absPath, snapshotDirs) {
  if (!absPath) return null;
  const rel = path.relative(path.dirname(OUTPUT_HTML), absPath).replace(/\\/g, '/');
  return rel;
}

// Build a map of batch2 captures from their probe log files.
// Also covers any auto-discovered batch (val_baseline_*, val_filtered_*, ...).
const batch2Captures = [];
function readBatchLogs(batchLabel, logDir) {
  if (!fs.existsSync(logDir)) return;
  const logFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.json'));
  for (const lf of logFiles) {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(logDir, lf), 'utf8'));
      const caps = log.captures || [];
      for (const c of caps) {
        const dateKey = log.date_key || '';
        const videoId = log.video_id || '';
        batch2Captures.push({
          dateKey,
          videoId,
          logPath: path.join(logDir, lf),
          c,
          log,
          _batch: batchLabel,
        });
      }
    } catch(e) {}
  }
}
readBatchLogs('batch2', BATCH2_LOG_DIR);
for (const batchLabel of Object.keys(SNAPSHOT_DIRS)) {
  if (batchLabel === 'qmg-1080p-batch1' || batchLabel === 'qmg-1080p-batch2') continue;
  const logDir = path.join(PROBE_ROOT, batchLabel, 'ocr_probe', 'logs');
  readBatchLogs(batchLabel, logDir);
}

// Group batch2 + auto-discovered captures by (dateKey + batch label) so a
// val_baseline_20220614 capture and a val_filtered_20220614 capture appear
// as two distinct "videos" with their own rows.
const batch2ByVideo = {};
for (const cap of batch2Captures) {
  const key = `${cap.dateKey}|${cap._batch}`;
  if (!batch2ByVideo[key]) batch2ByVideo[key] = [];
  batch2ByVideo[key].push(cap);
}

// Build unified video list
const allVideos = [];

// Add batch1 videos
for (const v of batch1Videos) {
  allVideos.push({ ...v, _batch: 'batch1' });
}

// Add batch2 + auto-discovered videos (by dateKey + batch)
for (const key of Object.keys(batch2ByVideo).sort()) {
  const caps = batch2ByVideo[key];
  const dateKey = caps[0].dateKey;
  const batchLabel = caps[0]._batch;
  allVideos.push({
    date_key: dateKey,
    video_path: '',
    captures: caps.map(c => c.c),
    _batch: batchLabel,
    _logPath: caps[0]?.logPath || '',
  });
}

const videos = allVideos;

function hms(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function confColor(conf) {
  if (conf >= 60) return '#4ade80';
  if (conf >= 40) return '#fbbf24';
  return '#f87171';
}

// Build per-video + per-capture data
const videoRows = [];
for (const v of videos) {
  const dateKey = v.date_key || '';
  const videoId = path.basename(v.video_path || '', '.mp4').substring(0, 20);
  for (let ci = 0; ci < v.captures.length; ci++) {
    const c = v.captures[ci];
    const snapIdx = ci === 0 ? '' : String(ci + 1);
    const snapFile = `qmg_${dateKey}${snapIdx ? '_' + snapIdx : ''}.png`;
    // Use batch-specific snapshot dir
    const snapDir = SNAPSHOT_DIRS[v._batch] || SNAPSHOT_DIR_BATCH1;
    const snapAbs = path.join(snapDir, snapFile);
    const snapRel = snapPath(snapAbs);
    const conf = c.ocr_confidence != null ? Number(c.ocr_confidence) : null;
    const confStr = conf != null ? conf.toFixed(0) : '—';
    const tickers = Array.isArray(c.tickers) ? c.tickers : [];
    const layout = c.screen_layout || '—';
    const ts = c.timestamp != null ? c.timestamp : 0;
    const tsHms = c.timestamp_hms || hms(ts);
    const phOv = c.phash_overlay || '—';
    const ocrText = c.ocr_text || '';
    const chartStream = c.chart_stream;
    const positionList = chartStream && Array.isArray(chartStream.position_list)
      ? chartStream.position_list : tickers;
    const parseStatus = chartStream ? chartStream.parse_status : '—';
    const chartConf = chartStream && chartStream.confidence != null
      ? (chartStream.confidence * 100).toFixed(0) : '—';
    const priceAction = chartStream && chartStream.price_action
      ? chartStream.price_action.replace(/\n/g, ' ').trim().substring(0, 60) : '—';
    const ocrSnippet = c.ocr_text_snippet || ocrText.substring(0, 120).replace(/\n/g, ' ');

    // Ground truth: handle both old array format and new object format
    const rawGt = GROUND_TRUTH[dateKey]?.[ci];
    let gtTickers = null;
    let gtCrop = null;
    if (rawGt != null) {
      if (Array.isArray(rawGt)) {
        gtTickers = rawGt;
      } else {
        gtTickers = rawGt.tickers;
        gtCrop = rawGt.crop ? rawGt.crop.join(',') : null;
      }
    }

    // Run date: derived from the probe batch
    const runDate = BATCH_RUN_DATE[v._batch] || '—';

    videoRows.push({
      dateKey,
      videoId,
      snapRel,
      snapFile,
      conf,
      confStr,
      tickers,
      tickerStr: tickers.join(', ') || '—',
      layout,
      ts,
      tsHms,
      phOv,
      ocrText: escapeHtml(ocrText),
      ocrSnippet: escapeHtml(ocrSnippet),
      parseStatus,
      chartConf,
      priceAction: escapeHtml(priceAction),
      positionList,
      isTot: layout === 'tale_of_the_tape',
      gtTickers,
      gtCrop,
      runDate,
    });
  }
}

// Compute stats
const totalVideos = videos.length;
const totalCaptures = videoRows.length;
const confs = videoRows.map(r => r.conf).filter(c => c != null);
const meanConf = confs.length
  ? (confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1)
  : '—';
const uniqueTickers = [...new Set(videoRows.flatMap(r => r.tickers))].sort();

const uniqueTickersJson = JSON.stringify(uniqueTickers);
const rowsJson = JSON.stringify(videoRows);

// ─── HTML template ────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QMG Snapshot Review — ${totalVideos} videos · ${totalCaptures} captures</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117;
    --bg2: #161b22;
    --bg3: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text2: #8b949e;
    --accent: #58a6ff;
    --green: #4ade80;
    --yellow: #fbbf24;
    --red: #f87171;
    --purple: #c084fc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 13px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
  .header h1 { font-size: 16px; font-weight: 600; color: var(--text); }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text2); }
  .stat-value { font-size: 18px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
  .filters { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 10px 20px; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .filter-group { display: flex; align-items: center; gap: 6px; }
  .filter-label { font-size: 11px; color: var(--text2); }
  input[type="text"], select { background: var(--bg3); border: 1px solid var(--border); color: var(--text); padding: 4px 8px; border-radius: 4px; font-size: 12px; font-family: inherit; }
  input[type="text"] { width: 120px; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 500; font-family: 'JetBrains Mono', monospace; }
  .badge-chart { background: rgba(88,166,255,0.15); color: var(--accent); }
  .badge-tot { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .badge-ok { background: rgba(74,222,128,0.15); color: var(--green); }
  .badge-err { background: rgba(248,113,113,0.15); color: var(--red); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--bg2); position: sticky; top: 0; text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: var(--bg2); }
  tr.expanded td { background: rgba(88,166,255,0.05); }
  .conf-cell { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 500; }
  .recall-cell { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 600; color: var(--accent); }
  .ticker-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .ticker { background: rgba(88,166,255,0.12); color: var(--accent); padding: 1px 6px; border-radius: 3px; font-size: 11px; font-family: 'JetBrains Mono', monospace; font-weight: 500; }
  .ts { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text2); }
  .ph { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text2); }
  .ocr-snippet { font-size: 11px; color: var(--text2); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-actions { text-align: right; }
  .expand-btn { background: none; border: 1px solid var(--border); color: var(--text2); border-radius: 3px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  .expand-btn:hover { background: var(--bg3); color: var(--text); }
  .detail-row td { padding: 0; }
  .detail { display: none; background: var(--bg2); padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .detail.open { display: table-row; }
  .detail-inner { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; max-width: 1200px; }
  .detail-snap { display: flex; flex-direction: column; gap: 8px; }
  .detail-snap img { max-width: 100%; border-radius: 6px; border: 1px solid var(--border); background: var(--bg3); }
  .detail-right { display: flex; flex-direction: column; gap: 12px; }
  .detail-section { display: flex; flex-direction: column; gap: 4px; }
  .detail-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text2); }
  .detail-value { font-size: 12px; color: var(--text); }
  .ocr-text { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 10px; font-family: 'JetBrains Mono', monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; color: var(--text2); line-height: 1.5; }
  .detail-meta { display: grid; grid-template-columns: repeat(4, auto); gap: 16px 24px; align-items: start; }
  .meta-item { display: flex; flex-direction: column; gap: 2px; }
  .meta-key { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); }
  .meta-val { font-size: 12px; font-family: 'JetBrains Mono', monospace; font-weight: 500; }
  .count-badge { background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; }
  .no-tot .tot-tag { display: none; }
  tr.tot-row td { border-left: 3px solid var(--yellow); }
  tr.tot-row td:first-child { padding-left: 9px; }
  .run-date { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text2); }
  .gt-cell { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--green); }
  .crop-cell { font-size: 10px; color: var(--text2); background: var(--bg3); padding: 1px 4px; border-radius: 3px; margin-left: 4px; }
</style>
</head>
<body>

<div class="header">
  <h1>QMG Snapshot Review</h1>
  <div class="stat">
    <span class="stat-label">Videos</span>
    <span class="stat-value">${totalVideos}</span>
  </div>
  <div class="stat">
    <span class="stat-label">Captures</span>
    <span class="stat-value">${totalCaptures}</span>
  </div>
  <div class="stat">
    <span class="stat-label">Mean OCR Conf</span>
    <span class="stat-value">${meanConf}%</span>
  </div>
  <div class="stat">
    <span class="stat-label">Unique Tickers</span>
    <span class="stat-value">${uniqueTickers.length}</span>
  </div>
</div>

<div class="filters">
  <div class="filter-group">
    <span class="filter-label">Min conf:</span>
    <input type="text" id="filterConf" placeholder="e.g. 40">
  </div>
  <div class="filter-group">
    <span class="filter-label">Ticker:</span>
    <input type="text" id="filterTicker" placeholder="e.g. NFLX">
  </div>
  <div class="filter-group">
    <span class="filter-label">Video:</span>
    <input type="text" id="filterVideo" placeholder="e.g. 20220606">
  </div>
  <div class="filter-group">
    <span class="filter-label">Layout:</span>
    <select id="filterLayout">
      <option value="">All</option>
      <option value="chart_stream">chart_stream</option>
      <option value="tale_of_the_tape">tale_of_the_tape</option>
    </select>
  </div>
  <div class="filter-group">
    <span class="filter-label">Show:</span>
    <select id="filterShow">
      <option value="all">All captures</option>
      <option value="lowconf">Low conf (&lt;40)</option>
      <option value="tot">tale_of_the_tape only</option>
    </select>
  </div>
  <button onclick="clearFilters()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Clear</button>
  <span class="filter-label" id="rowCount" style="margin-left:auto;">${totalCaptures} rows</span>
</div>

<div class="table-wrap">
<table id="mainTable">
<thead>
<tr>
  <th></th>
  <th>#</th>
  <th>Video</th>
  <th>Acc</th>
  <th>t (HMS)</th>
  <th>Conf</th>
  <th>Recall</th>
  <th>Tickers (detected)</th>
  <th>Layout</th>
  <th>ph_overlay</th>
  <th>OCR snippet</th>
  <th>Ground truth</th>
</tr>
</thead>
<tbody id="tableBody">
</tbody>
</table>
</div>

<script>
const rows = ${rowsJson};
const uniqueTickers = ${uniqueTickersJson};

function clearFilters() {
  document.getElementById('filterConf').value = '';
  document.getElementById('filterTicker').value = '';
  document.getElementById('filterVideo').value = '';
  document.getElementById('filterLayout').value = '';
  document.getElementById('filterShow').value = 'all';
  render();
}

function filterRow(r) {
  const confThresh = parseFloat(document.getElementById('filterConf').value);
  const tickerFilter = document.getElementById('filterTicker').value.trim().toUpperCase();
  const videoFilter = document.getElementById('filterVideo').value.trim();
  const layoutFilter = document.getElementById('filterLayout').value;
  const showFilter = document.getElementById('filterShow').value;

  if (showFilter === 'tot' && r.layout !== 'tale_of_the_tape') return false;
  if (showFilter === 'lowconf' && (r.conf == null || r.conf >= 40)) return false;
  if (confThresh && (r.conf == null || r.conf >= confThresh)) return false;
  if (tickerFilter && !r.tickers.some(t => t === tickerFilter)) return false;
  if (videoFilter && !r.dateKey.includes(videoFilter)) return false;
  if (layoutFilter && r.layout !== layoutFilter) return false;
  return true;
}

function render() {
  const filtered = rows.filter(filterRow);
  document.getElementById('rowCount').textContent = filtered.length + ' rows';
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  filtered.forEach((r, i) => {
    const confColorStyle = r.conf != null
      ? 'color:' + (r.conf >= 60 ? 'var(--green)' : r.conf >= 40 ? 'var(--yellow)' : 'var(--red)') + ';'
      : '';
    const isTot = r.layout === 'tale_of_the_tape';
    const layoutBadge = isTot
      ? '<span class="badge badge-tot">tot</span>'
      : '<span class="badge badge-chart">chart</span>';
    const tickerBadges = r.tickers.map(t => '<span class="ticker">' + t + '</span>').join('');
    const rowClass = isTot ? 'tot-row' : '';

    const gtCell = r.gtTickers
      ? '<span class="gt-cell">' + r.gtTickers.join(', ') + '</span>'
      : '<span style="color:var(--text2)">—</span>';
    const cropCell = r.gtCrop
      ? '<span class="crop-cell" title="Crop: ' + r.gtCrop + '">' + r.gtCrop + '</span>'
      : '';
    const gtFull = r.gtTickers
      ? r.gtTickers.join(', ') + (r.gtCrop ? '  [' + r.gtCrop + ']' : '')
      : '';

    const tr = document.createElement('tr');
    tr.className = rowClass;
    tr.innerHTML = \`
      <td class="row-actions"><button class="expand-btn" onclick="toggleDetail(this)">+</button></td>
      <td>\${i + 1}</td>
      <td><span class="count-badge">\${r.dateKey}</span></td>
      <td><span class="run-date">\${r.runDate}</span></td>
      <td><span class="ts">\${r.tsHms}</span></td>
      <td><span class="conf-cell" style="\${confColorStyle}">\${r.confStr}</span></td>
      <td>\${r.gtTickers ? '<span class="recall-cell">' + (r.tickers.filter(t => r.gtTickers.includes(t)).length) + '/' + r.gtTickers.length + '</span>' : '<span style="color:var(--text2)">—</span>'}</td>
      <td><div class="ticker-list">\${tickerBadges || '<span style="color:var(--text2)">—</span>'}</div></td>
      <td>\${layoutBadge}</td>
      <td><span class="ph">\${r.phOv}</span></td>
      <td><span class="ocr-snippet" title="\${r.ocrText.replace(/"/g,'&quot;')}">\${r.ocrSnippet}</span></td>
      <td>\${gtFull ? '<span class="gt-cell" title="Ground truth: ' + gtFull.replace(/"/g,'&quot;') + '">' + gtCell + ' ' + cropCell + '</span>' : '<span style="color:var(--text2)">—</span>'}</td>
    \`;
    tbody.appendChild(tr);

    // Detail row
    const detailTr = document.createElement('tr');
    detailTr.className = 'detail-row';
    const detailTd = document.createElement('td');
    detailTd.colSpan = 12;
    detailTd.style.padding = '0';
    const parseStatusBadge = r.parseStatus === 'ok'
      ? '<span class="badge badge-ok">ok</span>'
      : '<span class="badge badge-err">' + r.parseStatus + '</span>';
    detailTd.innerHTML = \`
      <div class="detail" id="detail-\${i}">
        <div class="detail-inner">
          <div class="detail-snap">
            <img src="\${r.snapRel}" alt="Snapshot \${r.snapFile}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                 style="align-items:center;justify-content:center;min-height:120px;">
            <div style="display:none;align-items:center;justify-content:center;min-height:120px;background:var(--bg3);border-radius:6px;border:1px solid var(--border);color:var(--text2);font-size:12px;">
              Snapshot not found: \${r.snapFile}
            </div>
          </div>
          <div class="detail-right">
            <div class="detail-meta">
              <div class="meta-item">
                <span class="meta-key">Timestamp</span>
                <span class="meta-val">\${r.tsHms}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">OCR Conf</span>
                <span class="meta-val" style="\${confColorStyle}">\${r.confStr}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">Parse Status</span>
                <span class="meta-val">\${parseStatusBadge} (\${r.chartConf}%)</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">Layout</span>
                <span class="meta-val">\${r.layout}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">Position List</span>
                <span class="meta-val">\${r.positionList.join(', ') || '—'}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">Price Action</span>
                <span class="meta-val" style="font-size:11px;">\${r.priceAction}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">ph_overlay</span>
                <span class="meta-val" style="font-size:10px;">\${r.phOv}</span>
              </div>
              <div class="meta-item">
                <span class="meta-key">Video</span>
                <span class="meta-val">\${r.dateKey}</span>
              </div>
            </div>
            <div class="detail-section">
              <span class="detail-label">Full OCR Text</span>
              <div class="ocr-text">\${r.ocrText}</div>
            </div>
          </div>
        </div>
      </div>
    \`;
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);
  });
}

function toggleDetail(btn) {
  const tr = btn.closest('tr');
  const nextTr = tr.nextElementSibling;
  if (!nextTr || !nextTr.classList.contains('detail-row')) return;
  const detail = nextTr.querySelector('.detail');
  if (!detail) return;
  const isOpen = detail.classList.contains('open');
  // Close all others first
  document.querySelectorAll('.detail.open').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('tr.expanded').forEach(r => r.classList.remove('expanded'));
  if (!isOpen) {
    detail.classList.add('open');
    tr.classList.add('expanded');
    btn.textContent = '−';
  } else {
    btn.textContent = '+';
  }
}

render();
</script>
</body>
</html>
`;

fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
console.log(`[buildQmgReviewPage] Wrote ${OUTPUT_HTML}`);
console.log(`  Videos: ${totalVideos}, Captures: ${totalCaptures}, Mean conf: ${meanConf}%`);
console.log(`  Unique tickers: ${uniqueTickers.join(', ')}`);
