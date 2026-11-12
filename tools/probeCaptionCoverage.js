'use strict';

// Which videos in a list have a caption track, and which do not.
//
// WHY THIS TOOL EXISTS
//
// The pipeline's caption-less list is a BLACKLIST: the chunk runner never
// asks for a video in it again, and a wrong entry sends a video with free
// captions to a PAID transcription API instead. So the verdict has to
// come from YouTube's own answer -- and the cheapest way to get that
// answer is `--list-subs`, which lists the tracks and downloads nothing.
//
// That is the whole point of this tool: it costs ONE request per video
// and NO bytes, so a large corpus can be surveyed before any download
// budget is spent. The full caption fetch is then run only over the
// subset worth fetching.
//
// WHAT IT REPORTS, PER VIDEO
//
//   the tracks YouTube says exist   (the languages and their kind)
//   whether an auto or manual track exists at all
//   the error, when YouTube refused the request -- which is NOT the same
//   as "the video has no captions", and must never be recorded as one
//
// Usage:
//   node tools/probeCaptionCoverage.js --ids-file data/catalog_flat/benzinga_ids.txt
//   node tools/probeCaptionCoverage.js --ids-file <file> --out data/catalog_flat/benzinga_no_captions.txt
//   node tools/probeCaptionCoverage.js --ids-file <file> --limit 20 --json

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function readFlag(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : (argv[index + 1] || fallback);
}

const idsFile = readFlag('--ids-file');
const limit = Number(readFlag('--limit', '0')) || 0;
const outPath = readFlag('--out');
const asJson = argv.includes('--json');

if (!idsFile || !fs.existsSync(idsFile)) {
  console.error('Usage: node tools/probeCaptionCoverage.js --ids-file FILE [--out FILE] [--limit N] [--json]');
  process.exit(2);
}

const ids = fs.readFileSync(idsFile, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.split('\t')[0].trim())
  .filter(Boolean);
const work = limit ? ids.slice(0, limit) : ids;

const py = process.platform === 'win32' ? 'py' : 'python3';

/**
 * The caption tracks YouTube says this video has.
 *
 * @param {string} videoId
 * @returns {{video_id: string, tracks: number, auto: number, manual: number,
 *            languages: string[], no_captions: boolean, refused: boolean, detail: string}}
 */
function probe(videoId) {
  const result = spawnSync(py, ['-3', '-m', 'yt_dlp',
    '--skip-download', '--list-subs', '--no-warnings',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=visios',
    `https://www.youtube.com/watch?v=${videoId}`,
  ], { encoding: 'utf8', timeout: 180000 });

  const both = `${result.stdout || ''}\n${result.stderr || ''}`;
  // The verdict has to come from what YouTube SAID. A failed request is
  // not a video with no captions, and the two must never be collapsed:
  // the first is a fact about the video, the second about the network.
  const refused = /rate[-\s]?limited|HTTP Error 429|Too Many Requests|Sign in to confirm|bot/i.test(both);
  const saysNone = /has no subtitles|there are no subtitles|no subtitles for the requested|aren't any subtitles/i.test(both);

  // Count the track rows: a row is "lang  language-name  formats...".
  const trackRows = (result.stdout || '').split(/\r?\n/)
    .filter((line) => /^[a-z]{2}(?:[-_][A-Za-z0-9]+)?\s{2,}/i.test(line));
  const languages = [...new Set(trackRows.map((line) => line.split(/\s{2,}/)[0].trim()))];

  const detail = both.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^warnings?\.warn/i.test(l))
    .slice(-1)[0] || '';

  return {
    video_id: videoId,
    tracks: trackRows.length,
    languages,
    no_captions: saysNone && trackRows.length === 0,
    refused,
    detail: refused ? detail.slice(0, 120) : '',
  };
}

const results = [];
for (let i = 0; i < work.length; i += 1) {
  const result = probe(work[i]);
  results.push(result);
  if (!asJson) {
    const verdict = result.refused ? 'REFUSED'
      : result.no_captions ? 'NO CAPTIONS'
      : `tracks=${result.tracks} ${result.languages.slice(0, 4).join(',')}`;
    console.log(`  ${String(i + 1).padStart(3)}/${work.length}  ${result.video_id}  ${verdict}`);
  }
}

const noCaptions = results.filter((r) => r.no_captions);
const refused = results.filter((r) => r.refused);
const withCaptions = results.filter((r) => !r.no_captions && !r.refused);

if (outPath && noCaptions.length) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath),
    `${noCaptions.map((r) => `${r.video_id}\tno captions (verified by --list-subs)`).join('\n')}\n`,
    'utf8');
}

const summary = {
  probed: results.length,
  with_captions: withCaptions.length,
  no_captions: noCaptions.length,
  refused: refused.length,
  refused_ids: refused.map((r) => r.video_id),
  no_caption_ids: noCaptions.map((r) => r.video_id),
  out: outPath || '',
};
if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log(`\n[probe] ${JSON.stringify(summary, null, 2)}`);
}
process.exit(refused.length ? 3 : 0);
