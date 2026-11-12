'use strict';

// Fetch transcripts for a list of video ids, in small serial chunks.
//
// WHY THIS EXISTS
//
// A thousand caption fetches in one invocation is one long, unobservable
// process, and a video with no caption track stays a candidate forever: the
// fetch tool picks candidates by "no transcript file on disk", so a plain
// retry loop re-requests the same caption-less videos at the head of every
// chunk. This runner:
//
//   * runs ONE fetch process at a time, `--chunk` videos per run, with a
//     pause between runs (light on CPU, light on YouTube);
//   * remembers the videos that came back with no captions and does not ask
//     for them again (they are written to `--no-captions-file`, so a later
//     decision -- Deepgram or not -- has the list);
//   * remembers the videos the content filter quarantined, for the same
//     reason: they will never be fetched, so asking again is pointless;
//   * stops the whole run as soon as the fetch tool reports a rate limit,
//     because the project rule is 30-60 minutes of quiet after a 429.
//
// Deepgram is never used here: the fetch is captions-only.
//
// Usage:
//   node tools/fetchTranscriptChunks.js --channel t3live \
//     --ids-file data/catalog_flat/t3live_ids_actionable_swings.txt \
//     --chunk 40 --pause 45 --log data/t3live_fetch_log_swings.txt

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const FETCH_TOOL = path.join(__dirname, 'fetchSevcikTranscripts.js');

/**
 * Read what ONE chunk's output says.
 *
 * The fetch tool prints a header line per run, so the last block of the log
 * is THIS chunk. The earlier blocks are earlier chunks, and counting them
 * again would attribute their successes to a chunk that fetched nothing.
 *
 * The four outcomes are kept apart, because they mean different things:
 *
 *   fetched      -- the video has a transcript now;
 *   noCaptions   -- the video has no caption track, so a caption-only run
 *                   will never get it (a later Deepgram pass may);
 *   quarantined  -- the video is non-market content and will NEVER be
 *                   fetched, so it must leave the pending set;
 *   otherFailure -- something went wrong, and the video is worth retrying.
 *
 * A rate-limited video belongs to none of them: it is retried later, and it
 * is never blacklisted.
 *
 * THE QUARANTINE CASE IS WHY THIS IS A FUNCTION AND NOT A LOOP BODY. A chunk
 * of ids that are ALL quarantined leaves the fetch tool with no candidates,
 * so it fetches nothing -- which a naive runner reads as "the endpoint is
 * throttling" and reports as a possible 429. It happened on 2026-11-10: the
 * run stopped on a throttle that was not there, and the remaining 11 videos
 * were educational "how to" titles the content filter had already excluded.
 *
 * @param {string} output the fetch tool's stdout+stderr
 * @returns {{ fetched: string[], noCaptions: string[], quarantined: string[], otherFailures: string[], rateLimited: boolean }}
 */
