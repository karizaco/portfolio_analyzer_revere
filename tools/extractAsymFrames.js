'use strict';

// Grab FRAMES from the AsymTrading videos, so the sector table can be read.
//
// WHY FRAMES AND NOT VIDEOS
//
// The Market Pulse video is a TradeStation screencast whose left-hand
// panel is a live table of the eleven GICS sectors with their numbers.
// That table is the one piece of quantitative market data in this source
// that the written report does not carry.
//
// The table is what matters, and the table is STATIC -- it sits in the
// same place in every frame, and only its VALUES change as the week
// goes on. So the pipeline does not need the video. It needs a handful of
// 1080p frames.
//
// ffmpeg seeks into the remote MP4 with an HTTP Range request, so one
// frame costs about six seconds and a few megabytes. The whole video is
// 271 MB. Measured on one post:
//
//   one 1080p frame from the remote MP4    5.8 s
//   the whole 480x270 rendition            45.7 s, 93.9 MB
//   the whole 1920x1080 rendition        271 MB, ~36 min at 126 KB/s
//
// SO WHY SEVERAL FRAMES PER POST
//
// Because the table SCROLLS. The sector list is scrolled, so one frame
// shows only part of the eleven rows, and which part depends on the
// video -- measured: one frame showed Healthcare through Utilities and
// left the first three sectors above the fold, and another showed
// Financial Services through Technology. Eight frames spread over the
// video cover the list.
//
// USAGE
//
//   node tools/extractAsymFrames.js
//   node tools/extractAsymFrames.js --limit 2
//   node tools/extractAsymFrames.js --video-id asym_208954832
//   node tools/extractAsymFrames.js --frames 12
//   node tools/extractAsymFrames.js --json

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { createAsymClient } = require('../src/asym/substackClient');
const { resolveFfmpegBin } = require('../src/video/ffmpegBin');
const { portablePath } = require('../src/asym/mediaStore');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const FRAMES_DIR = path.join(ROOT, 'data', 'video_pipeline', 'frames_asym');

/**
 * How many frames to take per post by default.
 *
 * Eight, spread over the video. Measured: the sector list has eleven
 * rows and the table scrolls, so one frame is never enough.
 */
const DEFAULT_FRAMES = 8;

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  frames: Number(readFlag(argv, '--frames')) || DEFAULT_FRAMES,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
};

/**
 * Read a flag's value.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string|null}
 */
function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || '';
}

/**
 * Open the catalog, applying the schema.
 *
 * @param {boolean} readOnly
 * @returns {DatabaseSync}
 */
function openCatalog(readOnly) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
  }
  const db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return db;
}

/**
 * The timestamps to grab, spread over the video.
 *
 * The first is early and the last is late, because the table is on
 * screen the whole time and what changes is where it is scrolled to.
 *
 * @param {number} durationSec
 * @param {number} count
 * @returns {number[]}
 */
function frameTimestamps(durationSec, count) {
  const total = Math.max(1, count);
  const stamps = [];
  for (let i = 0; i < total; i += 1) {
    // From 8% to 92% of the way through.
    const fraction = 0.08 + (0.84 * i) / Math.max(1, total - 1);
    stamps.push(Math.round(durationSec * fraction));
  }
  return stamps;
}

/**
 * Grab one frame with ffmpeg.
 *
 * @param {string} input - a file path or an http(s) URL
 * @param {number} timestampSec
 * @param {string} destination
 * @returns {{ok: boolean, error: string}}
 */
