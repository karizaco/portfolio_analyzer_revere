'use strict';

/**
 * qmg_ocr_resolution_experiment.js
 *
 * Compares OCR quality across 4 preprocessing variants × 3 QMG snapshots.
 *
 * Test matrix:
 *   A. 1080p + original    (no negate/invert)
 *   B. 1080p + negate      (current pipeline)
 *   C. 720p  + original
 *   D. 720p  + negate
 *
 * Ground truth (human-verified tickers):
 *   20220606 @ 00:24:00 → GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX
 *   20220607 @ 00:11:12 → UCO, VLO, ALB, BOIL, NFLX, TNA, LTHM
 *   20230126 @ 00:18:40 → CVNA, FCX, TNA, CWEB, YINN, PDD, MDGL, GNS
 *
 * Usage:
 *   node tools/qmg_ocr_resolution_experiment.js
 *
 * Output: comparison table + written to stdout + _qmg_ocr_experiment.log
 */

const { ocrImage } = require('../src/ocr/ocrImage');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');
const path = require('path');
const fs = require('fs');

const VIDEOS = {
  '20220606': {
    video1080: 'data/video_pipeline/downloads_1080p/20220606_aaIlqb7HUJQ.mp4',
    video720:  'data/video_pipeline/downloads/20220606_aaIlqb7HUJQ.mp4',
    ts: 1440,
    gt: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
  },
  '20220607': {
    video1080: 'data/video_pipeline/downloads_1080p/20220607_i0Iq83_54Xs.mp4',
    video720:  'data/video_pipeline/downloads/20220607_i0Iq83_54Xs.mp4',
    ts: 672,
    gt: ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM'],
  },
  '20230126': {
    video1080: 'data/video_pipeline/downloads_1080p/20230126_GdMs1y_RTnM.mp4',
    video720:  'data/video_pipeline/downloads/20230126_GdMs1y_RTnM.mp4',
    ts: 1120,
    gt: ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS'],
  },
};

// Crop region (validated default)
const CROP = { x: 0.70, y: 0.60, w: 0.30, h: 0.40 };

function hms(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

async function extractFrame(videoPath, timestampSec, outputPath) {
  const { execFileSync } = require('child_process');
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const timeStr = hms(timestampSec);
  execFileSync('ffmpeg', [
    '-y', '-ss', timeStr, '-i', videoPath,
    '-vframes', '1', '-q:v', '2',
    '-vf', `crop=iw*${CROP.w}:ih*${CROP.h}:iw*${CROP.x}:ih*${CROP.y}`,
    outputPath
  ], { stdio: 'pipe' });
}

async function runVariant(label, videoPath, timestampSec, negate) {
  const cacheDir = path.join(__dirname, '..', 'data', '_ocr_experiment_cache');
  const stem = label.replace(/[^a-z0-9]/g, '_');
  const framePath = path.join(cacheDir, `${stem}.png`);

  // Extract frame if not cached
  if (!fs.existsSync(framePath)) {
    await extractFrame(videoPath, timestampSec, framePath);
  }

  const cropPx = {
    left:   Math.round(1920 * CROP.x),
    top:    Math.round(1080 * CROP.y),
    width:  Math.round(1920 * CROP.w),
    height: Math.round(1080 * CROP.h),
  };

  const result = await ocrImage(framePath, {
    profile: 'chart_stream',
    chartStream: true,
    crop: cropPx,
    negate,
    // Scale is handled by the internal pipeline
  });

  const parsed = parseChartStreamPositionList({ ocr: result });
  return { result, parsed };
}

function score(gt, found) {
  const gtSet = new Set(gt);
  const foundSet = new Set(found);
  const hit = gt.filter(t => foundSet.has(t)).length;
  const miss = gt.filter(t => !foundSet.has(t));
  const extra = found.filter(t => !gtSet.has(t));
  const recall = gt.length > 0 ? hit / gt.length : 0;
  return { hit, miss, extra, recall, found };
}

async function main() {
  const output = [];
  const summary = {};

  for (const [date, v] of Object.entries(VIDEOS)) {
    output.push(`\n=== ${date} (t=${hms(v.ts)}) ===`);
    output.push(`Ground truth: ${v.gt.join(', ')}\n`);

    const variants = [
      [`${date}-1080p-orig`, v.video1080, v.ts, false],
      [`${date}-1080p-neg`,  v.video1080, v.ts, true],
      [`${date}-720p-orig`,  v.video720,  v.ts, false],
      [`${date}-720p-neg`,   v.video720,  v.ts, true],
    ];

    for (const [label, video, ts, negate] of variants) {
      try {
        const { result, parsed } = await runVariant(label, video, ts, negate);
        const { hit, miss, extra, recall, found } = score(v.gt, parsed.position_list);
        const conf = result.confidence != null ? result.confidence.toFixed(0) : '?';
        const pct = (recall * 100).toFixed(0);
        output.push(
          `  ${label.padEnd(20)} conf=${conf.toString().padStart(3)}%  ` +
          `recall=${pct.padStart(3)}% (${hit}/${v.gt.length})  ` +
          `found=[${parsed.position_list.join(', ')}]  ` +
          `miss=[${miss.join(', ')}]`
        );
        if (!summary[label]) summary[label] = [];
        summary[label].push({ date, recall, conf: parseInt(conf), found: parsed.position_list, miss });
      } catch (err) {
        output.push(`  ${label}: ERROR ${err.message}`);
      }
    }
  }

  // Per-variant mean recall
  output.push('\n=== MEAN RECALL PER VARIANT ===');
  const variantNames = Object.keys(summary);
  const means = {};
  for (const v of variantNames) {
    const recalls = summary[v].map(r => r.recall);
    const meanRecall = recalls.reduce((a, b) => a + b, 0) / recalls.length;
    const meanConf = summary[v].reduce((a, r) => a + r.conf, 0) / summary[v].length;
    means[v] = meanRecall;
    output.push(`  ${v.padEnd(20)} mean-recall=${(meanRecall*100).toFixed(0)}%  mean-conf=${meanConf.toFixed(0)}%`);
  }

  const ranked = variantNames.sort((a, b) => means[b] - means[a]);
  output.push('\n=== RANKED ===');
  ranked.forEach((v, i) => output.push(`  ${i+1}. ${v} → ${(means[v]*100).toFixed(0)}% mean recall`));

  const log = output.join('\n');
  console.log(log);
  fs.writeFileSync(path.join(__dirname, '_qmg_ocr_experiment.log'), log, 'utf8');
  console.log('\n[Wrote _qmg_ocr_experiment.log]');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
