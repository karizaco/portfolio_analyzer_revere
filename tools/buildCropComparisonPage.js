'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const GT = {
  '20220323': ['BOIL','JNUG','NUGT','X','URA','FCX','WEAT','COPX','URNM','REGN','KWEB'],
  '20220510': ['VRM','TSLA'],
  '20220428': ['CWEB','KWEB','TSLA','WEAT'],
  '20220614': ['UVXY','VLO','UCO'],
  '20220228': [],
  '20220427': ['FAULL','LABU','NUGT','SOXL','UVXY','WEAT'],
};

// All test runs to compare. Each entry shows the run tag, the date key,
// and a one-line label describing the experiment.
const RUNS = [
  {
    tag: 'qmg-pipeline-20220323',
    label: 'BEFORE position-list-aware filter (old parser)',
    video: '20220323',
  },
  {
    tag: 'qmg-pos-aware-20220323',
    label: 'AFTER position-list-aware filter (column-restricted)',
    video: '20220323',
  },
];

function loadRun(tag) {
  const logsDir = path.join(ROOT, 'data/video_scan_test', tag, 'ocr_probe/logs');
  if (!fs.existsSync(logsDir)) return [];
  const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.json'));
  const results = [];
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(logsDir, f), 'utf8'));
    const dateKey = f.split('_')[0];
    const gt = GT[dateKey] || null;
    // Capture both saved captures AND top_candidates (rejected candidates)
    const captures = data.captures || [];
    const topCandidates = (data.top_candidates || []).filter((c, i) => i < 3);
    const all = captures.concat(topCandidates);
    for (let i = 0; i < all.length; i += 1) {
      const candidate = all[i];
      const detected = candidate.tickers || [];
      const correct = gt ? detected.filter(t => gt.includes(t)) : [];
      const extra = gt ? detected.filter(t => !gt.includes(t)) : [];
      results.push({
        dateKey,
        i,
        type: i < captures.length ? 'saved' : 'top_rejected',
        conf: candidate.ocr_confidence,
        score: candidate.score,
        detected: detected.sort(),
        correct,
        extra,
        recall: gt ? `${correct.length}/${gt.length}` : '?',
        ocrText: (candidate.ocr_text || '').slice(0, 250)
      });
    }
  }
  return results;
}

