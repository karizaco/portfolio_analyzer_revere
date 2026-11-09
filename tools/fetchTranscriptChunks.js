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

const argv = process.argv.slice(2);
function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

const channel = readFlag('--channel');
const idsFile = readFlag('--ids-file');
const chunk = Math.max(1, Number(readFlag('--chunk', '40')) || 40);
const pauseSeconds = Math.max(0, Number(readFlag('--pause', '45')) || 0);
const maxChunks = Math.max(1, Number(readFlag('--max-chunks', '1000')) || 1000);
const logPath = readFlag('--log');
const noCaptionsFile = readFlag('--no-captions-file', path.join(ROOT, 'data', 'catalog_flat', `${channel}_no_captions.txt`));

if (!channel || !idsFile) {
  console.error('Usage: node tools/fetchTranscriptChunks.js --channel NAME --ids-file FILE [--chunk 40] [--pause 45] [--log FILE]');
  process.exit(2);
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

function log(line) {
  console.log(line);
  if (logPath) fs.appendFileSync(logPath, `${line}\n`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const allIds = readIds(idsFile);
const noCaptions = new Set(readIds(noCaptionsFile));
const chunkFile = path.join(ROOT, 'data', 'catalog_flat', `.chunk_${channel}_${process.pid}.txt`);

const totals = { fetched: 0, noCaptions: 0, otherFailures: 0, chunks: 0 };
let stoppedForRateLimit = false;

for (let n = 1; n <= maxChunks; n += 1) {
  const pending = allIds.filter((id) => !hasTranscript(id) && !noCaptions.has(id));
  if (!pending.length) break;

  const batch = pending.slice(0, chunk);
  fs.writeFileSync(chunkFile, `${batch.join('\n')}\n`);

  const result = spawnSync(process.execPath, [
    FETCH_TOOL,
    '--channel', channel,
    '--ids-file', chunkFile,
    '--no-deepgram-fallback',
    '--rate-limit-attempts', '2',
    '--rate-limit-wait', '120',
  ], { cwd: ROOT, encoding: 'utf8' });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logPath) fs.appendFileSync(logPath, output);

  // The tool prints a header line per run, so the last block of the log is
  // THIS chunk. The earlier blocks are earlier chunks, and counting them
  // again would attribute their successes to a chunk that fetched nothing.
  const blocks = output.split(/\[sevcik-transcripts\] candidates=/);
  const block = blocks[blocks.length - 1];

  let fetched = 0;
  for (const line of block.split(/\r?\n/)) {
    const match = /^\[sevcik-transcripts\] (\S+) \S* (?:youtube_auto|deepgram|manual) \(/.exec(line);
    if (match) { fetched += 1; continue; }
    const failed = /^\[sevcik-transcripts\] (\S+) \S* FAILED: (.*)$/.exec(line);
    if (!failed) continue;
    if (/rate limited/i.test(failed[2])) continue; // retry later, never blacklist
    if (/no captions|captions were empty|no auto-captions/i.test(failed[2])) {
      noCaptions.add(failed[1]);
      fs.appendFileSync(noCaptionsFile, `${failed[1]}\n`);
      totals.noCaptions += 1;
    } else {
      totals.otherFailures += 1;
    }
  }
  totals.fetched += fetched;
  totals.chunks += 1;

  const remaining = allIds.filter((id) => !hasTranscript(id) && !noCaptions.has(id)).length;
  log(`[chunk ${n}] asked=${batch.length} fetched=${fetched} no_captions_total=${noCaptions.size} remaining=${remaining}`);

  if (/stopping: \d+ videos in a row were rate limited/.test(output)) {
    stoppedForRateLimit = true;
    log('[chunks] stopped: YouTube is rate limiting the subtitle endpoint. Wait 30-60 minutes, then re-run the same command.');
    break;
  }
  if (!remaining) break;
  if (fetched === 0) {
    log('[chunks] stopped: a whole chunk fetched nothing; inspect the log before re-running.');
    break;
  }
  if (pauseSeconds) sleep(pauseSeconds * 1000);
}

try { fs.unlinkSync(chunkFile); } catch (_) {}

const transcribed = allIds.filter(hasTranscript).length;
log(`[chunks] done: ids=${allIds.length} transcribed=${transcribed} no_captions=${allIds.filter((id) => noCaptions.has(id)).length}`
  + ` fetched_this_run=${totals.fetched} other_failures=${totals.otherFailures}${stoppedForRateLimit ? ' RATE-LIMITED' : ''}`);
process.exit(stoppedForRateLimit ? 3 : 0);
