'use strict';

// Download the video of a free AsymTrading post.
//
// WHAT IT DOES
//
// Walks the posts that carry an embedded video, resolves the signed Mux
// URL for each, downloads the MP4, checks the resolution with ffprobe, and
// records what happened in `asym_media`.
//
// WHY A SEPARATE DOWNLOADER
//
// Every other source in this project is a YouTube channel, so its media
// comes from yt-dlp. This one does not: Substack serves the embedded
// video from its own Mux account, behind a signed URL that expires in
// about 24 hours. There is no yt-dlp extractor for that, and writing one
// would be a lot of machinery for a different CDN.
//
// THE SIGNED URL IS RESOLVED AT DOWNLOAD TIME, EVERY TIME
//
// The redirect from Substack carries a token with an `exp` about 24 hours
// out. A URL stored in the catalog would be a promise that expires, so
// the catalog stores the permanent media-upload id and the URL is
// resolved fresh for each download.
//
// THE RESOLUTION GATE
//
// A downloaded file is accepted only when ffprobe says it is at least
// 1280x720. The project's rule is that filesize says nothing about
// resolution -- a 10-minute FullHD video can be under 1 GB and a 2-hour
// 720p video can be 2 GB -- so the only honest check is to measure the
// stream. A file that fails the gate is DELETED, not kept: keeping it
// would leave the pipeline reading a video it cannot use, and the
// transcript step would then run over it.
//
// THE COST OF A FULL RUN
//
// Measured over the 24 free posts that carry media: 8.51 GB and 16.8
// hours of audio, every one of them 1920x1080. So run it with --limit
// while you are finding your feet.
//
// Usage:
//   node tools/downloadAsymVideos.js
//   node tools/downloadAsymVideos.js --limit 1
//   node tools/downloadAsymVideos.js --video-id asym_222466781
//   node tools/downloadAsymVideos.js --dry-run
//   node tools/downloadAsymVideos.js --json

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { createAsymClient } = require('../src/asym/substackClient');
const {
  ASYM_MEDIA_DIR,
  ASYM_MEDIA_STATUS,
  asymMediaPath,
  checkResolution,
  ensureFreeSpace,
  mediaWorkList,
  portablePath,
  probeMedia,
  recordMedia,
} = require('../src/asym/mediaStore');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/**
 * How long to wait between downloads.
 *
 * The Mux CDN is a CDN and not an API, so this is politeness rather than
 * rate-limit avoidance -- but a 24-video run that fires 24 requests back
 * to back is rude, and the pause costs nothing next to 8.5 GB of
 * downloading.
 */
const DEFAULT_PAUSE_MS = 3000;

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  pauseMs: Number(readFlag(argv, '--pause-ms')) || DEFAULT_PAUSE_MS,
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
 * Wait.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
 * What the publication says about one video's size and shape.
 *
 * The endpoint is worth calling before the download: it reports the
 * primary file's size, which is what the free-space check needs, and it
 * works without spending a byte of bandwidth.
 *
 * @param {object} client
 * @param {string} mediaUploadId
 * @returns {Promise<{bytes: number, width: number, height: number, duration: number}>}
 */
async function describeMedia(client, mediaUploadId) {
  const meta = await client.getVideo(mediaUploadId);
  const source = meta && typeof meta === 'object' ? meta : {};
  const duration = Number(source.duration ?? source.duration_seconds ?? 0) || 0;
  const bytes = Number(source.primary_file_size ?? source.file_size ?? 0) || 0;
  const width = Number(source.width ?? source.aspect_ratio_width ?? 0) || 0;
  const height = Number(source.height ?? source.aspect_ratio_height ?? 0) || 0;
  return { bytes, width, height, duration };
}

/**
 * Download one file to disk, streaming it.
 *
 * The response is a web stream and the file is hundreds of megabytes, so
 * it is piped rather than buffered: `arrayBuffer()` on a 645 MB video
 * would put 645 MB in memory.
 *
 * @param {string} url - the signed URL
 * @param {string} destination
 * @returns {Promise<{bytes: number}>}
 */
