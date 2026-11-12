'use strict';

// Does a re-fetch of the SAME video produce the SAME caption track?
//
// The claim under test: YouTube regenerates its auto-captions, so a
// re-fetch is not a copy of the track the stored transcript was built
// from.
//
// THE CONTROL: the same video, the same command, the same client, minutes
// apart. Anything that differs is the caption track changing, not the
// tool.
//
// WHAT IS COMPARED
//
//   the VTT        the raw track, byte for byte
//   the JSON       the normalised segments, and the checksum over their
//                  text -- so a change in the WORDING is separable from a
//                  change in the timings
//
// Usage:
//   node tools/measureCaptionStability.js --video-id <id> --channel benzinga
//   node tools/measureCaptionStability.js --video-id <id> --rounds 3 --gap-minutes 4
//   node tools/measureCaptionStability.js --compare-stored --channel t3live --ids-file <file>
//
// THE SECOND MODE answers a different question: has the caption track
// changed SINCE the stored transcript was written? It re-fetches the track
// into a scratch directory and compares its normalised text with the
// stored JSON's -- so the stored corpus is never touched. Measured
// 2026-11-12 on T3Live, whose transcripts were fetched over four days: the
// same video's track had changed between the campaign's fetch and mine,
// which is how the "YouTube regenerates" question got asked in the first
// place.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const FETCH = path.join(ROOT, 'tools', 'fetchSevcikTranscripts.js');

const argv = process.argv.slice(2);
function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

const videoId = readFlag('--video-id');
const channel = readFlag('--channel', 'benzinga');
const rounds = Number(readFlag('--rounds', '2')) || 2;
const gapMinutes = Number(readFlag('--gap-minutes', '3')) || 3;

if (!videoId && !readFlag('--compare-stored')) {
  console.error('Usage: node tools/measureCaptionStability.js --video-id <id> [--channel NAME] [--rounds N] [--gap-minutes N]');
  console.error('   or: node tools/measureCaptionStability.js --compare-stored [--video-id <id> | --ids-file <file>] [--channel NAME]');
  process.exit(2);
}

/**
 * The two VTT names a fetch can write: the plain one, and the
 * channel-suffixed one.
 */
function vttPaths() {
  const plain = path.join(TRANSCRIPTS_DIR, `${videoId}.captions.en.vtt`);
  const suffixed = path.join(TRANSCRIPTS_DIR, `${videoId}.captions.benzinga.en.vtt`);
  return [plain, suffixed].filter((p) => fs.existsSync(p));
}

