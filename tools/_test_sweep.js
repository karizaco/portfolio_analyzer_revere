'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  // Discover videos via Python script
  const pyOut = execSync('python tools/_discover_revere.py', {
    encoding: 'utf8',
    cwd: 'C:/Users/admin/Projects/portfolio_analyzer_revere'
  });
  const videos = JSON.parse(pyOut.trim());
  console.log(`Found ${videos.length} Revere videos with downloads`);

  const outDir = 'data/video_ocr_probe/revere-sweep';
  fs.mkdirSync(outDir, { recursive: true });
  const FRAME_TIME = '00:07:28';

  const ocrMod = require('../src/ocr/ocrImage');
  const parseMod = require('../src/parse/parseWhiteboardScreenshotWithBoxes');

  const results = [];
  for (const v of videos) {
    const videoPath = v.download_path.replace(/\\/g, '/');
    const framePath = path.join(outDir, `${v.upload_date}_${v.video_id}.png`);
    const outPath = framePath.replace(/\\/g, '/');
    process.stdout.write(`${v.upload_date} ${v.video_id}... `);

    // Extract frame (ignore ffmpeg exit code — check file instead)
    try {
      execSync(
        `ffmpeg -y -ss ${FRAME_TIME} -i "${videoPath}" -vf scale=1280:-1 "${outPath}"`,
        { stdio: 'pipe', timeout: 30000 }
      );
    } catch (_) { /* ignore non-zero exit */ }

    if (!fs.existsSync(framePath)) {
      console.log(`FFMPEG FAIL (no output)`);
      results.push({ video_id: v.video_id, upload_date: v.upload_date, ok: false, error: 'no_frame' });
      continue;
    }

    // OCR + parse
    try {
      const ocr = await ocrMod.ocrImage(framePath);
      const result = await parseMod.parseWhiteboardScreenshotWithBoxes({
        metadata: { fileName: v.video_id, asOfDate: v.upload_date, sequence: 1 },
        ocr,
        framePath
      });
      const gro = result ? (result[0]?.tickers_from_bbox || []) : [];
      const turbo = result ? (result[1]?.tickers_from_bbox || []) : [];
      console.log(`GRO(${gro.length}) TURBO(${turbo.length})`);
      results.push({ video_id: v.video_id, upload_date: v.upload_date, gro, turbo, ok: true });
    } catch(e) {
      console.log(`ERROR: ${e.message.substring(0, 60)}`);
      results.push({ video_id: v.video_id, ok: false, error: e.message.substring(0, 80) });
    }
  }

  // Summary
  const ok = results.filter(r => r.ok);
  const groLens = ok.map(r => r.gro.length);
  const turboLens = ok.map(r => r.turbo.length);
  const zeroGro = groLens.filter(l => l === 0).length;
  const zeroTurbo = turboLens.filter(l => l === 0).length;
  const avgGro = groLens.length ? groLens.reduce((a,b)=>a+b,0)/groLens.length : 0;
  const avgTurbo = turboLens.length ? turboLens.reduce((a,b)=>a+b,0)/turboLens.length : 0;

  console.log(`\n=== RESULTS (${ok.length}/${results.length} OK) ===`);
  console.log(`Avg GRO: ${avgGro.toFixed(1)} | zero: ${zeroGro}`);
  console.log(`Avg TURBO: ${avgTurbo.toFixed(1)} | zero: ${zeroTurbo}`);

  // All results
  console.log('\nAll results:');
  ok.forEach(r => {
    console.log(`${r.upload_date} ${r.video_id} GRO(${r.gro.length})=${r.gro.slice(0,8).join(',')} TURBO(${r.turbo.length})=${r.turbo.slice(0,8).join(',')}`);
  });

  // Save results
  const outFile = 'data/revere_positional_sweep_results.json';
  fs.writeFileSync(outFile, JSON.stringify({
    results: ok,
    failed: results.filter(r => !r.ok)
  }, null, 2));
  console.log(`\nSaved to ${outFile}`);
})();
