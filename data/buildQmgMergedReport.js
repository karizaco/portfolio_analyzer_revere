'use strict';

/**
 * buildQmgMergedReport.js
 *
 * Reads the QMG probe logs and writes tools/qmg_merged_results.html --
 * the VIDEO-level report.
 *
 * WHY A SECOND PAGE
 *
 * `tools/qmg_ocr_results.html` (data/compile_results.js) reports the
 * CAPTURE level: one row per captured frame, with that frame's reading
 * scored against the ground truth for that capture.
 *
 * But production does NOT publish the capture reading. It publishes
 * `merged_position_list` -- the VIDEO-level consensus, the clusterer's
 * reading repaired across every frame of the video. The two disagree, and
 * the disagreements are the ones that matter:
 *
 *   20230609  the merged list had `REGN` where the panel showed `RGTI`
 *   20230523  the merged list had `AI`, absorbing the holding `LI`
 *   20230605  the merged list had `AAPL`, a holding no frame showed
 *
 * A capture-level page cannot see any of those, because in each case the
 * capture's own reading was right.
 *
 * This page reports the merged list, per date, against the pixel-verified
 * ground truth, and compares the runs of the same date against each other --
 * so the effect of a pipeline change is visible.
 *
 * It needs no OCR.
 *
 * Usage: node data/buildQmgMergedReport.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_HTML = path.join(ROOT, 'tools', 'qmg_merged_results.html');
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');
const GT_FILE = path.join(ROOT, 'data', 'qmg_ground_truth.json');

// The runs to report, newest first. Each is a pipeline state; the page
// compares them date by date.
const RUN_TAGS = [
  'qmg-easyocr-20261103-swallowed',
  'qmg-easyocr-20261103-corroborated',
  'qmg-easyocr-20261102-era-prefilter',
  'qmg-crop-20261102-smoke-v2',
  'qmg-crop-20261102-smoke',
  'qmg-easyocr-20261020',
  'qmg-easyocr-20261018',
  'qmg-easyocr-20261017',
  'qmg-easyocr-20261012',
  'qmg-easyocr-20261011',
];

// ─── Ground truth ────────────────────────────────────────────────────────────
// The ground truth is the UNION over a date's captures -- the replay tool
// scores against that union, so this page does too.
const { loadQmgGroundTruth, listGroundTruthCaptures } = require(
  path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth')
);

function heldTickersForDate(dateKey) {
  const held = new Set();
  let scored = false;
  for (const capture of listGroundTruthCaptures(loadQmgGroundTruth(), { dates: [dateKey] })) {
    scored = true;
    for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
  }
  return scored ? held : null;
}

// ─── Read the logs ──────────────────────────────────────────────────────────

function readLogs(runTag) {
  const dir = path.join(PROBE_ROOT, runTag, 'ocr_probe', 'logs');
  const byDate = new Map();
  if (!fs.existsSync(dir)) return byDate;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let log;
    try {
      log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const dateKey = log.date_key;
    if (!dateKey) continue;
    const merged = new Set((log.merged_position_list || []).map((t) => String(t).toUpperCase()));
    const entry = {
      dateKey,
      runTag,
      merged,
      rule: log.cluster_rule || 'shipped',
      captured: log.captured_count || (log.captures || []).length,
      crop: log.phash_region_fraction
        ? `${log.phash_region_fraction.x},${log.phash_region_fraction.y},${log.phash_region_fraction.w},${log.phash_region_fraction.h}`
        : null,
      dropped: (log.merged_raw_token_clusters || []).flatMap((c) =>
        (c.swallowedEvidence || [])
          .filter((e) => e.published)
          .map((e) => `${c.canonical}/${e.ticker}(${e.ownFrames}f)`)
      ),
    };
    // A date can have several logs in one run; pool them, as the replay
    // tool does.
    if (!byDate.has(dateKey)) byDate.set(dateKey, { dateKey, runs: [], merged: new Set() });
    const row = byDate.get(dateKey);
    for (const t of merged) row.merged.add(t);
    row.runs.push(entry);
  }
  return byDate;
}
// ─── Score ──────────────────────────────────────────────────────────────────

const all = new Map();   // dateKey -> { dateKey, merged, runs }
for (const tag of RUN_TAGS) {
  // readLogs() returns dateKey -> { dateKey, merged, runs }, where `runs`
  // holds one entry per LOG in that run.
  for (const [dateKey, perRun] of readLogs(tag)) {
    if (!all.has(dateKey)) all.set(dateKey, { dateKey, merged: new Set(), runs: [] });
    const row = all.get(dateKey);
    for (const t of perRun.merged) row.merged.add(t);
    for (const entry of perRun.runs) row.runs.push(entry);
  }
}

const dates = [...all.keys()].sort();
const scored = [];

for (const dateKey of dates) {
  const row = all.get(dateKey);
  const held = heldTickersForDate(dateKey);
  if (!held) continue;
  const published = row.merged;
  const hits = [...held].filter((t) => published.has(t)).sort();
  const fp = [...published].filter((t) => !held.has(t)).sort();
  const missed = [...held].filter((t) => !published.has(t)).sort();
  scored.push({
    dateKey,
    held: [...held].sort(),
    published: [...published].sort(),
    hits,
    fp,
    missed,
    recall: held.size ? (100 * hits.length) / held.size : null,
    precision: published.size ? (100 * hits.length) / published.size : null,
    runs: row.runs,
  });
}

// The per-run totals, so the page can show what each pipeline state scored.
//
// A run that produced NO merged list at all has to be reported as such,
// not as a run that scored zero: "the scan produced no reading" and "the
// scan read the video and got it wrong" are different facts, and a run whose
// logs carry no captures at all is a run that FAILED.
const runTotals = new Map();
for (const tag of RUN_TAGS) {
  const perRun = readLogs(tag);
  if (!runTotals.has(tag)) {
    runTotals.set(tag, { tag, dates: 0, logs: 0, hit: 0, gt: 0, fp: 0, noReading: 0 });
  }
  const t = runTotals.get(tag);
  for (const [dateKey, entry] of perRun) {
    t.logs += entry.runs.length;
    const held = heldTickersForDate(dateKey);
    if (!held) continue;
    t.dates += 1;
    t.gt += held.size;
    t.hit += [...held].filter((x) => entry.merged.has(x)).length;
    t.fp += [...entry.merged].filter((x) => !held.has(x)).length;
    // A log with no merged list at all produced no reading.
    if (!entry.merged.size) t.noReading += 1;
  }
}

const pct = (v) => (v == null ? '—' : `${v.toFixed(1)} %`);

// ─── The page ───────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const runRows = [...runTotals.values()]
  .filter((t) => t.dates > 0)
  .map((t) => {
    const recall = t.gt ? (100 * t.hit) / t.gt : 0;
    const precision = (t.hit + t.fp) ? (100 * t.hit) / (t.hit + t.fp) : 0;
    // A run that read nothing is a FAILED run, and saying "0 % recall"
    // would read as "the scan got it all wrong" -- which is a different
    // thing, and would be a false claim about it.
    const failed = t.noReading > 0
      ? `<span class="failed" title="${t.noReading} of ${t.dates} date(s) produced NO reading at all">${t.noReading} failed</span>`
      : '';
    return `<tr${t.noReading && t.noReading === t.dates ? ' class="failed-row"' : ''}>
      <td class="mono">${esc(t.tag)}</td>
      <td class="num">${t.dates}</td>
      <td class="num">${t.hit}/${t.gt}</td>
      <td class="num">${pct(recall)}</td>
      <td class="num">${t.fp}</td>
      <td class="num">${pct(precision)}</td>
      <td class="num">${failed}</td>
    </tr>`;
  })
  .join('\n');

const dateRows = scored.map((r) => {
  const runs = r.runs
    .map((run) => `<span class="run">${esc(run.runTag.replace(/^qmg-easyocr-/, ''))}<em>${esc(run.rule)}</em></span>`)
    .join('<br>');
  const dropped = r.runs.flatMap((run) => run.dropped).filter(Boolean);
  return `<tr>
    <td class="mono">${esc(r.dateKey)}</td>
    <td class="num"><span class="hits">${r.hits.length}/${r.held.length}</span></td>
    <td class="num">${pct(r.recall)}</td>
    <td class="num">${pct(r.precision)}</td>
    <td class="tickers">${r.hits.map((t) => `<span class="t hit">${esc(t)}</span>`).join('')}</td>
    <td class="tickers">${r.fp.map((t) => `<span class="t fp">${esc(t)}</span>`).join('')}</td>
    <td class="tickers">${r.missed.map((t) => `<span class="t miss">${esc(t)}</span>`).join('')}</td>
    <td class="runs">${runs}</td>
    <td class="tickers">${dropped.map((d) => `<span class="t dropped">${esc(d)}</span>`).join('')}</td>
  </tr>`;
})
  .join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QMG merged results — ${scored.length} dates</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --text: #e6edf3; --text2: #8b949e; --accent: #58a6ff;
    --green: #4ade80; --yellow: #fbbf24; --red: #f87171; --purple: #c084fc;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; font-size: 13px; }
  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 14px 20px; }
  .header h1 { font-size: 17px; font-weight: 600; }
  .header p { color: var(--text2); font-size: 12px; margin-top: 6px; max-width: 1100px; line-height: 1.6; }
  .header a { color: var(--accent); }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text2); padding: 22px 20px 8px; font-weight: 600; }
  .table-wrap { overflow-x: auto; padding: 0 20px 20px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: var(--bg2); position: sticky; top: 0; text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text2); border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; white-space: nowrap; }
  .num { font-family: 'JetBrains Mono', monospace; font-size: 12px; text-align: right; white-space: nowrap; }
  .hits { color: var(--green); font-weight: 600; }
  .tickers { display: flex; flex-wrap: wrap; gap: 4px; max-width: 420px; }
  .t { padding: 1px 6px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  .t.hit { background: rgba(74,222,128,0.14); color: var(--green); }
  .t.fp { background: rgba(248,113,113,0.14); color: var(--red); }
  .t.miss { background: rgba(251,191,36,0.14); color: var(--yellow); }
  .t.dropped { background: rgba(192,132,252,0.14); color: var(--purple); }
  .runs { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text2); line-height: 1.7; }
  .runs em { color: var(--accent); font-style: normal; }
  .failed { color: var(--red); font-family: 'JetBrains Mono', monospace; font-size: 11px; }
  tr.failed-row td { opacity: 0.75; }
  .note { color: var(--text2); font-size: 12px; padding: 0 20px 24px; max-width: 1100px; line-height: 1.7; }
  .note b { color: var(--text); font-weight: 600; }
</style>
</head>
<body>
<div class="header">
  <h1>QMG merged results — the VIDEO-level reading</h1>
  <p>
    Production publishes <span class="mono">merged_position_list</span>, the clusterer's
    reading repaired across every frame of the video — not any single frame's reading.
    This page scores that list against the pixel-verified ground truth, per date.
    The capture-level page is <a href="qmg_ocr_results.html">qmg_ocr_results.html</a>.
  </p>
  <p>
    <b>Why the merged list and not the capture reading:</b> the two have disagreed
    three times on record, and every disagreement is invisible to a capture-level
    page — in each case the capture's own reading was right. The clusterer
    published <span class="mono">REGN</span> where the panel showed
    <span class="mono">RGTI</span>; absorbed the holding
    <span class="mono">LI</span> into <span class="mono">AI</span>; and published
    <span class="mono">AAPL</span>, a holding no frame of that video showed.
  </p>
</div>

<h2>Per pipeline state</h2>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>run</th><th class="num">dates</th><th class="num">hits / gt</th>
    <th class="num">recall</th><th class="num">FP</th><th class="num">precision</th>
    <th class="num">notes</th>
  </tr></thead>
  <tbody>
${runRows}
  </tbody>
</table>
</div>

<h2>Per date</h2>
<div class="table-wrap">
<table>
  <thead><tr>
    <th>date</th><th class="num">hits / gt</th><th class="num">recall</th>
    <th class="num">precision</th><th>found</th><th>false positives</th>
    <th>missed</th><th>runs</th><th>swallowed, published</th>
  </tr></thead>
  <tbody>
${dateRows}
  </tbody>
</table>
</div>

<div class="note">
  <b>How to read this.</b> A date's row pools every log that date has in a run,
  exactly as the replay tool does, and scores against the ground truth's union
  over that date's captures. The <span class="t fp">red</span> tickers are
  holdings the video never had; the <span class="t miss">amber</span> ones are
  holdings it did have and the scan missed. The
  <span class="t dropped">purple</span> column names the tickers the
  swallowed-holding rule published alongside a cluster's canonical.
  <br><br>
  <b>This is a surviving sample.</b> Only dates a probe log exists for appear
  here, and only the runs listed are counted. Every number here is a
  measurement of the scans on disk — not of the pipeline as a whole.
</div>
</body>
</html>
`;

fs.writeFileSync(OUTPUT_HTML, html, 'utf8');

console.log(`wrote ${path.relative(ROOT, OUTPUT_HTML)}`);
console.log(`  ${scored.length} dates scored, ${runTotals.size} pipeline states`);
for (const t of [...runTotals.values()].filter((x) => x.dates > 0)) {
  const recall = t.gt ? (100 * t.hit) / t.gt : 0;
  const precision = (t.hit + t.fp) ? (100 * t.hit) / (t.hit + t.fp) : 0;
  console.log(`  ${t.tag.padEnd(36)} ${String(t.hit).padStart(3)}/${String(t.gt).padEnd(3)} hits  `
    + `${pct(recall).padStart(7)} recall  ${String(t.fp).padStart(3)} FP  ${pct(precision).padStart(7)} precision`);
}