function digest(file) {
  if (!file || !fs.existsSync(file)) return null;
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/**
 * The normalised text of the stored transcript -- the thing the pipeline
 * actually reads.
 */
function jsonFacts() {
  const file = path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
  if (!fs.existsSync(file)) return null;
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const text = (body.segments || []).map((s) => s.text).join('\n');
  return {
    segment_count: body.segment_count,
    checksum: body.checksum,
    text_md5: crypto.createHash('md5').update(text).digest('hex'),
    text_chars: text.length,
  };
}

function fetchOnce(label) {
  const result = spawnSync(process.execPath, [
    FETCH,
    '--channel', channel,
    '--video-id', videoId,
    '--force',
    '--no-deepgram-fallback',
    '--rate-limit-attempts', '1',
    '--rate-limit-wait', '5',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const line = (result.stdout || '').split('\n').filter((l) => l.includes(videoId))[0] || '';
  const vtts = vttPaths();
  return {
    label,
    when: new Date().toISOString(),
    fetch_line: line.trim(),
    vtt: vtts.map((p) => ({ name: path.basename(p), md5: digest(p), bytes: fs.statSync(p).size })),
    json: jsonFacts(),
  };
}

// The rounds loop needs a SINGLE video. An empty `--video-id` reaches the
// fetch tool as "no filter", and with `--force` that re-fetches the WHOLE
// channel -- overwriting every stored transcript it touches. Measured
// 2026-11-12: that is how 107 tracked transcripts were rewritten by a run
// that was meant to measure one video.
if (videoId) {
const rounds_ = [];
for (let i = 1; i <= rounds; i += 1) {
  if (i > 1) {
    const wait = gapMinutes * 60 * 1000;
    console.log(`[stability] waiting ${gapMinutes} minutes between fetches...`);
    // Busy-wait in chunks so the process stays responsive to Ctrl-C.
    const until = Date.now() + wait;
    while (Date.now() < until) {
      spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)']);
    }
  }
  const facts = fetchOnce(`round ${i}`);
  rounds_.push(facts);
  console.log(`[stability] round ${i}: ${JSON.stringify(facts.vtt.map((v) => v.md5))}`
    + ` json checksum ${facts.json ? facts.json.checksum : 'none'}`);
}

const first = rounds_[0];
const sameVtt = rounds_.every((r) => JSON.stringify(r.vtt.map((v) => v.md5)) === JSON.stringify(first.vtt.map((v) => v.md5)));
const sameText = rounds_.every((r) => r.json && first.json && r.json.text_md5 === first.json.text_md5);
const sameCount = rounds_.every((r) => r.json && first.json && r.json.segment_count === first.json.segment_count);

console.log('\n=== caption stability ===');
for (const r of rounds_) {
  console.log(`  ${r.when}  vtt=${r.vtt.map((v) => v.md5 || '-').join(',')}`
    + `  segments=${r.json ? r.json.segment_count : '-'}`
    + `  text_md5=${r.json ? r.json.text_md5 : '-'}`);
}
console.log(`  the raw VTT is IDENTICAL across the fetches: ${sameVtt}`);
console.log(`  the segment COUNT is identical:                  ${sameCount}`);
console.log(`  the normalised TEXT is identical:               ${sameText}`);
console.log(`\n  ${sameText
  ? 'The wording did not change. Only the timing or the segmentation did.'
  : 'THE WORDING CHANGED between fetches of the same video.'}`);
}

// ─── MODE 2: has the stored transcript's track changed since it was written? ──

/**
 * Compare a stored transcript with a fresh download of the same caption
 * track, WITHOUT touching the stored corpus.
 *
 * The fresh track is written to a scratch directory, normalised with the
 * same pipeline rules, and compared with the stored JSON's text.
 *
 * @param {string} videoId
 * @param {string} channel
 * @param {string} scratch
 */
function compareStored(videoId, channel, scratch) {
  const { normalizeVtt, normalizeTranscript } = require(path.join(ROOT, 'src', 'transcript', 'transcriptNormalize.js'));
  const storedPath = path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
  if (!fs.existsSync(storedPath)) return { videoId, status: 'no stored transcript' };
  const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));

  fs.mkdirSync(scratch, { recursive: true });
  const py = process.platform === 'win32' ? 'py' : 'python3';
  const out = path.join(scratch, `${videoId}.captions`);
  const run = spawnSync(py, ['-3', '-m', 'yt_dlp',
    '--write-auto-subs', '--write-subs', '--skip-download',
    '--sub-lang', 'en', '--convert-subs', 'vtt',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visios',
    '--no-warnings',
    '-o', `${out}.%(ext)s`,
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { encoding: 'utf8', timeout: 300000 });

  const vttPath = `${out}.en.vtt`;
  if (!fs.existsSync(vttPath)) {
    return {
      videoId,
      status: 'no caption track now',
      stored_fetched_at: stored.fetched_at,
      detail: String(run.stderr || '').split('\n').slice(-2).join(' '),
    };
  }

  const fresh = normalizeTranscript({ segments: normalizeVtt(fs.readFileSync(vttPath, 'utf8')).map((s) => ({
    start_ts: s.start_sec, end_ts: s.end_sec, text: s.text,
  })) }, 'youtube_auto');

  const storedText = (stored.segments || []).map((s) => s.text).join('\n');
  const freshText = fresh.map((s) => s.text).join('\n');
  const md5 = (t) => crypto.createHash('md5').update(t).digest('hex');

  return {
    videoId,
    stored_fetched_at: stored.fetched_at,
    stored_segments: (stored.segments || []).length,
    fresh_segments: fresh.length,
    same_text: md5(storedText) === md5(freshText),
    stored_text_md5: md5(storedText),
    fresh_text_md5: md5(freshText),
  };
}

if (readFlag('--compare-stored')) {
  const idsFile = readFlag('--ids-file');
  const ids = idsFile
    ? fs.readFileSync(idsFile, 'utf8').split(/\r?\n/).map((l) => l.split('\t')[0].trim()).filter(Boolean)
    : [videoId];
  const scratch = path.join(os.tmpdir(), 'caption_stability_scratch');
  console.log(`[stability] comparing ${ids.length} stored transcript(s) with a fresh fetch, into ${scratch}`);
  for (const id of ids) {
    const result = compareStored(id, channel, scratch);
    console.log(`  ${JSON.stringify(result)}`);
  }
}
