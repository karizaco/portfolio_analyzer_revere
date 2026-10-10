'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadQmgGroundTruth,
} = require('../src/qmg/qmgGroundTruth');

// GT for the two locally-available videos.
// Video paths are relative to data/video_pipeline/downloads_1080p/ or downloads_hires/.
const CURATED_CASES = Object.freeze([
  {
    dateKey: '20220606',
    videoPath: 'downloads_1080p/20220606_ST8lvpOVjeM.mp4',
    gtKey: '20220606',
    gtCapture: '1',
  },
  {
    dateKey: '20221104',
    videoPath: 'downloads_hires/20221104_9lzYgB-b9yE.mp4',
    gtKey: '20221104',
    gtCapture: '2',
  },
]);

function snapshotFileName(dateKey, captureIndex) {
  const suffix = captureIndex === 0 ? '' : `_${captureIndex + 1}`;
  return `qmg_${dateKey}${suffix}.png`;
}

function recall(found, gt) {
  if (!gt || !gt.length) return 0;
  return gt.filter((t) => found.includes(t)).length / gt.length;
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

// Run scanVideoWithOcr.js as a subprocess and wait for the JSON log file path.
function runPipeline(videoPath, dateKey, engine, outputRoot) {
  return new Promise((resolve, reject) => {
    const args = [
      'tools/scanVideoWithOcr.js',
      '--video', videoPath,
      '--date', dateKey,
      '--prefilter-profile', 'chart_stream',
      '--chart-stream-parser',
      '--basename', 'qmg',
      '--output-kind', 'snapshot',
      '--max-captures', '3',
      '--fps', '0.25',
      '--prefilter-max-frames', '6',
      '--ocr-engine', engine,
      '--output-root', outputRoot,
    ];

    const child = spawn('node', args, {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`scanVideoWithOcr.js exited ${code}\nSTDERR: ${stderr.slice(-500)}`));
        return;
      }
      // Extract log_path from last line of stdout
      const lines = stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      let logPath;
      try {
        const obj = JSON.parse(lastLine);
        logPath = obj.log_path;
      } catch {
        // Try to find log_path anywhere in stdout
        const match = stdout.match(/"log_path"\s*:\s*"([^"]+)"/);
        if (match) logPath = match[1];
      }
      if (!logPath) {
        reject(new Error(`Could not find log_path in output:\n${stdout.slice(-500)}`));
        return;
      }
      resolve(logPath);
    });

    child.on('error', reject);
  });
}

function renderReport(summary) {
  const lines = [
    `QMG Video Benchmark Report`,
    `Generated: ${new Date().toISOString()}`,
    `Engine: ${summary.engine}`,
    `Video root: ${summary.videoRoot}`,
    ``,
    `Cases:`,
  ];

  for (const c of summary.cases) {
    lines.push(`  ${c.dateKey} (${c.mode}):`);
    lines.push(`    Timestamp: ${c.timestamp}s (${(c.timestamp / 60).toFixed(1)}m)`);
    lines.push(`    Recall: ${formatPct(c.recall)} (${c.hits.length}/${c.gt.length})`);
    lines.push(`    Found: ${JSON.stringify(c.found)}`);
    lines.push(`    Misses: ${JSON.stringify(c.misses)}`);
    if (c.fps.length) lines.push(`    FPs: ${JSON.stringify(c.fps)}`);
    lines.push(`    Status: ${c.status}`);
    lines.push(``);
  }

  lines.push(`Mean recall: ${formatPct(summary.meanRecall)}`);
  lines.push(`Total GT: ${summary.totalGt} | Total Hits: ${summary.totalHits} | Total FPs: ${summary.totalFps}`);

  return lines.join('\n');
}

async function main() {
  const outputRoot = path.resolve(__dirname, '..', 'artifacts', 'qmg_video_benchmark');
  ensureDir(outputRoot);

  const engine = process.argv.includes('--easyocr') ? 'easyocr' : 'tesseract';
  const gt = loadQmgGroundTruth();

  const cases = [];
  let totalHits = 0;
  let totalFps = 0;
  let totalGt = 0;

  for (const c of CURATED_CASES) {
    const videoPath = path.resolve(__dirname, '..', 'data', 'video_pipeline', c.videoPath);
    if (!fs.existsSync(videoPath)) {
      console.error(`Video not found: ${videoPath} — skipping ${c.dateKey}`);
      continue;
    }

    console.error(`Running ${c.dateKey} with ${engine}...`);
    let logPath;
    try {
      logPath = await runPipeline(videoPath, c.dateKey, engine, outputRoot);
    } catch (err) {
      console.error(`Pipeline failed for ${c.dateKey}: ${err.message}`);
      continue;
    }

    // Wait for log file to appear (EasyOCR is slow)
    let log = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const content = fs.readFileSync(logPath, 'utf8');
        log = JSON.parse(content);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (!log) {
      console.error(`Log file not readable after 5 min: ${logPath}`);
      continue;
    }

    // Use merged_position_list for recall (the multi-frame union, not single-frame)
    const found = log.merged_position_list || [];
    const gtCapture = gt[c.gtKey] ? gt[c.gtKey][c.gtCapture] || gt[c.gtKey]['0'] || [] : [];
    const hits = gtCapture.filter((t) => found.includes(t));
    const misses = gtCapture.filter((t) => !found.includes(t));
    const fps = found.filter((t) => !gtCapture.includes(t));
    const caseRecall = recall(found, gtCapture);

    const topCand = (log.top_candidates && log.top_candidates[0]) || {};
    cases.push({
      dateKey: c.dateKey,
      mode: c.gtKey,
      timestamp: topCand.timestamp || 0,
      gt: gtCapture,
      found,
      hits,
      misses,
      fps,
      recall: caseRecall,
      status: log.status,
    });

    totalGt += gtCapture.length;
    totalHits += hits.length;
    totalFps += fps.length;
    console.error(`  ${c.dateKey}: ${formatPct(caseRecall)} found=${JSON.stringify(found)}`);
  }

  if (!cases.length) {
    console.error('No cases completed — check video paths');
    process.exit(1);
  }

  const meanRecall = cases.reduce((s, c) => s + c.recall, 0) / cases.length;

  const summary = {
    date: new Date().toISOString(),
    engine,
    videoRoot: path.resolve(__dirname, '..', 'data', 'video_pipeline'),
    cases,
    meanRecall,
    totalGt,
    totalHits,
    totalFps,
  };

  const reportPath = path.join(outputRoot, 'REPORT.txt');
  const jsonPath = path.join(outputRoot, 'benchmark_results.json');

  fs.writeFileSync(reportPath, renderReport(summary));
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`\n${renderReport(summary)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { main };
