'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const ROOT = path.join(__dirname, '..');

// Crop region (matches CHART_STREAM_REGION_FRACTION_DEFAULT).
const CROP = { x: 0.87, y: 0.58, w: 0.13, h: 0.40 };

// Ground-truth tickers per video.
const GT = {
  '20220323': ['BOIL','JNUG','NUGT','X','URA','FCX','WEAT','COPX','URNM','REGN','KWEB'],
  '20220510': ['VRM','TSLA'],
  '20220428': ['CWEB','KWEB','TSLA','WEAT'],
  '20220614': ['UVXY','VLO','UCO'],
  '20220228': [],
  '20220427': ['FAULL','LABU','NUGT','SOXL','UVXY','WEAT'],
};

// Each run = a parser variant + a list of captures. We re-OCR every capture
// live so the comparison is on equal footing (Tesseract is non-deterministic
// across runs). This avoids stale OCR text from old probe logs.
const RUNS = [
  {
    tag: 'qmg-pipeline-20220323',
    label: 'BEFORE: crop + edit-distance, NO column filter',
    parser: 'legacy',
    video: '20220323',
    captures: [
      { file: 'qmg_20220323.png',   label: 'Capture 1 (ts=00:34:10)' },
      { file: 'qmg_20220323_2.png', label: 'Capture 2 (ts=00:02:44)' },
      { file: 'qmg_20220323_3.png', label: 'Capture 3 (ts=00:32:48)' },
    ],
  },
  {
    tag: 'qmg-pos-aware-20220323',
    label: 'AFTER: position-list-aware column filter',
    parser: 'column-aware',
    video: '20220323',
    captures: [
      { file: 'qmg_20220323.png', label: 'Capture 1 (ts=00:17:00)' },
    ],
  },
];

const CROPS_OUT_DIR = path.join(ROOT, 'data', 'video_scan_test', '_review_crops');

// Replicate the OCR pipeline's preprocessing (chart-stream profile).
async function preprocessForOcr(snapshotPath) {
  const meta = await sharp(snapshotPath).metadata();
  const left = Math.round(meta.width * CROP.x);
  const top = Math.round(meta.height * CROP.y);
  const cropW = Math.round(meta.width * CROP.w);
  const cropH = Math.round(meta.height * CROP.h);
  const ocrBuf = await sharp(snapshotPath)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(cropW * 3, cropH * 3, { kernel: 'lanczos3' })
    .grayscale()
    .negate()
    .linear(1.8, -64)
    .normalize()
    .sharpen({ sigma: 1.5 })
    .withMetadata({ density: 300 })
    .png()
    .toBuffer();
  return { meta, left, top, cropW, cropH, ocrBuf };
}

// Legacy parser: accept any ticker-shaped token in lexicon or with price-nearby.
function legacyParse(text, lexicon) {
  const tokens = text.split(/[\s,;:()\[\]{}<>\/\\|]+/);
  const seen = new Set();
  const accepted = [];
  for (const tok of tokens) {
    const stripped = tok.replace(/^\|+|\|+$/g, '');
    const cleaned = stripped.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (!/^[A-Z][A-Z0-9]{0,4}$/.test(cleaned)) continue;
    const inLex = lexicon.tickerSet.has(cleaned);
    if (inLex) accepted.push(cleaned);
  }
  return accepted;
}

