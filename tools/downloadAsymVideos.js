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
// TWO MODES, AND THE DIFFERENCE IS WORTH 4.25x OF BANDWIDTH
//
//   (default)  the 1920x1080 MP4. Needed if the FRAMES are to be read --
//              the video is a TradeStation screencast whose sector table
//              is legible at 1080p and not at 480x270.
//
//   --audio    the AUDIO only: the 480x270 rendition is downloaded, the
//              audio is extracted from it, and the video is deleted. The
//              whole free corpus is about 360 MB this way, against
//              8.51 GB of video.
//
// The audio is not a different recording, it is the SAME audio in a
// smaller file: Mux serves one master audio track muxed into every
// rendition. Measured on one post, the transcripts of the 1920x1080 and
// the 480x270 renditions agree on 98.4% of their words (982 of 998).
//
// So --audio is a transcript-only fast path, not a lossless substitute
// for the video.
//
// Usage:
//   node tools/downloadAsymVideos.js
//   node tools/downloadAsymVideos.js --limit 1
//   node tools/downloadAsymVideos.js --audio --limit 4
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
const { extractAudio } = require('../src/transcript/deepgramClient');
const {
  ASYM_AUDIO_DIR,
  ASYM_MEDIA_DIR,
  ASYM_MEDIA_KIND,
  ASYM_MEDIA_STATUS,
  asymAudioPath,
  asymMediaPath,
  checkAudio,
  checkVideo,
  ensureAsymMediaSchema,
  ensureFreeSpace,
  mediaWorkList,
  portablePath,
  probeAudio,
  probeMedia,
  recordMedia,
  sweepStalePartials,
  takeDownloadLock,
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

/**
 * How often to report progress.
 *
 * A download that prints nothing for half an hour looks like a freeze,
 * and the only way to tell a slow download from a hung one is to say how
 * many bytes have arrived.
 */
const PROGRESS_MS = 5000;

/**
 * How long the connection may deliver NOTHING before the download is
 * called stalled.
 *
 * A slow link is fine; a link that has stopped is not, and without this
 * the two are indistinguishable.
 */
const STALL_MS = 90000;

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  pauseMs: Number(readFlag(argv, '--pause-ms')) || DEFAULT_PAUSE_MS,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  // The audio-only fast path.
  audio: argv.includes('--audio'),
  // Which Mux rendition to fetch. The default depends on the mode: the
  // audio path wants the SMALL one, because only the audio is read; the
  // video path wants the big one, because the frames are.
  rendition: (readFlag(argv, '--rendition') || '').trim().toLowerCase(),
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
 * FOUR THINGS THIS DOES THAT A PLAIN `fetch` DOES NOT
 *
 * 1. IT RESUMES. A partial file is continued with an HTTP Range request
 *    rather than started again. A 271 MB download measured at 126 KB/s
 *    takes 36 minutes, and a connection that dies at 90% must not throw
 *    away 90% of it.
 *
 * 2. IT REPORTS PROGRESS. A download that prints nothing for 36 minutes
 *    looks exactly like a freeze, and the only way to tell the two apart
 *    is to print the bytes and the rate.
 *
 * 3. IT DETECTS A STALL. If no bytes arrive for STALL_MS, the request is
 *    aborted and the error says so. A hung socket is otherwise
 *    indistinguishable from a slow one.
 *
 * 4. IT CHECKS THE LENGTH. The response carries a Content-Length, and the
 *    file has to end up that long. A body that ends early is a failure,
 *    not a shorter file -- and the resolution gate alone would not notice,
 *    because a truncated video still has a valid header.
 *
 * @param {string} url - the signed URL
 * @param {string} destination
 * @param {object} [options]
 * @param {boolean} [options.resume] - continue a partial file
 * @param {number} [options.stallMs] - abort after this long with no bytes
 * @param {(info: object) => void} [options.onProgress]
 * @returns {Promise<{bytes: number, expected: number, resumed: boolean}>}
 */
async function downloadTo(url, destination, options = {}) {
  const stallMs = Number(options.stallMs) || STALL_MS;
  let offset = 0;
  if (options.resume !== false && fs.existsSync(destination)) {
    offset = fs.statSync(destination).size;
  }

  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const response = await fetch(url, { redirect: 'follow', headers });

  // A server that ignores the Range answers 200 with the WHOLE file, and
  // appending that to the partial file would corrupt it. So the response
  // code decides what happens: 206 means the range was honoured.
  const resumed = response.status === 206;
  if (offset > 0 && !resumed) {
    offset = 0;
  }
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  // The total size of the file, from either header.
  const contentRange = response.headers.get('content-range') || '';
  const rangeTotal = /\/(\d+)\s*$/.exec(contentRange);
  const expected = rangeTotal
    ? Number(rangeTotal[1])
    : Number(response.headers.get('content-length') || 0) + offset;

  const sink = fs.createWriteStream(destination, { flags: resumed ? 'a' : 'w' });
  let written = offset;
  let lastTick = Date.now();
  let lastWritten = written;

  const reader = Readable.fromWeb(response.body);
  reader.on('data', (chunk) => {
    written += chunk.length;
    const now = Date.now();
    if (now - lastTick >= PROGRESS_MS) {
      const seconds = (now - lastTick) / 1000;
      const rate = (written - lastWritten) / seconds;
      if (options.onProgress) {
        options.onProgress({
          written,
          expected,
          rate,
          elapsedMs: now - lastTick,
        });
      }
      lastTick = now;
      lastWritten = written;
    }
  });

  // The stall detector: a timer that is reset by every chunk, and aborts
  // the request when it fires.
  const controller = new AbortController();
  const stallTimer = setTimeout(() => controller.abort(), stallMs);
  reader.on('data', () => {
    clearTimeout(stallTimer);
    stallTimer.refresh();
  });

  try {
    await pipeline(reader, sink, { signal: controller.signal });
  } catch (error) {
    clearTimeout(stallTimer);
    if (error && error.name === 'AbortError') {
      throw new Error(`download stalled: no bytes for ${Math.round(stallMs / 1000)}s`);
    }
    throw error;
  }
  clearTimeout(stallTimer);

  const bytes = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
  if (expected > 0 && bytes !== expected) {
    throw new Error(`download incomplete: ${bytes} of ${expected} bytes`);
  }
  return { bytes, expected, resumed };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  fs.mkdirSync(ASYM_MEDIA_DIR, { recursive: true });
  fs.mkdirSync(ASYM_AUDIO_DIR, { recursive: true });

  const swept = sweepStalePartials();
  if (swept && !options.json) {
    console.log(`[asym-media] removed ${swept} leftover file(s) from an interrupted run`);
  }

  // The lock is taken for the WHOLE run, so two downloaders cannot
  // compete for the same bandwidth and the same carrier names.
  const lock = takeDownloadLock();
  try {
    await runDownload();
  } finally {
    lock.release();
  }
}

/**
 * The download loop.
 *
 * @returns {Promise<void>}
 */
async function runDownload() {
  const db = openCatalog(options.dryRun);
  if (!options.dryRun) ensureAsymMediaSchema(db);
  let work = mediaWorkList(db, {
    includeDone: options.force,
    kind: options.audio ? ASYM_MEDIA_KIND.AUDIO : ASYM_MEDIA_KIND.VIDEO,
  });
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
    const label = `${post.upload_date} ${post.video_id}`;
    const kind = options.audio ? ASYM_MEDIA_KIND.AUDIO : ASYM_MEDIA_KIND.VIDEO;
    const target = options.audio ? asymAudioPath(post) : asymMediaPath(post);

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
        kind,
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
        kind,
        status: ASYM_MEDIA_STATUS.ERROR,
        error: space.reason,
        attempts: 1,
      });
      console.error(`[asym-media] ${label} skipped: ${space.reason}`);
      continue;
    }

    // The rendition. The video path wants the source resolution; the
    // audio path only reads the audio track, and the smaller rendition
    // carries the same master audio.
    const rendition = options.rendition || (options.audio ? 'low' : 'high');

    if (options.audio) {
      // The audio path: download the small video, extract the audio from
      // it, and delete the video. The video is only ever a carrier.
      const carrier = path.join(ASYM_MEDIA_DIR, `${post.post_id || post.video_id}.carrier.mp4`);
      // The temporary file keeps the .mp3 EXTENSION. ffmpeg picks the
      // muxer from the extension, and a file called "x.mp3.part" has no
      // known format: "Error initializing the muxer ... Invalid argument".
      const partialAudio = target.replace(/\.mp3$/, '.part.mp3');
      try {
        const signedUrl = await client.resolveVideoUrl(post.media_upload_id, { type: 'mp4', rendition });
        await downloadTo(signedUrl, carrier, {
          resume: false,
          onProgress: options.json ? null : (info) => console.log(progressLine(label, info)),
        });

        const extracted = extractAudio(carrier, partialAudio);
        try { fs.unlinkSync(carrier); } catch { /* ignore */ }
        if (!extracted.ok) {
          summary.failed += 1;
          recordMedia(db, {
            video_id: post.video_id,
            media_upload_id: post.media_upload_id,
            kind,
            status: ASYM_MEDIA_STATUS.ERROR,
            error: `audio_extract:${extracted.error}`,
            attempts: 1,
          });
          console.error(`[asym-media] ${label} audio extraction failed: ${extracted.error}`);
          continue;
        }

        const probe = probeAudio(partialAudio);
        const gate = checkAudio(probe, described.duration);
        if (!gate.ok) {
          fs.unlinkSync(partialAudio);
          summary.failed += 1;
          recordMedia(db, {
            video_id: post.video_id,
            media_upload_id: post.media_upload_id,
            kind,
            status: ASYM_MEDIA_STATUS.ERROR,
            error: `audio_gate:${gate.reason}`,
            attempts: 1,
          });
          console.error(`[asym-media] ${label} rejected: ${gate.reason}`);
          continue;
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(partialAudio, target);
        const bytes = fs.statSync(target).size;
        summary.downloaded += 1;
        summary.bytes += bytes;
        recordMedia(db, {
          video_id: post.video_id,
          media_upload_id: post.media_upload_id,
          kind,
          file_path: portablePath(target),
          file_bytes: bytes,
          width: 0,
          height: 0,
          duration_sec: probe.duration || described.duration,
          status: ASYM_MEDIA_STATUS.DOWNLOADED,
          error: '',
          attempts: 1,
          downloaded_at: new Date().toISOString(),
        });
        summary.rows.push({
          video_id: post.video_id,
          upload_date: post.upload_date,
          kind,
          file: portablePath(target),
          bytes,
          duration_sec: probe.duration,
          action: 'downloaded',
        });
        if (!options.json) {
          console.log(`[asym-media] ${label} audio -> ${portablePath(target)}`
            + ` (${bytes} bytes, ${probe.duration}s)`);
        }
      } catch (error) {
        try { if (fs.existsSync(carrier)) fs.unlinkSync(carrier); } catch { /* ignore */ }
        try { if (fs.existsSync(partialAudio)) fs.unlinkSync(partialAudio); } catch { /* ignore */ }
        summary.failed += 1;
        recordMedia(db, {
          video_id: post.video_id,
          media_upload_id: post.media_upload_id,
          kind,
          status: ASYM_MEDIA_STATUS.ERROR,
          error: String(error && error.message ? error.message : error).slice(0, 300),
          attempts: 1,
        });
        console.error(`[asym-media] ${label} failed: ${error && error.message ? error.message : error}`);
      }

      if (options.pauseMs) await sleep(options.pauseMs);
      continue;
    }

    const partial = `${target}.part`;
    try {
      const signedUrl = await client.resolveVideoUrl(post.media_upload_id, { type: 'mp4', rendition });
      const { bytes } = await downloadTo(signedUrl, partial, {
        resume: true,
        onProgress: options.json ? null : (info) => console.log(progressLine(label, info)),
      });

      const probe = probeMedia(partial);
      // Resolution AND duration. A truncated video has a valid header and
      // the right resolution, so the resolution check alone would accept
      // a file that is missing its last ten minutes.
      const gate = checkVideo(probe, described.duration);

      if (!gate.ok) {
        fs.unlinkSync(partial);
        summary.failed += 1;
        recordMedia(db, {
          video_id: post.video_id,
          media_upload_id: post.media_upload_id,
          kind,
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
        kind,
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
        kind,
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
        kind,
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