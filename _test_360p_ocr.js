'use strict';
const { ocrImage } = require('./src/ocr/ocrImage');
const { parseChartStreamPositionList } = require('./src/parse/parseChartStream');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const cacheDir = 'data/_ocr_experiment_cache';
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

async function extractFrame(videoPath, timestamp, outputPath) {
  if (fs.existsSync(outputPath)) return;
  const h = Math.floor(timestamp / 3600);
  const m = Math.floor((timestamp % 3600) / 60);
  const s = Math.floor(timestamp % 60);
  const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  execFileSync('ffmpeg', ['-y','-ss',timeStr,'-i',videoPath,'-vframes','1','-q:v','2',outputPath], { stdio: 'pipe' });
  console.log('Extracted:', outputPath);
}

async function testVariant(label, imagePath, negate) {
  // Check dimensions with node
  let dimsStr = 'unknown';
  try {
    const meta = await (async () => {
      const sharp = require('sharp');
      return await sharp(imagePath).metadata();
    })();
    dimsStr = `${meta.width}x${meta.height}`;
  } catch(_) {}
  console.log(`  ${label}: ${dimsStr}`);

  const r = await ocrImage(imagePath, {
    chartStream: true,
    overlayRegion: { x: 0.70, y: 0.60, w: 0.30, h: 0.40 },
    overlayScale: 3,
    negate
  });
  const p = parseChartStreamPositionList({ ocr: r });
  return { conf: r.confidence, text: r.text, pos: p.position_list, status: p.parse_status };
}

const VIDEOS = {
  '20220606': {
    video360: 'data/video_pipeline/downloads/20220606_aaIlqb7HUJQ.mp4',
    video1080: 'data/video_pipeline/downloads_1080p/20220606_aaIlqb7HUJQ.mp4',
    snap1080: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606.png',
    ts: 1440,
    gt: ['GOVX','LABU','UCO','ALB','CBIO','VLO','TNA','NFLX'],
  },
  '20220607': {
    video360: 'data/video_pipeline/downloads/20220607_i0Iq83_54Xs.mp4',
    snap1080: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220607.png',
    ts: 672,
    gt: ['UCO','VLO','ALB','BOIL','NFLX','TNA','LTHM'],
  },
  '20230126': {
    video360: 'data/video_pipeline/downloads/20230126_GdMs1y_RTnM.mp4',
    snap1080: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20230126.png',
    ts: 1120,
    gt: ['CVNA','FCX','TNA','CWEB','YINN','PDD','MDGL','GNS'],
  },
};

async function main() {
  const results = [];

  for (const [date, v] of Object.entries(VIDEOS)) {
    console.log(`\n=== ${date} (t=${Math.floor(v.ts/60)}m) ===`);
    console.log(`Ground truth: ${v.gt.join(', ')}`);

    // 1. 1080p snapshot + negate (reference — current pipeline)
    if (v.snap1080 && fs.existsSync(v.snap1080)) {
      const r = await testVariant(`${date}-1080p-snap-neg`, v.snap1080, true);
      const hit = v.gt.filter(t => r.pos.includes(t));
      console.log(`  found=[${r.pos.join(', ')}]  recall=${hit.length}/${v.gt.length}  conf=${r.confidence}`);
      results.push({ date, variant: `${date}-1080p-snap-neg`, recall: hit.length/v.gt.length, conf: r.confidence, pos: r.pos });
    }

    // 2. 1080p snapshot + NO negate
    if (v.snap1080 && fs.existsSync(v.snap1080)) {
      const r = await testVariant(`${date}-1080p-snap-orig`, v.snap1080, false);
      const hit = v.gt.filter(t => r.pos.includes(t));
      console.log(`  found=[${r.pos.join(', ')}]  recall=${hit.length}/${v.gt.length}  conf=${r.confidence}`);
      results.push({ date, variant: `${date}-1080p-snap-orig`, recall: hit.length/v.gt.length, conf: r.confidence, pos: r.pos });
    }

    // 3. 360p video frame + negate
    if (v.video360 && fs.existsSync(v.video360)) {
      const framePath = path.join(cacheDir, `${date}_360p_frame.png`);
      await extractFrame(v.video360, v.ts, framePath);
      const r = await testVariant(`${date}-360p-neg`, framePath, true);
      const hit = v.gt.filter(t => r.pos.includes(t));
      console.log(`  found=[${r.pos.join(', ')}]  recall=${hit.length}/${v.gt.length}  conf=${r.confidence}`);
      results.push({ date, variant: `${date}-360p-neg`, recall: hit.length/v.gt.length, conf: r.confidence, pos: r.pos });
    }

    // 4. 360p video frame + no negate
    if (v.video360 && fs.existsSync(v.video360)) {
      const framePath = path.join(cacheDir, `${date}_360p_frame.png`);
      const r = await testVariant(`${date}-360p-orig`, framePath, false);
      const hit = v.gt.filter(t => r.pos.includes(t));
      console.log(`  found=[${r.pos.join(', ')}]  recall=${hit.length}/${v.gt.length}  conf=${r.confidence}`);
      results.push({ date, variant: `${date}-360p-orig`, recall: hit.length/v.gt.length, conf: r.confidence, pos: r.pos });
    }
  }

  // Summary
  console.log('\n\n=== MEAN RECALL PER VARIANT ===');
  const byVariant = {};
  for (const r of results) {
    if (!byVariant[r.variant]) byVariant[r.variant] = [];
    byVariant[r.variant].push(r);
  }
  for (const [variant, rows] of Object.entries(byVariant)) {
    const meanRecall = rows.reduce((a,b) => a + b.recall, 0) / rows.length;
    const meanConf = rows.reduce((a,b) => a + b.conf, 0) / rows.length;
    console.log(`  ${variant.padEnd(25)} recall=${(meanRecall*100).toFixed(0)}%  conf=${meanConf.toFixed(0)}%`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