async function main() {
  const { parseChartStreamPositionList } = require(path.join(ROOT, 'src/parse/parseChartStream'));
  const { loadSeedLexiconSync } = require(path.join(ROOT, 'src/normalize/tickerScan'));
  const lexicon = loadSeedLexiconSync();

  // Set up Tesseract once for the whole page build.
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });

  fs.mkdirSync(CROPS_OUT_DIR, { recursive: true });

  const runData = [];
  for (const run of RUNS) {
    const captures = [];
    for (let i = 0; i < run.captures.length; i += 1) {
      const cap = run.captures[i];
      const snapshotPath = path.join(ROOT, 'data', 'video_scan_test', run.tag, 'snapshots', cap.file);
      if (!fs.existsSync(snapshotPath)) {
        captures.push({ ...cap, error: 'Snapshot missing' });
        continue;
      }
      const { left, top, cropW, cropH, ocrBuf } = await preprocessForOcr(snapshotPath);

      // Save raw + OCR crops for the HTML to display.
      const stem = `${run.tag}__${cap.file.replace('.png', '')}`;
      const rawPath = path.join(CROPS_OUT_DIR, `${stem}__raw_crop.png`);
      const ocrPath = path.join(CROPS_OUT_DIR, `${stem}__ocr_crop.png`);
      await sharp(snapshotPath).extract({ left, top, width: cropW, height: cropH }).png().toFile(rawPath);
      fs.writeFileSync(ocrPath, ocrBuf);

      // Re-OCR (Tesseract is non-deterministic so stored log OCR is unreliable).
      const ocrResult = await worker.recognize(ocrBuf, {}, { tsv: true });
      const text = ocrResult.data.text || '';
      const conf = Math.round(ocrResult.data.confidence || 0);
      const tsvLines = (ocrResult.data.tsv || '').split('\n').slice(1).filter(l => l.trim());
      const words = tsvLines.map(l => {
        const c = l.split('\t');
        return { text: (c[11] || '').trim(), left: +c[6], top: +c[7], width: +c[8], height: +c[9], conf: +c[10], line: +c[4] };
      }).filter(w => w.text);

      // Apply the right parser.
      let detected;
      if (run.parser === 'column-aware') {
        const ocr = { text, lines: text.split('\n'), words };
        const parsed = parseChartStreamPositionList({ ocr });
        detected = parsed.position_list;
      } else {
        detected = legacyParse(text, lexicon);
      }

      const gt = GT[run.video] || [];
      const correct = gt.filter(t => detected.includes(t));
      const extra = detected.filter(t => !gt.includes(t));
      const missing = gt.filter(t => !detected.includes(t));

      captures.push({
        ...cap,
        crops: {
          raw: path.relative(path.join(ROOT, 'tools'), rawPath).replace(/\\/g, '/'),
          ocr: path.relative(path.join(ROOT, 'tools'), ocrPath).replace(/\\/g, '/'),
        },
        detected,
        correct,
        extra,
        missing,
        recall: gt.length ? `${correct.length}/${gt.length}` : '—',
        ocrText: text.replace(/</g, '&lt;').slice(0, 600),
        conf,
      });
    }
    runData.push({ ...run, captures });
  }

  await worker.terminate();

  // Aggregate metrics
  const aggregateStats = runData.map(run => {
    let totalCorrect = 0, totalFP = 0, totalDetected = 0, totalGT = 0;
    for (const c of run.captures) {
      totalCorrect += (c.correct || []).length;
      totalFP += (c.extra || []).length;
      totalDetected += (c.detected || []).length;
      totalGT += (GT[run.video] || []).length;
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
<title>Quullamaggie Position-List OCR — Crop & Detection Review</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0d0d0d; color: #e0e0e0; padding: 20px; }
  h1 { color: #fff; margin-bottom: 5px; }
  h2 { color: #fff; margin-top: 30px; border-bottom: 1px solid #333; padding-bottom: 8px; }
  .summary { display: flex; gap: 15px; margin: 20px 0; }
  .summary-card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 15px; flex: 1; }
  .summary-card h3 { margin: 0 0 8px; color: #fff; font-size: 13px; }
  .summary-card .big { font-size: 28px; font-weight: bold; }
  .big.good { color: #4f4; }
  .big.bad { color: #f66; }
  .legend { background: #1a1a1a; border: 1px solid #333; padding: 15px; border-radius: 6px; margin-bottom: 20px; font-size: 12px; line-height: 1.6; }
  .legend code { background: #2a2a2a; padding: 2px 5px; border-radius: 3px; }
  .capture-row { display: grid; grid-template-columns: 220px 280px 1fr; gap: 15px; margin: 15px 0; padding: 15px; background: #1a1a1a; border-radius: 6px; border: 1px solid #333; }
  .crop-box { background: #000; border: 1px solid #333; border-radius: 4px; padding: 8px; text-align: center; }
  .crop-box img { width: 100%; height: auto; display: block; border-radius: 3px; }
  .crop-box .crop-label { font-size: 11px; color: #888; margin-bottom: 6px; }
  .detection-box { padding: 0 5px; }
  .detection-box .timestamp { color: #aaa; font-size: 12px; margin-bottom: 8px; }
  .ticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 5px; margin-bottom: 10px; }
  .ticker { padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; text-align: center; }
  .ticker.gt-correct { background: #1a3a1a; color: #6d6; border: 1px solid #4a4; }
  .ticker.gt-missed  { background: #3a1a1a; color: #f88; border: 1px dashed #f44; opacity: 0.7; }
  .ticker.fp         { background: #3a2a1a; color: #fa6; border: 1px solid #f84; }
  .gt-list-label { font-size: 11px; color: #888; margin-top: 8px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
  .ocr-text { font-family: monospace; font-size: 11px; color: #999; background: #0a0a0a; padding: 8px; border-radius: 3px; max-height: 140px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 10px; }
  .recall-summary { font-size: 18px; font-weight: bold; margin: 10px 0; }
  .recall-summary.good { color: #6d6; }
  .recall-summary.warn { color: #fc6; }
  .recall-summary.bad  { color: #f66; }
  .capture-title { font-size: 14px; color: #fff; font-weight: 600; margin-bottom: 4px; }
  .missing-banner { background: #3a1a1a; border-left: 4px solid #f44; padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 12px; color: #faa; }
</style>
</head>
<body>
<h1>Quullamaggie Position-List OCR — Crop & Detection Review</h1>
<p style="color:#888">For each capture: <b>Raw crop</b> = the 250×434px region extracted from the snapshot (parser input). <b>OCR crop</b> = the 3× upscaled, inverted, contrast-boosted image fed to Tesseract. <b>Detection box</b> = detected tickers (color-coded) + GT tickers + OCR text.</p>
<p style="color:#888"><b>Note:</b> OCR is re-run for every capture so BEFORE/AFTER comparisons are on equal footing (Tesseract is non-deterministic — stored probe logs may have lower-quality text from earlier runs).</p>

<div class="legend">
  <p><b>Color coding:</b> <span class="ticker gt-correct">Green</span> = GT ticker correctly detected. <span class="ticker gt-missed">Red dashed</span> = GT ticker MISSED. <span class="ticker fp">Orange</span> = false positive (detected but not in GT).</p>
  <p><b>How to use this page:</b> For each row, look at the OCR crop on the LEFT (what Tesseract saw) and check whether the detected tickers match the visible text in the position list. Missed GT tickers are Tesseract failures (garbled OCR), not parser failures.</p>
</div>

<div class="summary">
${aggregateStats.map(s => `
  <div class="summary-card">
    <h3>${s.label}</h3>
    <div class="big ${s.recallPct >= 50 ? 'good' : 'bad'}">${s.recallPct}% recall</div>
    <div style="color:#888; font-size:12px; margin-top:6px;">
      ${s.totalCorrect}/${s.totalGT} GT correct • ${s.totalFP} FPs • ${s.precisionPct}% precision
    </div>
  </div>`).join('')}
</div>

${runData.map(run => `
<h2>${run.label}</h2>
<p style="color:#888; font-size:12px;">GT for this video: ${(GT[run.video] || []).join(', ') || '(none)'}</p>

${run.captures.map(cap => {
  if (cap.error) {
    return `<div class="capture-row"><div style="grid-column: 1/-1; padding:20px; color:#f88">${cap.label}: ${cap.error}</div></div>`;
  }
  return `
  <div class="capture-row">
    <div class="crop-box">
      <div class="crop-label">RAW CROP<br><span style="font-size:10px">(parser input)</span></div>
      <img src="../${cap.crops.raw}" alt="raw crop">
    </div>
    <div class="crop-box">
      <div class="crop-label">OCR CROP<br><span style="font-size:10px">(3× scale + invert + sharpen — what Tesseract saw)</span></div>
      <img src="../${cap.crops.ocr}" alt="ocr crop">
      <div style="color:#888; font-size:11px; margin-top:6px">OCR conf: ${cap.conf}</div>
    </div>
    <div class="detection-box">
      <div class="capture-title">${cap.label}</div>

      <div class="recall-summary ${cap.correct.length >= ((GT[run.video] || []).length * 0.6) ? 'good' : cap.correct.length >= 2 ? 'warn' : 'bad'}">
        ${cap.recall} recall — ${cap.correct.length} correct, ${cap.missing.length} missed, ${cap.extra.length} false positives
      </div>

      ${cap.missing.length > 0 ? `
        <div class="missing-banner">⚠ Missed GT tickers: <b>${cap.missing.join(', ')}</b> — check OCR crop on the left to see if Tesseract garbled these</div>
      ` : ''}

      <div class="gt-list-label">Ground truth tickers (${(GT[run.video] || []).length})</div>
      <div class="ticker-grid">
        ${(GT[run.video] || []).map(t => {
          const isHit = cap.correct.includes(t);
          return `<div class="ticker ${isHit ? 'gt-correct' : 'gt-missed'}" title="${isHit ? 'Detected' : 'MISSED by parser'}">${t}</div>`;
        }).join('')}
      </div>

      ${cap.extra.length > 0 ? `
        <div class="gt-list-label">False positives (${cap.extra.length})</div>
        <div class="ticker-grid">
          ${cap.extra.map(t => `<div class="ticker fp" title="Detected but not in GT">${t}</div>`).join('')}
        </div>
      ` : '<div style="color:#4a4; font-size:11px; margin-top:8px">✓ Zero false positives</div>'}

      <div class="gt-list-label">OCR text (Tesseract output)</div>
      <div class="ocr-text">${cap.ocrText || '(empty)'}</div>
    </div>
  </div>`;
}).join('')}
`).join('')}
</body>
</html>`;

  const outPath = path.join(ROOT, 'tools', 'qmg_crop_comparison.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Written:', outPath);
  console.log('Crops in:', CROPS_OUT_DIR);
}

main().catch((err) => { console.error(err); process.exit(1); });
