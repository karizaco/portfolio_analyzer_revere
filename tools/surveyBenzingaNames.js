'use strict';

// Survey the ENGLISH company names spoken in the Benzinga transcripts.
//
// WHY THIS TOOL EXISTS
//
// Benzinga's hosts say company NAMES -- "Palantir", "CoreWeave",
// "SpaceX" -- and the confirmed-names table is what turns a spoken name
// into a ticker. A name that is only a CANDIDATE is resolved through the
// SEC list and then DROPPED, so a name that is not confirmed is a name
// that never reaches a signal.
//
// That is exactly what happened to T3Live: the table had been grown from
// the CZECH corpus, so across 811 English transcripts only 19 tickers came
// back and 1,357 spoken names were found and thrown away.
//
// The older PreMarket Prep era (2014-2020) reads even more sparsely: one
// pilot episode had ZERO ticker segments, because those hosts name
// companies in words rather than symbols. So the names table is the GATE
// on that era, and this tool is what grows it.
//
// WHAT IT REPORTS
//
//   * the RESOLVED names, with the ticker each one reached
//   * the CANDIDATE names -- resolved through the SEC list but unconfirmed,
//     with the ticker each one PROPOSES and how often it was said
//   * the SENTENCES each candidate was said in, because a candidate is
//     only worth confirming once a human has read it in context
//
// A candidate is only worth confirming when the corpus says it often AND
// the word is a company rather than an ordinary word. "Bank" and "Market"
// are both frequent and neither is a name on its own -- which is why the
// sentences are reported.
//
// Usage:
//   node tools/surveyBenzingaNames.js
//   node tools/surveyBenzingaNames.js --json
//   node tools/surveyBenzingaNames.js --candidates-only
//   node tools/surveyBenzingaNames.js --limit 20
//   node tools/surveyBenzingaNames.js --write-candidates data/benzinga_name_candidates.csv

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { findEnglishCompanyNames } = require('../src/t3live/englishNames');
const { BENZINGA_CHANNEL } = require('../src/benzinga/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

const argv = process.argv.slice(2);
const options = {
  json: argv.includes('--json'),
  candidatesOnly: argv.includes('--candidates-only'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  writeCandidates: readFlag(argv, '--write-candidates') || '',
  // Only the era, when the era is what is being surveyed.
  fromDate: readFlag(argv, '--from') || '',
  toDate: readFlag(argv, '--to') || '',
};

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || '';
}

/**
 * The sentences a word was said in, so a candidate can be judged.
 *
 * @param {string} text
 * @param {string} word
 * @param {number} [limit]
 * @returns {string[]}
 */
function contextsFor(text, word, limit = 2) {
  const out = [];
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  let match;
  while ((match = pattern.exec(text)) !== null && out.length < limit) {
    const start = Math.max(0, match.index - 90);
    const end = Math.min(text.length, match.index + 90);
    out.push(text.slice(start, end).replace(/\s+/g, ' ').trim());
  }
  return out;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const lexicon = loadSevcikLexicon();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let videos = db.prepare(
    `SELECT v.video_id, v.upload_date, v.title FROM videos v
     JOIN video_transcripts t ON t.video_id = v.video_id
     WHERE v.channel = ? ORDER BY v.upload_date DESC`,
  ).all(BENZINGA_CHANNEL);
  db.close();

  if (options.fromDate) videos = videos.filter((v) => v.upload_date >= options.fromDate);
  if (options.toDate) videos = videos.filter((v) => v.upload_date && v.upload_date <= options.toDate);
  if (options.limit) videos = videos.slice(0, options.limit);

  const resolved = new Map();
  const candidates = new Map();
  let files = 0;
  let filesWithNames = 0;

  for (const video of videos) {
    const filePath = path.join(TRANSCRIPTS_DIR, `${video.video_id}.json`);
    if (!fs.existsSync(filePath)) continue;
    files += 1;
    let body;
    try {
      body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const segments = body.segments || [];
    const text = segments.map((segment) => segment.text || '').join(' ');
    if (!text.trim()) continue;

    const names = findEnglishCompanyNames(text, { lexicon });
    const withTicker = names.filter((name) => name.ticker);
    if (withTicker.length) filesWithNames += 1;

    for (const name of withTicker) {
      const key = name.ticker;
      if (!resolved.has(key)) resolved.set(key, { ticker: key, spoken: new Set(), count: 0, videos: new Set() });
      const entry = resolved.get(key);
      entry.spoken.add(name.spoken);
      entry.count += 1;
      entry.videos.add(video.video_id);
    }

    // The CANDIDATES: spoken, resolvable through the SEC list, and not
    // confirmed. These are the rows the confirmed table has to grow.
    for (const name of names) {
      if (name.ticker) continue;
      const key = name.spoken.toLowerCase();
      if (!candidates.has(key)) {
        candidates.set(key, {
          spoken: name.spoken,
          candidate: name.candidate || '',
          count: 0,
          videos: new Set(),
          contexts: [],
        });
      }
      const entry = candidates.get(key);
      entry.count += 1;
      entry.videos.add(video.video_id);
      if (entry.contexts.length < 3) {
        entry.contexts.push(...contextsFor(text, name.spoken, 1).slice(0, 3 - entry.contexts.length));
      }
    }
  }

  const resolvedRows = [...resolved.values()]
    .map((entry) => ({
      ticker: entry.ticker,
      spoken: [...entry.spoken].join(' | '),
      count: entry.count,
      videos: entry.videos.size,
    }))
    .sort((a, b) => b.count - a.count);

  const candidateRows = [...candidates.values()]
    .map((entry) => ({
      spoken: entry.spoken,
      candidate: entry.candidate,
      count: entry.count,
      videos: entry.videos.size,
      contexts: entry.contexts.join(' || '),
    }))
    .sort((a, b) => b.count - a.count);

  if (options.writeCandidates) {
    const outPath = path.resolve(options.writeCandidates);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const header = 'spoken,candidate,count,videos,contexts\n';
    const body = candidateRows.map((row) => [
      row.spoken, row.candidate, row.count, row.videos, `"${String(row.contexts).replace(/"/g, '""')}"`,
    ].join(',')).join('\n');
    fs.writeFileSync(outPath, `${header}${body}\n`, 'utf8');
    console.error(`[benzinga-names] wrote ${candidateRows.length} candidate(s) to ${options.writeCandidates}`);
  }

  const payload = {
    transcripts_read: files,
    transcripts_with_a_name: filesWithNames,
    resolved_count: resolvedRows.length,
    candidate_count: candidateRows.length,
    resolved: resolvedRows,
    candidates: candidateRows,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[benzinga-names] transcripts=${files} with a resolved name=${filesWithNames}`
    + ` distinct tickers=${resolvedRows.length} distinct candidates=${candidateRows.length}`);
  if (!options.candidatesOnly) {
    console.log('\n--- resolved (a confirmed name reached a ticker) ---');
    for (const row of resolvedRows.slice(0, 30)) {
      console.log(`  ${String(row.count).padStart(4)}x  ${row.ticker.padEnd(6)} spoken as "${row.spoken}"`);
    }
  }
  console.log('\n--- candidates (spoken, resolvable, NOT confirmed -- the rows the table has to grow) ---');
  for (const row of candidateRows.slice(0, 40)) {
    console.log(`  ${String(row.count).padStart(4)}x  "${row.spoken}" -> ${row.candidate || '(no candidate)'}`);
    for (const context of String(row.contexts).split(' || ').filter(Boolean).slice(0, 1)) {
      console.log(`         ${context.slice(0, 150)}`);
    }
  }
}

main();
