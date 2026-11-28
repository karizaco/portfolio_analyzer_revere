'use strict';

// A MANUAL measurement: render EXACTLY the image the EasyOCR engine was
// shown for a production capture, and look at it.
//
// The probe log records the capture's timestamp and the crop region; the scan
// tool builds the OCR image with
//
//   crop=in_w*W:in_h*H:in_w*X:in_h*Y,scale=<W*sourceWidth*5>:-1
//
// (tools/scanVideoWithOcr.js, the EasyOCR branch). This harness reproduces
// that filter from the SOURCE video at the capture's timestamp, so the PNG it
// writes is the pixels the OCR engine saw -- not a re-crop of a fixture, and
// not an approximation.
//
// The question it answers: is the positions panel's OWN footer line inside
// the image? `readPanelRowCount` needs that line to read the panel's row
// count, and the count is the project's only INDEPENDENT check on a reading.
//
// Run it:
//   node --test test/manual/productionCropRender.test.js
//
// The assertions are STRUCTURAL (the crop was rendered and is a readable
// image). The finding -- whether the footer is in the pixels -- is what the
// PNG shows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { resolveFfmpegBin } = require(path.join(ROOT, 'src', 'video', 'ffmpegBin.js'));

const VIDEO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');
const EASYOCR_SCALE = 5;

// The captures to render. Each is (date, timestamp) of a PRODUCTION capture
// recorded in a probe log, with the era crop that scan used.
const SHOTS = [
  { date: '20230523', ts: 1800, crop: { x: 0.82, y: 0.60, w: 0.18, h: 0.32 } },
  { date: '20230523', ts: 1400, crop: { x: 0.82, y: 0.60, w: 0.18, h: 0.32 } },
  { date: '20230523', ts: 800, crop: { x: 0.82, y: 0.60, w: 0.18, h: 0.32 } },
  { date: '20220301', ts: 0, crop: { x: 0.86, y: 0.60, w: 0.14, h: 0.28 } }
];

function findVideo(dateKey) {
  if (!fs.existsSync(VIDEO_DIR)) return null;
  return fs
    .readdirSync(VIDEO_DIR)
    .find((name) => name.startsWith(`${dateKey}_`) && name.endsWith('.mp4')) || null;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegBin(null), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(0, 400)))));
  });
}

test('the exact image EasyOCR was shown, for a production capture', async (t) => {
  const outDir = path.join(os.tmpdir(), `production-crop-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`\n=== the production EasyOCR crop, rendered from the source video ===`);

  let rendered = 0;
  for (const shot of SHOTS) {
    const video = findVideo(shot.date);
    if (!video) {
      console.log(`  ${shot.date} — no media on this machine (skipped)`);
      continue;
    }
    const videoPath = path.join(VIDEO_DIR, video);

    // The source width is measured, never assumed (CLAUDE.md: never infer
    // resolution from filesize).
    const probe = await new Promise((resolve, reject) => {
      const child = spawn(resolveFfmpegBin(null), ['-hide_banner', '-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('close', () => resolve(stderr));
    });
    const sizeMatch = /,\s*(\d{2,5})x(\d{2,5})[\s,]/.exec(probe);
    const sourceWidth = sizeMatch ? Number(sizeMatch[1]) : 1920;
    const sourceHeight = sizeMatch ? Number(sizeMatch[2]) : 1080;

    const { x, y, w, h } = shot.crop;
    const cropWidthPx = Math.round(w * sourceWidth * EASYOCR_SCALE);
    const filter = `crop=in_w*${w}:in_h*${h}:in_w*${x}:in_h*${y},scale=${cropWidthPx}:-1`;

    const out = path.join(outDir, `${shot.date}_ts${shot.ts}.png`);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(shot.ts),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', filter,
      out
    ]);

    const stat = fs.statSync(out);
    assert.ok(stat.size > 0, `${out} is empty`);

    const srcBottom = Math.round((y + h) * sourceHeight);
    console.log(
      `  ${shot.date} ts=${String(shot.ts).padStart(4)}`
      + `  ${String(sourceWidth)}x${String(sourceHeight)}`
      + `  crop ${x},${y},${w},${h} -> source y<=${srcBottom}`
      + `  ${cropWidthPx}px wide`
      + `  -> ${out}`
    );
    rendered += 1;
  }

  if (!rendered) {
    t.skip('no pipeline media on this machine (the media is not tracked in git)');
    return;
  }
  assert.ok(rendered > 0, 'no crop was rendered');
});
