'use strict';

// Run the Deepgram fetch over a list of ids, in small chunks.
//
// WHY A RUNNER RATHER THAN ONE BIG CALL
//
// The fetch tool processes its --ids-file sequentially, and a Deepgram
// transcript is a network round trip per video: the audio is downloaded, the
// MP3 is extracted, and the file is uploaded. Two hundred of those in one
// process is a long unobservable run, and one rate-limited video would take
// the rest of the list down with it.
//
// So the list is cut into chunks, each chunk is a separate invocation, and a
// chunk that fails is logged and skipped. The run is resumable: a video that
// already has a transcript on disk is never asked for again.
//
// The AUDIO is deleted after each transcript (the tool's default), because
// for this source the audio is a byproduct -- only the transcript is the
// corpus, and the media is never wanted afterwards.
//
// Usage:
//   node tools/fetchDeepgramBatch.js --channel t3live \
//     --ids-file data/catalog_flat/t3live_ids_deepgram_remaining.txt \
//     --chunk 8 --log data/t3live_fetch_log_deepgram_stream1.txt

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FETCH_TOOL = path.join(__dirname, 'fetchSevcikTranscripts.js');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

const argv = process.argv.slice(2);
function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

const channel = readFlag('--channel', 't3live');
const idsFile = readFlag('--ids-file');
const chunkSize = Math.max(1, Number(readFlag('--chunk', '8')) || 8);
const logFile = readFlag('--log', '');

if (!idsFile || !fs.existsSync(idsFile)) {
  console.error('usage: node tools/fetchDeepgramBatch.js --ids-file FILE [--channel NAME] [--chunk N] [--log FILE]');
  process.exit(2);
}

const allIds = fs.readFileSync(idsFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.split('\t')[0].trim())
  .filter(Boolean);

function hasTranscript(videoId) {
  return fs.existsSync(path.join(TRANSCRIPTS_DIR, `${videoId}.json`));
}

function log(line) {
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}

const chunkFile = path.join(ROOT, 'data', 'catalog_flat', `.deepgram_chunk_${process.pid}.txt`);
let done = 0;
let failed = 0;
let chunks = 0;

for (let offset = 0; offset < allIds.length; offset += chunkSize) {
  const ids = allIds.slice(offset, offset + chunkSize).filter((id) => !hasTranscript(id));
  if (!ids.length) continue;

  fs.writeFileSync(chunkFile, `${ids.join('\n')}\n`);
  chunks += 1;

  const result = spawnSync(process.execPath, [
    FETCH_TOOL,
    '--channel', channel,
    '--ids-file', chunkFile,
    '--rate-limit-attempts', '2',
    '--rate-limit-wait', '120',
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (logFile) fs.appendFileSync(logFile, output);

  // The tool prints one line per video. Count what actually landed on disk
  // rather than what the log claims: the disk is the record.
  let landed = 0;
  for (const id of ids) if (hasTranscript(id)) landed += 1;
  done += landed;
  failed += ids.length - landed;

  const remaining = allIds.filter((id) => !hasTranscript(id)).length;
  log(`[batch ${chunks}] chunk=${ids.length} landed=${landed} failed=${ids.length - landed} remaining=${remaining}`);

  // A chunk that got nothing is almost always a rate limit. Stop and let the
  // operator decide, rather than hammering a throttled endpoint.
  if (landed === 0 && ids.length > 0) {
    log('[batch] a whole chunk produced nothing -- stopping, the endpoint may be throttling');
    break;
  }
}

try { fs.unlinkSync(chunkFile); } catch (_) {}

log(`[batch] done: chunked=${chunks} transcribed=${done} failed=${failed} remaining=${allIds.filter((id) => !hasTranscript(id)).length}`);
process.exit(0);
