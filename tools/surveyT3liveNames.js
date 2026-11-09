'use strict';

// Survey the ENGLISH company names spoken in the T3Live transcripts.
//
// WHY THIS TOOL EXISTS
//
// The company-name matcher has two halves. `config/ticker_company_names.csv`
// is the SEC's own list, and it PROPOSES a ticker: a spoken name that matches
// more than one registrant is not a ticker, and a name that matches exactly
// one is still only a proposal. `config/ticker_names_confirmed.csv` is the
// record of what was actually HEARD said, and it is what turns a proposal
// into a published ticker.
//
// That table was built from the CZECH corpus, so it holds 47 rows, and the
// consequence for T3Live is severe: on a 25-video English sample only 12
// distinct names resolved, while 250 came back as candidates. A candidate is
// dropped, so the names the hosts actually talk about never reach a signal.
//
// Measured on the Options In Play sample (2026-11-09), the show produced
// almost no signals for exactly this reason -- the names were being found and
// then thrown away, not missed.
//
// So this tool reports the same thing the Czech survey reports: which names
// were spoken, which resolve, and which do not. The unresolved ones are the
// rows the confirmed table has to grow.
//
// WHAT IT REPORTS
//
//   * the RESOLVED names, with the ticker each one reached
//   * the CANDIDATE names -- resolved through the SEC list but unconfirmed,
//     with the ticker each one PROPOSES and how often it was said
//   * a frequency table, so the table is grown from what the corpus actually
//     says rather than from what someone assumed
//
// A candidate is only worth confirming when the corpus says it often AND the
// name is a company rather than an ordinary word. "Bank" and "Market" are
// both frequent and neither is a name on its own, so the report shows the
// context -- the sentences the word was said in -- for every candidate.
//
// Usage:
//   node tools/surveyT3liveNames.js
//   node tools/surveyT3liveNames.js --json
//   node tools/surveyT3liveNames.js --candidates-only
//   node tools/surveyT3liveNames.js --limit 20
//   node tools/surveyT3liveNames.js --write-candidates data/t3live_name_candidates.csv

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { matchCompanyName } = require('../src/sevcik/companyNames');
const { findEnglishCompanyNames, ENGLISH_STOP_WORDS } = require('../src/t3live/englishNames');
const { T3LIVE_CHANNEL } = require('../src/t3live/channel');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');

const argv = process.argv.slice(2);
const options = {
  json: argv.includes('--json'),
  candidatesOnly: argv.includes('--candidates-only'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  writeCandidates: readFlag(argv, '--write-candidates') || '',
};

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || '';
}

/**
 * The sentences a word was said in, so a candidate can be judged.
 *
 * @param {string} text
 * @param {string} word
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
  const videos = db.prepare(
    `SELECT v.video_id, v.upload_date, v.title FROM videos v
     JOIN video_transcripts t ON t.video_id = v.video_id
     WHERE v.channel = ? ORDER BY v.upload_date DESC`,
  ).all(T3LIVE_CHANNEL);
  db.close();

  const limit = options.limit ? videos.slice(0, options.limit) : videos;

  const resolved = new Map();
  const candidates = new Map();
  let files = 0;
  let filesWithNames = 0;

  for (const video of limit) {
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
      if (!resolved.has(key)) resolved.set(key, { ticker: key, spoken: new Set(), count: 0 });
      const entry = resolved.get(key);
      entry.spoken.add(name.spoken);
      entry.count += 1;
    }

    // The candidates are the names that reached a ticker through the SEC list
    // but that nothing has confirmed. The matcher reports the proposal on the
    // result, so each one is re-matched here to recover it.
    for (const name of names) {
      if (name.ticker) continue;
      const spoken = name.spoken;
      if (!spoken || ENGLISH_STOP_WORDS.has(spoken.toLowerCase())) continue;
      const result = matchCompanyName(spoken, { lexicon });
      if (!result.candidate) continue;
      const key = `${spoken}->${result.candidate}`;
      if (!candidates.has(key)) {
        candidates.set(key, { spoken, candidate: result.candidate, count: 0, contexts: [] });
      }
      const entry = candidates.get(key);
      entry.count += 1;
      if (entry.contexts.length < 2) {
        entry.contexts.push(...contextsFor(text, spoken, 2 - entry.contexts.length));
      }
    }
  }

  const resolvedRows = [...resolved.values()]
    .map((row) => ({ ...row, spoken: [...row.spoken].sort().join(' | ') }))
    .sort((a, b) => b.count - a.count);
  const candidateRows = [...candidates.values()].sort((a, b) => b.count - a.count);

  if (options.writeCandidates) {
    const lines = ['spoken,candidate,count,context'];
    for (const row of candidateRows) {
      const context = row.contexts.join(' // ').replace(/"/g, '""');
      lines.push(`"${row.spoken}","${row.candidate}",${row.count},"${context}"`);
    }
    fs.writeFileSync(options.writeCandidates, `${lines.join('\n')}\n`, 'utf8');
    console.log(`[t3live-names] wrote ${candidateRows.length} candidate row(s) to ${options.writeCandidates}`);
  }

  if (options.json) {
    console.log(JSON.stringify({
      videos: limit.length,
      files,
      files_with_resolved_names: filesWithNames,
      resolved: resolvedRows,
      candidates: candidateRows,
    }, null, 2));
    return;
  }

  console.log(`[t3live-names] videos=${limit.length} transcripts=${files} with a resolved name=${filesWithNames}`);
  console.log(`[t3live-names] RESOLVED (${resolvedRows.length} tickers):`);
  for (const row of resolvedRows) {
    console.log(`  ${String(row.count).padStart(4)}  ${row.ticker.padEnd(6)} ${row.spoken}`);
  }
  console.log(`[t3live-names] CANDIDATES (${candidateRows.length} spoken names with no confirmation):`);
  for (const row of candidateRows) {
    console.log(`  ${String(row.count).padStart(4)}  ${row.spoken} -> ${row.candidate}`);
    for (const context of row.contexts) console.log(`          "${context}"`);
  }
}

try {
  main();
} catch (error) {
  console.error(`[t3live-names] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