async function downloadTo(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  const stat = fs.statSync(destination);
  return { bytes: stat.size };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  fs.mkdirSync(ASYM_MEDIA_DIR, { recursive: true });

  const db = openCatalog(options.dryRun);
  let work = mediaWorkList(db, { includeDone: options.force });
  if (options.videoId) {
    work = work.filter((row) => row.video_id === options.videoId);
  }
  if (options.limit) {
    work = work.slice(0, options.limit);
  }

  if (!work.length) {
    console.log('[asym-media] nothing to do: every post with media is already downloaded.');
    db.close();
    return;
  }

  const client = createAsymClient({
    pageSize: 1,
    pauseMs: 0,
    log: () => {},
  });

  const summary = {
    command: ['downloadAsymVideos.js', ...argv],
    candidates: work.length,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    rows: [],
  };

  for (const post of work) {
    const target = asymMediaPath(post);
    const label = `${post.upload_date} ${post.video_id}`;

    // A row that says "downloaded" but whose file is gone is not
    // downloaded. This is the resume check, and it is why the file's
    // existence is checked rather than the row's status alone.
    if (!options.force && post.media_status === ASYM_MEDIA_STATUS.DOWNLOADED && fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (stat.size > 0) {
        summary.skipped += 1;
        if (!options.json) console.log(`[asym-media] ${label} already downloaded (${stat.size} bytes)`);
        continue;
      }
    }

    let described = { bytes: 0, width: 0, height: 0, duration: 0 };
    try {
      described = await describeMedia(client, post.media_upload_id);
    } catch (error) {
      // The metadata is a convenience -- the free-space check and the
      // duration. A failure here is not a reason to refuse the download.
      if (!options.json) console.log(`[asym-media] ${label} metadata unavailable: ${error.message}`);
    }

    if (options.dryRun) {
      summary.rows.push({
        video_id: post.video_id,
        upload_date: post.upload_date,
        file: portablePath(target),
        expected_bytes: described.bytes,
        duration_sec: described.duration,
        action: 'would-download',
      });
      if (!options.json) {
        console.log(`[asym-media] ${label} would download -> ${portablePath(target)}`
          + ` (${described.bytes} bytes, ${described.duration}s)`);
      }
      continue;
    }

    // The space check needs a size. The metadata endpoint gave us one;
    // when it did not, fall back to a conservative estimate so a missing
    // number cannot turn into an unfillable disk.
    const expected = described.bytes || 400 * 1024 * 1024;
    const space = ensureFreeSpace(ASYM_MEDIA_DIR, expected);
    if (!space.ok) {
      summary.failed += 1;
      recordMedia(db, {
        video_id: post.video_id,
        media_upload_id: post.media_upload_id,
        status: ASYM_MEDIA_STATUS.ERROR,
        error: space.reason,
        attempts: 1,
      });
      console.error(`[asym-media] ${label} skipped: ${space.reason}`);
      continue;
    }

    const partial = `${target}.part`;
    try {
      const signedUrl = await client.resolveVideoUrl(post.media_upload_id, { type: 'mp4' });
      const { bytes } = await downloadTo(signedUrl, partial);

      const probe = probeMedia(partial);
      const gate = checkResolution(probe);

      if (!gate.ok) {
        fs.unlinkSync(partial);
        summary.failed += 1;
        recordMedia(db, {
          video_id: post.video_id,
          media_upload_id: post.media_upload_id,
          status: ASYM_MEDIA_STATUS.ERROR,
          error: `resolution_gate:${gate.reason}`,
          attempts: 1,
        });
        console.error(`[asym-media] ${label} rejected: ${gate.reason}`);
        continue;
      }

      fs.renameSync(partial, target);
      summary.downloaded += 1;
      summary.bytes += bytes;
      recordMedia(db, {
        video_id: post.video_id,
        media_upload_id: post.media_upload_id,
        file_path: portablePath(target),
        file_bytes: bytes,
        width: probe.width,
        height: probe.height,
        duration_sec: probe.duration || described.duration,
        status: ASYM_MEDIA_STATUS.DOWNLOADED,
        error: '',
        attempts: 1,
        downloaded_at: new Date().toISOString(),
      });
      summary.rows.push({
        video_id: post.video_id,
        upload_date: post.upload_date,
        file: portablePath(target),
        bytes,
        width: probe.width,
        height: probe.height,
        duration_sec: probe.duration,
        action: 'downloaded',
      });
      if (!options.json) {
        console.log(`[asym-media] ${label} downloaded -> ${portablePath(target)}`
          + ` (${bytes} bytes, ${probe.width}x${probe.height})`);
      }
    } catch (error) {
      // A half-written file is not a file. Leaving it would make the next
      // run think the download was interrupted rather than failed, and the
      // space it holds is space nothing else can use.
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* ignore */ }
      summary.failed += 1;
      recordMedia(db, {
        video_id: post.video_id,
        media_upload_id: post.media_upload_id,
        status: ASYM_MEDIA_STATUS.ERROR,
        error: String(error && error.message ? error.message : error).slice(0, 300),
        attempts: 1,
      });
      console.error(`[asym-media] ${label} failed: ${error && error.message ? error.message : error}`);
    }

    if (options.pauseMs) await sleep(options.pauseMs);
  }

  if (!options.dryRun) db.close();

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`[asym-media] downloaded=${summary.downloaded} skipped=${summary.skipped}`
    + ` failed=${summary.failed} bytes=${summary.bytes}`);
  if (options.dryRun) console.log('[asym-media] dry run: nothing was downloaded.');
}

main().catch((error) => {
  console.error(`[asym-media] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});