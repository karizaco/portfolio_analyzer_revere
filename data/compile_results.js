'use strict';

/**
 * buildQmgOcrResults.js
 *
 * Reads probe logs from data/video_scan_test/_rerun/
 * and writes tools/qmg_ocr_results.html
 *
 * Usage: node data/compile_results.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');      // repo root (parent of data/)
const OUTPUT_HTML = path.join(ROOT, 'tools', 'qmg_ocr_results.html');

// ─── Ground truth (user-supplied) ─────────────────────────────────────────────
const GT_FILE = path.join(ROOT, 'data', 'qmg_ground_truth.json');
const gtData = fs.existsSync(GT_FILE) ? JSON.parse(fs.readFileSync(GT_FILE, 'utf8')) : {};
// Build: { dateKey: { captureIdx: gtTickersOrObj } }
const GROUND_TRUTH = {};
for (const [dk, val] of Object.entries(gtData)) {
  if (dk === 'NA') continue;
  if (typeof val === 'object' && val !== null) {
    GROUND_TRUTH[dk] = {};
    for (const [ci, v] of Object.entries(val)) {
      GROUND_TRUTH[dk][ci] = v;
    }
  }
}

// ─── Probe log sources ────────────────────────────────────────────────────────
// PROBE_ROOT = repo/data/video_scan_test/_rerun, snapshots at <tag>/snapshots
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const SOURCES = [
  'qmg-batch-a',
  'qmg-five-ideas-test_qmg-easyocr-v1',
  'qmg-batch2_qmg-easyocr-v1',
  'qmg-batch3_qmg-easyocr-v1',
  'qmg-batch-g',
  'qmg-batch-h',
  'qmg-batch-i',
].map(tag => ({
  tag,
  logDir: path.join(PROBE_ROOT, tag, 'ocr_probe', 'logs'),
  snapDir: path.join(PROBE_ROOT, tag, 'snapshots'),
}));

// ─── Snapshot path resolution ────────────────────────────────────────────────
// snapRel is relative from OUTPUT_HTML's dir (tools/) to the snapshot file
function snapRel(snapAbs) {
  if (!snapAbs || !fs.existsSync(snapAbs)) return null;
  return path.relative(path.dirname(OUTPUT_HTML), snapAbs).replace(/\\/g, '/');
}

// ─── Load captures from all probe logs ───────────────────────────────────────
const allCaptures = []; // { dk, tag, ci, c, log }

for (const src of SOURCES) {
  if (!fs.existsSync(src.logDir)) continue;
  const logFiles = fs.readdirSync(src.logDir).filter(f => f.endsWith('.json'));
  for (const lf of logFiles) {
    try {
      const log = JSON.parse(fs.readFileSync(path.join(src.logDir, lf), 'utf8'));
      const dk = log.date_key || '';
      const caps = log.captures || [];
      caps.forEach((c, ci) => {
        allCaptures.push({ dk, tag: src.tag, ci, c, log });
      });
    } catch (_) {}
  }
}

// ─── Build videoRows (same structure as buildQmgReviewPage.js) ───────────────
function hms(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Group captures by (dk, tag) for deduplication
const byKey = {};
for (const cap of allCaptures) {
  const key = `${cap.dk}|${cap.tag}`;
  if (!byKey[key]) byKey[key] = [];
  byKey[key].push(cap);
}

// For each (dk, tag), pick the version with most captures
const deduped = {};
for (const [key, caps] of Object.entries(byKey)) {
  caps.sort((a, b) => ((b.log || {}).captures || []).length - ((a.log || {}).captures || []).length);
  deduped[key] = caps[0];
}

const videoRows = [];
for (const [key, cap] of Object.entries(deduped)) {
  const { dk, tag, log } = cap;
  const caps = (log || {}).captures || [];

  // Per-capture snapshot
  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const snapIdx = i === 0 ? '' : String(i + 1);
    const snapFile = `qmg_${dk}${snapIdx ? '_' + snapIdx : ''}.png`;
    const snapAbs = path.join(
      SOURCES.find(s => s.tag === tag)?.snapDir || '',
      snapFile
    );
    const snapR = snapRel(snapAbs);

    const tickers = Array.isArray(c.tickers) ? c.tickers : [];
    const layout = c.screen_layout || '—';
    const conf = c.ocr_confidence != null ? Number(c.ocr_confidence) : null;
    const confStr = conf != null ? conf.toFixed(0) : '—';
    const ts = c.timestamp != null ? c.timestamp : 0;
    const tsHms = c.timestamp_hms || hms(ts);
    const phOv = c.phash_overlay || '—';
    const ocrText = c.ocr_text || '';
    const ocrSnippet = (c.ocr_text_snippet || ocrText).substring(0, 120).replace(/\n/g, ' ');
    const chartStream = c.chart_stream || {};
    const positionList = Array.isArray(chartStream.position_list)
      ? chartStream.position_list : tickers;
    const parseStatus = chartStream.parse_status || '—';
    const chartConf = chartStream.confidence != null
      ? (chartStream.confidence * 100).toFixed(0) : '—';
    const priceAction = chartStream.price_action
      ? chartStream.price_action.replace(/\n/g, ' ').trim().substring(0, 60) : '—';

    // Ground truth lookup
    const rawGt = GROUND_TRUTH[dk]?.[i];
    let gtTickers = null;
    let gtCrop = null;
    if (rawGt != null) {
      if (Array.isArray(rawGt)) gtTickers = rawGt;
      else if (rawGt && Array.isArray(rawGt.tickers)) {
        gtTickers = rawGt.tickers;
        gtCrop = rawGt.crop ? rawGt.crop.join(',') : null;
      }
    }

    videoRows.push({
      dateKey: dk,
      videoId: dk,
      snapRel: snapR,
      snapFile,
      conf,
      confStr,
      tickers,
      tickerStr: tickers.join(', ') || '—',
      layout,
      ts,
      tsHms,
      phOv,
      ocrText: escHtml(ocrText),
      ocrSnippet: escHtml(ocrSnippet),
      parseStatus,
      chartConf,
      priceAction: escHtml(priceAction),
      positionList,
      isTot: layout === 'tale_of_the_tape',
      gtTickers,
      gtCrop,
      runDate: new Date().toISOString().substring(0, 10),
    });
  }
}

videoRows.sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.ts - b.ts);

// ─── Aggregate stats ─────────────────────────────────────────────────────────
const totalVideos = new Set(videoRows.map(r => r.dateKey)).size;
const totalCaptures = videoRows.length;
const gtRows = videoRows.filter(r => r.gtTickers);
const gtVideos = new Set(gtRows.map(r => r.dateKey));
let totalGT = 0, totalHits = 0;
gtRows.forEach(r => {
  totalGT += r.gtTickers.length;
  totalHits += r.tickers.filter(t => r.gtTickers.includes(t)).length;
});
const confs = videoRows.map(r => r.conf).filter(c => c != null);
const meanConf = confs.length
  ? (confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1)
  : '—';
const uniqueTickers = [...new Set(videoRows.flatMap(r => r.tickers))].sort();

const rowsJson = JSON.stringify(videoRows);
const uniqueTickersJson = JSON.stringify(uniqueTickers);

// ─── HTML (same structure as buildQmgReviewPage.js) ──────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QMG OCR Results — ${totalVideos} videos · ${totalCaptures} captures</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
    --green: #4ade80; --yellow: #fbbf24; --red: #f87171; --purple: #c084fc;
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
  .badge-gt { background: rgba(74,222,128,0.15); color: var(--green); }
  .badge-nogt { background: rgba(139,148,158,0.15); color: var(--text2); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--bg2); position: sticky; top: 0; text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: rgba(88,166,255,0.04); }
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
  #rowCount { margin-left: auto; font-size: 11px; color: var(--text2); }
</style>
</head>
<body>

<div class="header">
  <h1>QMG OCR Results — qmg-easyocr-v1</h1>
  <div class="stat"><span class="stat-label">Videos</span><span class="stat-value">${totalVideos}</span></div>
  <div class="stat"><span class="stat-label">Captures</span><span class="stat-value">${totalCaptures}</span></div>
  <div class="stat"><span class="stat-label">GT Videos</span><span class="stat-value">${gtVideos.size}</span></div>
  <div class="stat"><span class="stat-label">Recall</span><span class="stat-value">${gtRows.length ? Math.round(totalHits/totalGT*100)+'%' : '—'}</span></div>
  <div class="stat"><span class="stat-label">Mean Conf</span><span class="stat-value">${meanConf}%</span></div>
  <div class="stat"><span class="stat-label">Unique Tickers</span><span class="stat-value">${uniqueTickers.length}</span></div>
</div>

<div class="filters">
  <div class="filter-group"><span class="filter-label">Min conf:</span><input type="text" id="filterConf" placeholder="e.g. 40"></div>
  <div class="filter-group"><span class="filter-label">Ticker:</span><input type="text" id="filterTicker" placeholder="e.g. P"></div>
  <div class="filter-group"><span class="filter-label">Video:</span><input type="text" id="filterVideo" placeholder="e.g. 20220606"></div>
  <div class="filter-group"><span class="filter-label">Layout:</span>
    <select id="filterLayout"><option value="">All</option><option value="chart_stream">chart_stream</option><option value="tale_of_the_tape">tale_of_the_tape</option></select>
  </div>
  <div class="filter-group"><span class="filter-label">GT:</span>
    <select id="filterGT"><option value="">All</option><option value="gt">Has GT</option><option value="nogt">No GT</option></select>
  </div>
  <button onclick="clearFilters()" style="background:none;border:1px solid var(--border);color:var(--text2);padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;">Clear</button>
  <span id="rowCount" style="margin-left:auto;font-size:11px;color:var(--text2);">${totalCaptures} rows</span>
</div>

<div class="table-wrap">
<table id="mainTable">
<thead>
<tr>
  <th></th><th>#</th><th>Video</th><th>Acc</th><th>t (HMS)</th>
  <th>Conf</th><th>Recall</th><th>Tickers</th><th>Layout</th>
  <th>ph_overlay</th><th>OCR snippet</th><th>Ground truth</th>
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
  document.getElementById('filterGT').value = '';
  render();
}

function filterRow(r) {
  const confThresh = parseFloat(document.getElementById('filterConf').value);
  const tickerFilter = document.getElementById('filterTicker').value.trim().toUpperCase();
  const videoFilter = document.getElementById('filterVideo').value.trim();
  const layoutFilter = document.getElementById('filterLayout').value;
  const gtFilter = document.getElementById('filterGT').value;
  if (confThresh && (r.conf == null || r.conf < confThresh)) return false;
  if (tickerFilter && !r.tickers.some(t => t === tickerFilter)) return false;
  if (videoFilter && !r.dateKey.includes(videoFilter)) return false;
  if (layoutFilter && r.layout !== layoutFilter) return false;
  if (gtFilter === 'gt' && !r.gtTickers) return false;
  if (gtFilter === 'nogt' && r.gtTickers) return false;
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
    const gtBadge = r.gtTickers
      ? '<span class="badge badge-gt">GT</span>'
      : '<span class="badge badge-nogt">no-GT</span>';

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
      <td><span class="count-badge">\${r.dateKey}</span> \${gtBadge}</td>
      <td><span class="run-date">\${r.runDate}</span></td>
      <td><span class="ts">\${r.tsHms}</span></td>
      <td><span class="conf-cell" style="\${confColorStyle}">\${r.confStr}</span></td>
      <td>\${r.gtTickers ? '<span class="recall-cell">' + r.tickers.filter(t => r.gtTickers.includes(t)).length + '/' + r.gtTickers.length + '</span>' : '<span style="color:var(--text2)">—</span>'}</td>
      <td><div class="ticker-list">\${tickerBadges || '<span style="color:var(--text2)">—</span>'}</div></td>
      <td>\${layoutBadge}</td>
      <td><span class="ph">\${r.phOv}</span></td>
      <td><span class="ocr-snippet" title="\${r.ocrText}">\${r.ocrSnippet}</span></td>
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
              <div class="meta-item"><span class="meta-key">Timestamp</span><span class="meta-val">\${r.tsHms}</span></div>
              <div class="meta-item"><span class="meta-key">OCR Conf</span><span class="meta-val" style="\${confColorStyle}">\${r.confStr}</span></div>
              <div class="meta-item"><span class="meta-key">Parse Status</span><span class="meta-val">\${parseStatusBadge} (\${r.chartConf}%)</span></div>
              <div class="meta-item"><span class="meta-key">Layout</span><span class="meta-val">\${r.layout}</span></div>
              <div class="meta-item"><span class="meta-key">Position List</span><span class="meta-val">\${(r.positionList || []).join(', ') || '—'}</span></div>
              <div class="meta-item"><span class="meta-key">Price Action</span><span class="meta-val" style="font-size:11px;">\${r.priceAction}</span></div>
              <div class="meta-item"><span class="meta-key">ph_overlay</span><span class="meta-val" style="font-size:10px;">\${r.phOv}</span></div>
              <div class="meta-item"><span class="meta-key">Video</span><span class="meta-val">\${r.dateKey}</span></div>
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

document.getElementById('filterConf').addEventListener('input', render);
document.getElementById('filterTicker').addEventListener('input', render);
document.getElementById('filterVideo').addEventListener('input', render);
document.getElementById('filterLayout').addEventListener('change', render);
document.getElementById('filterGT').addEventListener('change', render);

render();
</script>
</body>
</html>
`;

fs.writeFileSync(OUTPUT_HTML, html, 'utf8');
console.log(`[compile_results] Wrote ${OUTPUT_HTML}`);
console.log(`  Videos: ${totalVideos}, Captures: ${totalCaptures}, GT videos: ${gtVideos.size}, Recall: ${gtRows.length ? Math.round(totalHits/totalGT*100)+'%' : '—'}`);
console.log(`  Unique tickers: ${uniqueTickers.length}`);
