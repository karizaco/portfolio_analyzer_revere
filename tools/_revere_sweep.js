'use strict';
// Workflow script for Revere positional OCR sweep
// Usage: node tools/_revere_sweep.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parallel } = require('iter-tools');

// Discover videos via Python (sqlite3 available in Python, not Node.js)
console.log('Discovering Revere videos via Python...');
const pyOut = execSync(
  `python -c "
import sqlite3, os, json
db = sqlite3.connect('data/video_pipeline/state.sqlite')
cur = db.execute('''
  SELECT video_id, upload_date, title, download_path
  FROM videos
  WHERE channel = 'revere' AND download_path IS NOT NULL AND download_path != ''
  ORDER BY upload_date DESC
''')
rows = [dict(zip(['video_id','upload_date','title','download_path'], r))
         for r in cur.fetchall() if r[3] and os.path.exists(r[3])]
db.close()
print(json.dumps(rows))
"`,
  { encoding: 'utf8', cwd: 'C:/Users/admin/Projects/portfolio_analyzer_revere' }
);
const videos = JSON.parse(pyOut.trim());
console.log(`Discovered ${videos.length} Revere videos with downloads`);

if (videos.length === 0) {
  console.log('No videos — aborting');
  process.exit(0);
}

// Output dir
const outDir = 'data/video_ocr_probe/revere-sweep';
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const FRAME_TIME = '00:07:28';
const allResults = [];

for (let i = 0; i < videos.length; i += 4) {
  const batch = videos.slice(i, i + 4);
  const batchTag = Math.floor(i / 4) + 1;
  const totalBatches = Math.ceil(videos.length / 4);
  console.log(`[Batch ${batchTag}/${totalBatches}] ${batch.map(v => v.video_id).join(', ')}`);

  const batchResults = await parallel(batch.map(v => async () => {
    const videoPath = v.download_path;
    const framePath = path.join(outDir, `${v.upload_date}_${v.video_id}.png`);

    // Extract frame
    try {
      execSync(`ffmpeg -y -ss ${FRAME_TIME} -i "${videoPath}" -vf scale=1280:-1 "${framePath}"`,
        { stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      return { video_id: v.video_id, upload_date: v.upload_date, ok: false, stage: 'ffmpeg', error: e.message.substring(0, 80) };
    }

    // OCR
    let ocr;
    try {
      ocr = await require('./src/ocr/ocrImage').ocrImage(framePath);
    } catch (e) {
      return { video_id: v.video_id, upload_date: v.upload_date, ok: false, stage: 'ocr', error: e.message.substring(0, 80) };
    }

    // Parse
    try {
      const result = await require('./src/parse/parseWhiteboardScreenshotWithBoxes').parseWhiteboardScreenshotWithBoxes({
        metadata: { fileName: v.video_id, asOfDate: v.upload_date, sequence: 1 },
        ocr,
        framePath
      });
      return { video_id: v.video_id, upload_date: v.upload_date, ok: true, result };
    } catch (e) {
      return { video_id: v.video_id, upload_date: v.upload_date, ok: false, stage: 'parse', error: e.message.substring(0, 80) };
    }
  }));

  allResults.push(...batchResults);
  console.log(`  -> OK ${batchResults.filter(r => r.ok).length}/${batch.length}`);
}

// Aggregate
const parsed = allResults.filter(r => r.ok && r.result);
const positional = parsed.filter(r => r.result[0]?.positional_parse);
const groLens = parsed.map(r => (r.result[0]?.tickers_from_bbox || []).length);
const turboLens = parsed.map(r => (r.result[1]?.tickers_from_bbox || []).length);
const avgGro = groLens.length ? groLens.reduce((a, b) => a + b, 0) / groLens.length : 0;
const avgTurbo = turboLens.length ? turboLens.reduce((a, b) => a + b, 0) / turboLens.length : 0;
const zeroGro = groLens.filter(l => l === 0).length;
const zeroTurbo = turboLens.filter(l => l === 0).length;

console.log(`\n=== RESULTS ===`);
console.log(`Extracted: ${allResults.length}/${videos.length}`);
console.log(`Positional parse OK: ${positional.length}/${parsed.length}`);
console.log(`Avg GRO tickers: ${avgGro.toFixed(1)} | zero: ${zeroGro}/${parsed.length}`);
console.log(`Avg TURBO tickers: ${avgTurbo.toFixed(1)} | zero: ${zeroTurbo}/${parsed.length}`);

console.log('\nAll results:');
parsed.forEach(r => {
  const gro = r.result[0]?.tickers_from_bbox || [];
  const turbo = r.result[1]?.tickers_from_bbox || [];
  const issues = r.result[0]?.issue_codes || '';
  console.log(`${r.upload_date} ${r.video_id} GRO(${gro.length})=${gro.slice(0, 8).join(',')} TURBO(${turbo.length})=${turbo.slice(0, 8).join(',')} issues=${issues.substring(0, 40)}`);
});

allResults.filter(r => !r.ok).forEach(r => {
  console.log(`FAIL ${r.upload_date} ${r.video_id} [${r.stage}]: ${r.error}`);
});

const outFile = 'data/revere_positional_sweep_results.json';
fs.writeFileSync(outFile, JSON.stringify({
  results: parsed.map(r => ({
    video_id: r.video_id,
    upload_date: r.upload_date,
    gro_tickers: r.result[0]?.tickers_from_bbox || [],
    turbo_tickers: r.result[1]?.tickers_from_bbox || [],
    positional_parse: r.result[0]?.positional_parse || false,
    issues: r.result[0]?.issue_codes || '',
    window_bbox: r.result[0]?.window_bbox || null
  })),
  failed: allResults.filter(r => !r.ok).map(r => ({ video_id: r.video_id, upload_date: r.upload_date, stage: r.stage, error: r.error }))
}, null, 2));
console.log(`\nSaved to ${outFile}`);