function buildPage() {
  const runData = RUNS.map(run => ({
    ...run,
    results: loadRun(run.tag)
  }));

  // Compute aggregate metrics per run
  const aggregateStats = runData.map(run => {
    let totalGT = 0, totalCorrect = 0, totalFP = 0, totalDetected = 0;
    for (const r of run.results) {
      const gt = GT[r.dateKey];
      if (!gt) continue;
      totalGT += gt.length;
      totalCorrect += r.correct.length;
      totalFP += r.extra.length;
      totalDetected += r.detected.length;
    }
    return {
      label: run.label,
      totalCorrect,
      totalDetected,
      totalFP,
      totalGT,
      recallPct: totalGT ? Math.round((totalCorrect / totalGT) * 100) : 0,
      precisionPct: totalDetected ? Math.round((totalCorrect / totalDetected) * 100) : 0,
    };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Position-List-Aware Parser Review — Quullamaggie</title>
<style>
  body { font-family: monospace; background: #0d0d0d; color: #e0e0e0; padding: 20px; }
  h1 { color: #fff; margin-bottom: 5px; }
  .summary { display: flex; gap: 20px; margin: 15px 0 25px; }
  .summary-card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 15px; flex: 1; }
  .summary-card h3 { margin: 0 0 10px; color: #fff; font-size: 13px; }
  .summary-card .big { font-size: 32px; color: #4f4; font-weight: bold; }
  .summary-card.bad .big { color: #f66; }
  .summary-card.warn .big { color: #ffa; }
  .run { margin: 20px 0; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
  .run-header { padding: 12px 15px; background: #1a1a1a; border-bottom: 1px solid #333; }
  .run-header h2 { margin: 0; color: #fff; font-size: 14px; }
  .captures { display: flex; flex-wrap: wrap; gap: 15px; padding: 15px; }
  .capture { flex: 1 1 400px; max-width: 500px; background: #1a1a1a; border-radius: 4px; padding: 10px; }
  .capture img { width: 100%; height: auto; display: block; border: 1px solid #333; }
  .capture-meta { margin-top: 8px; font-size: 11px; line-height: 1.6; }
  .capture-meta .label { color: #888; }
  .correct { color: #4f4; }
  .extra { color: #f88; }
  .ocr { color: #888; font-size: 10px; word-break: break-all; margin-top: 5px; max-height: 100px; overflow-y: auto; background: #0a0a0a; padding: 5px; border-radius: 3px; }
  .recall-ok { color: #4f4; font-weight: bold; }
  .recall-warn { color: #ffa; font-weight: bold; }
  .recall-bad { color: #f44; font-weight: bold; }
  .saved-tag { background: #4f4; color: #000; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 5px; }
  .rejected-tag { background: #f84; color: #000; padding: 2px 6px; border-radius: 3px; font-size: 10px; margin-left: 5px; }
  .legend { background: #1a1a1a; border: 1px solid #333; padding: 15px; border-radius: 6px; margin-bottom: 20px; font-size: 12px; }
  .legend p { margin: 5px 0; }
</style>
</head>
<body>
<h1>Position-List-Aware Parser Review — Quullamaggie</h1>
<p>Comparison of the OLD parser vs the NEW column-restricted parser. Each capture shows: detected tickers (GT correct in green, FPs in red), OCR text snippet, and the source screenshot.</p>

<div class="legend">
  <p><b>Background:</b> The Qullamaggie position-list overlay sits in the bottom-right corner of chart frames. OCR reads the entire cropped region (250x434px), which includes chart y-axis labels (26.00, Arith), chart annotations (BABA, US Steel), and Personal WatchList panel rows. The old parser accepted any ticker-shaped token near a price, producing 22+ false positives per frame.</p>
  <p><b>Fix:</b> Position-list-aware filter identifies the dominant ticker column (x=348-358 in scaled image) and only keeps ticker-shaped words that land in that column AND have a price token to their RIGHT (real position list rows are structured: <code>ticker | price | % change</code>). Edit-distance correction is restricted to in-column tokens only, so chart text outside the column can't get corrected into false-positive tickers.</p>
  <p><b>Also added to seed lexicon:</b> WEAT, URNM, JNUG, NUGT, COPX, KWEB, X (Qullamaggie chart ETFs that were missing, causing correct tickers to be edit-distance-mis-corrected).</p>
</div>

<div class="summary">
${aggregateStats.map(s => `
  <div class="summary-card ${s.recallPct >= 60 ? '' : 'bad'}">
    <h3>${s.label}</h3>
    <div class="big">${s.recallPct}%</div>
    <div>Recall (${s.totalCorrect}/${s.totalGT} GT correct)</div>
    <div>FPs: <span class="${s.totalFP > 5 ? 'extra' : 'correct'}">${s.totalFP}</span> | Precision: ${s.precisionPct}%</div>
  </div>`).join('')}
</div>

${runData.map(run => `
<div class="run">
  <div class="run-header">
    <h2>${run.label}</h2>
    <div style="font-size:11px;color:#888">Run tag: <code>${run.tag}</code> | GT: ${GT[run.video].length} tickers | ${run.results.length} candidates</div>
  </div>
  <div class="captures">
    ${run.results.map((r, i) => {
      const imgName = r.type === 'saved'
        ? `qmg_${r.dateKey}${r.i > 0 ? '_' + (r.i + 1) : ''}.png`
        : null;
      const imgPath = imgName ? `../data/video_scan_test/${run.tag}/snapshots/${imgName}` : null;
      const recallClass = r.correct.length >= Math.ceil(GT[r.dateKey].length * 0.6) ? 'recall-ok' : r.correct.length >= 3 ? 'recall-warn' : 'recall-bad';
      const tagClass = r.type === 'saved' ? 'saved-tag' : 'rejected-tag';
      const tagLabel = r.type === 'saved' ? 'SAVED' : 'REJECTED';
      return `
      <div class="capture">
        ${imgPath ? `<img src="${imgPath}" onerror="this.style.display='none'" alt="capture ${i}">` : '<div style="background:#000;color:#666;padding:40px;text-align:center">No image (rejected candidate)</div>'}
        <div class="capture-meta">
          <div><b>${r.dateKey} candidate #${r.i}</b> <span class="${tagClass}">${tagLabel}</span></div>
          <div><span class="label">Conf:</span> ${r.conf} <span class="label">Score:</span> ${typeof r.score === 'number' ? r.score.toFixed(1) : '?'}</div>
          <div><span class="label">Recall:</span> <span class="${recallClass}">${r.recall}</span></div>
          <div class="correct">✓ Correct: ${r.correct.join(', ') || '—'}</div>
          <div class="extra">✗ FPs (${r.extra.length}): ${r.extra.length > 0 ? r.extra.slice(0, 15).join(', ') : '—'}</div>
          <div class="ocr">${r.ocrText.replace(/</g, '&lt;').replace(/\n/g, ' | ').slice(0, 200)}...</div>
        </div>
      </div>`;
    }).join('')}
  </div>
</div>`).join('')}
</body>
</html>`;

  return html;
}

const html = buildPage();
const outPath = path.join(ROOT, 'tools', 'qmg_crop_comparison.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log('Written:', outPath);
