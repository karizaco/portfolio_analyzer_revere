'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Extracting the panel crop straight from the SOURCE video frame.
//
// WHY THIS EXISTS
// The OCR-resolution frame is a downscaled copy of the video: 1280x720 for
// a 1920x1080 source. The position list's ticker glyphs are ~6.8 source px
// tall, so in the downscaled frame they are ~4.5 px tall and effectively
// unreadable — measured on 20220218, the 1280-source crop of a panel that is
// perfectly legible to the eye was read as "US / D / WCU / W / KOCO" instead
// of "UPST / DVN / NRGU / MOS / TQQQ". The same panel read from the
// 1920-source frame is read correctly.
//
// Every crop therefore comes from the original video, never from the
// OCR-resolution frame.

/**
 * The pixel size of a video's video stream.
 *
 * Resolution is measured with ffprobe, never inferred from the file size: a
 * 10-minute FullHD video can be under 1 GB and a 2-hour 720p video can be
 * 2 GB (see CLAUDE.md).
 */
function probeVideoSize(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', videoPath,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const streams = JSON.parse(out).streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) {
    throw new Error(`no video stream in ${videoPath}`);
  }
  return { width: video.width, height: video.height };
}

/**
 * Turn a fractional region into pixel coordinates on a given frame.
 *
 * The fractions come from the probe logs (phash_region_fraction), so the
 * crop is the same region the pipeline looked at — only at source
 * resolution.
 */
function regionToPixels(region, frameWidth, frameHeight) {
  const x = Math.max(0, Math.round((region.x || 0) * frameWidth));
  const y = Math.max(0, Math.round((region.y || 0) * frameHeight));
  const w = Math.max(1, Math.round((region.w === undefined ? 1 : region.w) * frameWidth));
  const h = Math.max(1, Math.round((region.h === undefined ? 1 : region.h) * frameHeight));
  return {
    x,
    y,
    width: Math.min(w, frameWidth - x),
    height: Math.min(h, frameHeight - y),
  };
}

/**
 * Extract one panel crop from a video frame, at source resolution.
 *
 * `-ss` before `-i` seeks by keyframe, which is fast; the frame that lands
 * is then within a second or two of the requested timestamp. The position
 * list changes slowly, so that is immaterial for reading it — but it does
 * mean the timestamp is approximate, and the caller should treat it as "a
 * moment in this video", not "this exact frame".
 *
 * @returns {Promise<{file: string, width: number, height: number}>}
 */
async function extractPanelCrop(videoPath, ts, region, outPath, options = {}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`video not found: ${videoPath}`);
  }
  const size = options.frameSize || probeVideoSize(videoPath);
  const px = regionToPixels(region, size.width, size.height);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(ts),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `crop=${px.width}:${px.height}:${px.x}:${px.y}`,
    outPath,
  ];
  await new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve();
    });
  });

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error(`ffmpeg produced no output for ${videoPath} @ ${ts}s`);
  }
  const meta = await require('sharp')(outPath).metadata();
  return { file: outPath, width: meta.width, height: meta.height };
}

module.exports = {
  probeVideoSize,
  regionToPixels,
  extractPanelCrop,
};