function grabFrame(input, timestampSec, destination) {
  const ffmpeg = resolveFfmpegBin();
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      // The seek goes BEFORE the input, so ffmpeg seeks in the file
      // rather than decoding everything up to the timestamp. Over HTTP
      // that is what turns a 271 MB download into a range request.
      '-ss', String(timestampSec),
      '-i', input,
      '-frames:v', '1',
      '-f', 'image2',
      destination,
    ],
    { encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').slice(-2).join(' ');
    return { ok: false, error: stderr || `ffmpeg exited ${result.status}` };
  }
  if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
    return { ok: false, error: 'ffmpeg produced no frame' };
  }
  return { ok: true, error: '' };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const db = openCatalog(options.dryRun);
  const posts = selectPosts(db);
  console.log(`[asym-frames] posts=${posts.length} frames=${options.frames} per post`
    + `${options.dryRun ? ' DRY-RUN' : ''}`);

  const client = createAsymClient({ pageSize: 1, pauseMs: 0, log: () => {} });
  const summary = {
    command: ['extractAsymFrames.js', ...argv],
    posts: posts.length,
    frames: 0,
    failed: 0,
    bytes: 0,
    rows: [],
  };

  for (const post of posts) {
    // A local video is used when there is one: no network, and it is the
    // same picture.
    const localVideo = findLocalVideo(post);
    let source = localVideo ? localVideo : null;
    let sourceKind = localVideo ? 'local' : 'remote';

    if (!source) {
      const url = await client.resolveVideoUrl(post.media_upload_id, { type: 'mp4' });
      source = url;
    }

    // The DURATION comes from the Mux metadata, not from the catalog:
    // it is what the frame timestamps are spread over.
    let duration = post.duration_sec || 0;
    if (!duration) {
      try {
        const meta = await client.getVideo(post.media_upload_id);
        duration = Number(meta && meta.duration) || 0;
      } catch (error) {
        console.error(`[asym-frames] ${post.video_id} metadata unavailable: ${error.message}`);
      }
    }
    if (!duration) {
      summary.failed += 1;
      console.error(`[asym-frames] ${post.video_id} skipped: no duration`);
      continue;
    }

    const stamps = frameTimestamps(duration, options.frames);
    const postDir = path.join(FRAMES_DIR, post.video_id);
    fs.mkdirSync(postDir, { recursive: true });

    for (let index = 0; index < stamps.length; index += 1) {
      const stamp = stamps[index];
      const destination = path.join(postDir, `f${String(index).padStart(2, '0')}_${stamp}.png`);

      if (!options.force && fs.existsSync(destination) && fs.statSync(destination).size > 0) {
        summary.frames += 1;
        summary.bytes += fs.statSync(destination).size;
        continue;
      }

      if (options.dryRun) {
        summary.rows.push({ video_id: post.video_id, frame_index: index, timestamp_sec: stamp, source: sourceKind });
        continue;
      }

      const grabbed = grabFrame(source, stamp, destination);
      if (!grabbed.ok) {
        summary.failed += 1;
        console.error(`[asym-frames] ${post.video_id} @${stamp}s failed: ${grabbed.error}`);
        continue;
      }

      const bytes = fs.statSync(destination).size;
      summary.frames += 1;
      summary.bytes += bytes;
      db.prepare(`
        INSERT INTO asym_frames (video_id, frame_index, timestamp_sec, file_path, file_bytes, width, height, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id, frame_index) DO UPDATE SET
          timestamp_sec = excluded.timestamp_sec,
          file_path = excluded.file_path,
          file_bytes = excluded.file_bytes,
          width = excluded.width,
          height = excluded.height,
          source = excluded.source
      `).run(post.video_id, index, stamp, portablePath(destination), bytes, 1920, 1080, sourceKind);
    }

    if (!options.json) {
      console.log(`[asym-frames] ${post.upload_date} ${post.video_id} -> ${stamps.length} frame(s) from ${sourceKind}`);
    }
  }

  if (!options.dryRun) db.close();

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`[asym-frames] frames=${summary.frames} failed=${summary.failed} bytes=${summary.bytes}`);
  if (options.dryRun) console.log('[asym-frames] dry run: nothing was grabbed.');
}

/**
 * The posts to grab frames from.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function selectPosts(db) {
  const params = [];
  let sql = `SELECT p.video_id, p.post_id, p.upload_date, p.media_upload_id,
                    m.file_path AS media_path, m.kind AS media_kind
               FROM asym_posts p
               LEFT JOIN asym_media m ON m.video_id = p.video_id AND m.kind = 'video'
              WHERE p.has_media = 1 AND p.media_upload_id <> ''`;
  if (options.videoId) {
    sql += ' AND p.video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY p.upload_date DESC';

  let rows = db.prepare(sql).all(...params);
  if (options.limit) rows = rows.slice(0, options.limit);
  return rows.map((row) => ({
    ...row,
    duration_sec: row.duration_sec || 0,
  }));
}

/**
 * The local video for a post, when there is one.
 *
 * @param {object} post
 * @returns {string|null}
 */
function findLocalVideo(post) {
  if (post.media_kind !== 'video' || !post.media_path) return null;
  const absolute = path.join(ROOT, post.media_path);
  return fs.existsSync(absolute) ? absolute : null;
}

main().catch((error) => {
  console.error(`[asym-frames] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});