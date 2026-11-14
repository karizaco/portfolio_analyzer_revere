#!/usr/bin/env node
/**
 * Re-verify a channel's caption-less blacklist against YouTube, and give
 * every entry the VERDICT that justified it.
 *
 * WHY THIS EXISTS. The blacklist is permanent: a video the list excludes
 * is never requested again, and a later Deepgram pass sends it to a PAID
 * API for audio YouTube would transcribe for free. A wrong entry is not
 * a delay -- it is a cost. So an entry must carry the verdict that
 * justified it, and the only verdict that may blacklist is YouTube's own
 * answer (`no captions`). A failed fetch or a rate limit must be retried,
 * never blacklisted.
 *
 * The T3Live list (107 entries) predates that rule and carries no reason
 * at all, so this tool asks YouTube again and writes the answer down.
 *
 * Usage:
 *   node tools/auditNoCaptions.js --channel t3live
 *   node tools/auditNoCaptions.js --channel benzinga --execute
 *   node tools/auditNoCaptions.js --channel t3live --limit 5   # a sample
 *
 * Dry-run by default. `--execute` rewrites the list. `--json` prints a
 * machine-readable summary.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classifyCaptionFetch, blacklistEntryFor } = require('../src/transcript/captionVerdicts');

const ROOT = path.resolve(__dirname, '..');
const TRANSCRIPTS = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

/** The ids on a list, with whatever reason each one already carries. */
function readList(listPath) {
  return fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
    .map((line) => {
      const [id, ...rest] = line.split('\t');
      return { id: id.trim(), reason: rest.join('\t').trim() };
    })
    .filter((row) => row.id);
}

/**
 * Classify a `--list-subs` answer.
 *
 * THE SHARED CLASSIFIER IS THE ONE THAT WROTE THE LIST. This tool
 * re-verifies the blacklist `tools/fetchSevcikTranscripts.js` writes, so
 * it must not carry a second opinion about what a verdict means -- an
 * audit that measures a different thing than the fetch wrote is an audit
 * that reports a clean list while the list is wrong.
 */
function classifyCaptionListing(stdout, stderr) {
  return classifyCaptionFetch(stdout, stderr);
}

/**
 * Ask YouTube whether the video has a caption track at all.
 *
 * `--list-subs` is a metadata request, not a download, so this is cheap.
 */
function listSubs(videoId) {
  const result = spawnSync('py', ['-3', '-m', 'yt_dlp', '--list-subs', '--skip-download',
    '--extractor-args', 'youtube:player_client=visios', '--js-runtimes', 'node',
    `https://www.youtube.com/watch?v=${videoId}`], {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  });
  return classifyCaptionListing(result.stdout || '', result.stderr || '');
}

/**
 * Decide which entries the blacklist keeps.
 *
 * THE SAFETY PROPERTY: a run that could not reach a video must not take
 * that video off the list. A rate limit or a failed fetch is not
 * evidence that the entry was wrong -- it is evidence that this run did
 * not get an answer -- and a video wrongly taken off the caption-less
 * list is not delayed but sent to a PAID transcription API for audio
 * YouTube would transcribe for free. So a throttled audit that emptied
 * the blacklist would cost money on every entry it emptied.
 *
 * @param {Array<{id: string, verdict: string, permanent: boolean, detail: string}>} audited
 * @param {Array<{id: string, reason: string}>} previous  the list as it stood
 * @returns {Map<string, string>} id -> the entry to keep
 */