function parseChunkOutput(output) {
  const text = String(output || '');
  const HEADER = '[sevcik-transcripts] candidates=';
  const headerIndex = text.lastIndexOf(HEADER);

  // The fetch tool prints its quarantine summary BEFORE the run header, and
  // its per-video lines AFTER it. So the last run's PREAMBLE carries the
  // quarantine line and its BODY carries the fetches -- and the preamble is
  // the text between the previous run's header and this one's.
  const previousHeader = headerIndex === -1 ? -1 : text.lastIndexOf(HEADER, headerIndex - 1);
  const preamble = headerIndex === -1 ? text : text.slice(previousHeader + 1, headerIndex);
  const body = headerIndex === -1 ? '' : text.slice(headerIndex);

  const fetched = [];
  const noCaptions = [];
  const noCaptionsByReason = {};
  const quarantined = [];
  const otherFailures = [];
  let rateLimited = false;

  for (const line of preamble.split(/\r?\n/)) {
    const dropped = /^\[sevcik-transcripts\] quarantined_non_market=\d+ ids=(.*)$/.exec(line);
    if (!dropped) continue;
    for (const id of dropped[1].split(',').map((s) => s.trim()).filter(Boolean)) quarantined.push(id);
  }

  for (const line of body.split(/\r?\n/)) {
    const match = /^\[sevcik-transcripts\] (\S+) \S* (?:youtube_auto|deepgram|manual) \(/.exec(line);
    if (match) { fetched.push(match[1]); continue; }
    const dropped = /^\[sevcik-transcripts\] quarantined_non_market=\d+ ids=(.*)$/.exec(line);
    if (dropped) {
      for (const id of dropped[1].split(',').map((s) => s.trim()).filter(Boolean)) quarantined.push(id);
      continue;
    }
    const failed = /^\[sevcik-transcripts\] (\S+) \S* FAILED: (.*)$/.exec(line);
    if (!failed) continue;
    // The HYPHEN matters: yt-dlp says "rate-limited", and a pattern for
    // "rate limited" does not match it. A throttled endpoint then reads as
    // a plain failure, and the runner keeps hammering it.
    if (/rate[-\s]?limited|HTTP Error 429|Too Many Requests/i.test(failed[2])) { rateLimited = true; continue; }
    // A FAILED FETCH is never blacklisted. It says the request did not
    // succeed, not that the video has no captions -- and the list is a
    // blacklist, so a wrong entry is permanent. The check comes first
    // because the failure's detail text can contain the phrase "no
    // captions" itself.
    if (/caption fetch failed/i.test(failed[2])) { otherFailures.push(failed[1]); continue; }
    if (/no captions|captions were empty|no auto-captions/i.test(failed[2])) {
      noCaptions.push(failed[1]);
      noCaptionsByReason[failed[1]] = failed[2].replace(/^\s*\S+\s+/, '');
      continue;
    }
    otherFailures.push(failed[1]);
  }

  return { fetched, noCaptions, noCaptionsByReason, quarantined, otherFailures, rateLimited };
}

function readFlag(argv, flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

function readIds(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((line) => line.split('\t')[0].trim())
    .filter(Boolean);
}

function hasTranscript(videoId) {
  return fs.existsSync(path.join(TRANSCRIPTS_DIR, `${videoId}.json`));
}

function main() {
  const argv = process.argv.slice(2);
  const channel = readFlag(argv, '--channel');
  const idsFile = readFlag(argv, '--ids-file');
  const chunk = Math.max(1, Number(readFlag(argv, '--chunk', '40')) || 40);
  const pauseSeconds = Math.max(0, Number(readFlag(argv, '--pause', '45')) || 0);
  const maxChunks = Math.max(1, Number(readFlag(argv, '--max-chunks', '1000')) || 1000);
  // The retry budget for a throttled endpoint. It is a FLAG because a
  // hard throttle and a transient one need different budgets: retrying a
  // 429 after two minutes just burns the run, and on 2026-11-11 it cost
  // 76 videos at over two minutes each. The fetch tool stops by itself
  // after three consecutive rate-limited videos, so a low attempt count
  // means "notice, wait a while, come back" rather than "spin here".
  const rateLimitAttempts = Math.max(1, Number(readFlag(argv, '--rate-limit-attempts', '2')) || 2);
  const rateLimitWait = Math.max(0, Number(readFlag(argv, '--rate-limit-wait', '120')) || 0);
  const logPath = readFlag(argv, '--log');
  const noCaptionsFile = readFlag(argv, '--no-captions-file',
    path.join(ROOT, 'data', 'catalog_flat', `${channel}_no_captions.txt`));

  if (!channel || !idsFile) {
    console.error('Usage: node tools/fetchTranscriptChunks.js --channel NAME --ids-file FILE [--chunk 40] [--pause 45] [--log FILE]');
    process.exit(2);
  }

  const log = (line) => {
    console.log(line);
    if (logPath) fs.appendFileSync(logPath, `${line}\n`);
  };

  const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  const allIds = readIds(idsFile);
  const noCaptions = new Set(readIds(noCaptionsFile));
  const quarantinedIds = new Set();
  const chunkFile = path.join(ROOT, 'data', 'catalog_flat', `.chunk_${channel}_${process.pid}.txt`);

  const totals = { fetched: 0, noCaptions: 0, otherFailures: 0, chunks: 0, quarantined: 0 };
  let stoppedForRateLimit = false;

  for (let n = 1; n <= maxChunks; n += 1) {
    const pending = allIds.filter((id) => !hasTranscript(id) && !noCaptions.has(id) && !quarantinedIds.has(id));
    if (!pending.length) break;

    const batch = pending.slice(0, chunk);
    fs.writeFileSync(chunkFile, `${batch.join('\n')}\n`);

    const result = spawnSync(process.execPath, [
      FETCH_TOOL,
      '--channel', channel,
      '--ids-file', chunkFile,
      '--no-deepgram-fallback',
      '--rate-limit-attempts', String(rateLimitAttempts),
      '--rate-limit-wait', String(rateLimitWait),
    ], { cwd: ROOT, encoding: 'utf8' });

    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (logPath) fs.appendFileSync(logPath, output);

    const parsed = parseChunkOutput(output);
    // A BLACKLIST ENTRY IS PERMANENT, and that is the risk. The runner
    // never asks for a video in the no-captions file again, so one wrong
    // verdict writes a video with FREE captions out of the corpus -- and a
    // later pass sends it to a PAID transcription API instead.
    //
    // So the file is written ONCE per video, and it is written with the
    // verdict that justified it. A reader can then tell a video YouTube
    // said has no captions from one a run merely failed to fetch, and a
    // re-check has something to re-check.
    const verdict = parsed.noCaptionsByReason;
    for (const id of parsed.noCaptions) {
      noCaptions.add(id);
      fs.appendFileSync(noCaptionsFile, `${id}\t${verdict[id] || 'no captions'}\n`);
    }
    for (const id of parsed.quarantined) quarantinedIds.add(id);
    totals.fetched += parsed.fetched.length;
    totals.noCaptions += parsed.noCaptions.length;
    totals.otherFailures += parsed.otherFailures.length;
    totals.quarantined += parsed.quarantined.length;
    totals.chunks += 1;

    const remaining = allIds.filter((id) => !hasTranscript(id) && !noCaptions.has(id) && !quarantinedIds.has(id)).length;
    log(`[chunk ${n}] asked=${batch.length} fetched=${parsed.fetched.length} quarantined=${parsed.quarantined.length}`
      + ` no_captions_total=${noCaptions.size} remaining=${remaining}`);

    if (/stopping: \d+ videos in a row were rate limited/.test(output)) {
      stoppedForRateLimit = true;
      log('[chunks] stopped: YouTube is rate limiting the subtitle endpoint. Wait 30-60 minutes, then re-run the same command.');
      break;
    }
    if (!remaining) break;
    // A chunk that fetched nothing is only a throttle if the fetch tool
    // actually had candidates to work with. A chunk of quarantined videos
    // leaves it with none, and that is the run finishing, not a failure.
    if (parsed.fetched.length === 0 && parsed.quarantined.length === 0) {
      log('[chunks] stopped: a whole chunk fetched nothing; inspect the log before re-running.');
      break;
    }
    if (pauseSeconds) sleep(pauseSeconds * 1000);
  }

  try { fs.unlinkSync(chunkFile); } catch (_) {}

  const transcribed = allIds.filter(hasTranscript).length;
  log(`[chunks] done: ids=${allIds.length} transcribed=${transcribed} no_captions=${allIds.filter((id) => noCaptions.has(id)).length}`
    + ` quarantined=${totals.quarantined} fetched_this_run=${totals.fetched}`
    + ` other_failures=${totals.otherFailures}${stoppedForRateLimit ? ' RATE-LIMITED' : ''}`);
  process.exit(stoppedForRateLimit ? 3 : 0);
}

module.exports = { parseChunkOutput };

if (require.main === module) main();