function decideEntries(audited, previous) {
  const prior = new Map(previous.map((row) => [row.id, row.reason]));
  const keep = new Map();

  for (const row of audited) {
    // The entry carries the verdict that JUSTIFIED it.
    const entry = blacklistEntryFor({ verdict: row.verdict, permanent: row.permanent, detail: row.detail });
    if (entry) { keep.set(row.id, entry); continue; }

    // PROVEN WRONG: the track is there, so the entry was a lie. Off.
    if (row.verdict.startsWith('HAS CAPTIONS')) continue;

    // THIS RUN COULD NOT TELL. The old entry stands, marked with why
    // this run did not confirm it.
    const before = prior.get(row.id);
    if (before) keep.set(row.id, `${before} [not re-verified: ${row.verdict}]`);
  }

  // The entries this run did not reach keep their old text.
  const reached = new Set(audited.map((r) => r.id));
  for (const row of previous) {
    if (reached.has(row.id) || keep.has(row.id)) continue;
    if (row.reason) keep.set(row.id, row.reason);
  }
  return keep;
}

function main() {
  const argv = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const has = (name) => argv.includes(name);

  const channel = readFlag('--channel', '');
  const execute = has('--execute');
  const asJson = has('--json');
  const limit = Number(readFlag('--limit', '0')) || 0;

  if (!channel) {
    console.error('usage: node tools/auditNoCaptions.js --channel <name> [--execute] [--limit N] [--json]');
    process.exit(2);
  }

  const LIST = path.join(ROOT, 'data', 'catalog_flat', `${channel}_no_captions.txt`);
  if (!fs.existsSync(LIST)) {
    console.error(`no blacklist at ${path.relative(ROOT, LIST)}`);
    process.exit(2);
  }

  const rows = readList(LIST);
const sample = limit ? rows.slice(0, limit) : rows;
const transcriptFor = (id) => {
  const p = path.join(TRANSCRIPTS, `${id}.json`);
  if (!fs.existsSync(p)) return '(none)';
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')).provider || '(unknown)';
  } catch { return '(unreadable)'; }
};

console.log(`[no-captions] ${path.relative(ROOT, LIST)}: ${rows.length} entries, auditing ${sample.length}`);
console.log('');

const out = [];
const counts = { wrong: 0, permanent: 0, retryable: 0 };
for (const [i, row] of sample.entries()) {
  const { verdict, permanent, detail } = listSubs(row.id);
  const provider = transcriptFor(row.id);
  const kind = verdict.startsWith('HAS CAPTIONS') ? 'wrong' : (permanent ? 'permanent' : 'retryable');
  counts[kind] += 1;
  out.push({ id: row.id, verdict, permanent, detail, provider, hadReason: Boolean(row.reason) });
  if (!asJson) {
    console.log(`  [${String(i + 1).padStart(3)}/${sample.length}] ${row.id}  ${verdict}`);
    console.log(`        ${detail}`);
    console.log(`        transcript on disk: ${provider}${row.reason ? '' : '  (no reason recorded)'}`);
  }
  if (i % 20 === 19) console.log(`  ... ${i + 1} done`, );
}

const summary = {
  list: path.relative(ROOT, LIST),
  entries: rows.length,
  audited: sample.length,
  wronglyBlacklisted: counts.wrong,
  permanent: counts.permanent,
  retryable: counts.retryable,
  executed: execute,
};

if (asJson) {
  console.log(JSON.stringify({ summary, rows: out }, null, 2));
} else {
  console.log('');
  console.log('  ---');
  console.log(`  wrongly blacklisted: ${counts.wrong}   (these MUST come off the list)`);
  console.log(`  permanent (YouTube says none): ${counts.permanent}`);
  console.log(`  retryable (a failure, not an absence): ${counts.retryable}   (these must come off too)`);
  if (!execute) console.log('\n  dry run -- nothing was written. Use --execute to rewrite the list.');
}

if (execute) {
  const keep = decideEntries(out, rows);
  const text = [...keep.entries()].map(([id, reason]) => `${id}\t${reason}`).join('\n') + '\n';
  fs.writeFileSync(LIST, text);
  console.log(`\n  rewrote ${path.relative(ROOT, LIST)}: ${keep.size} entries, every one carrying its verdict`);
  }
}

module.exports = { classifyCaptionListing, decideEntries, readList };

if (require.main === module) main();
