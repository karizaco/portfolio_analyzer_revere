'use strict';

// Audit the CONFIRMED spoken-names table against the SEC list.
//
// WHY THIS TOOL EXISTS
//
// The confirmed table (`config/ticker_names_confirmed.csv`) overrides what
// a spoken name resolves to. That override is a CLAIM: "when the host says
// X, the ticker is Y". When the claim is wrong, every mention of X publishes
// a wrong holding -- and a wrong holding in a portfolio report is worse
// than a missing one.
//
// The Benzinga corpus exposed three of them (2026-11-12):
//
//   "goldman sachs" -> GJS  = STRATS(SM) TRUST FOR GOLDMAN SACHS GROUP
//                               SECURITIES, SERIES 2006-2
//                        (the right one is GS, GOLDMAN SACHS GROUP INC)
//   "iron"           -> IRHO = IRON HORSE ACQUISITION II CORP.
//                               (a blank-check company, not the ore miner)
//   "maria" / "mario" -> MARA = MARA HOLDINGS, INC.
//                               (a bitcoin miner; "Maria" is a person's name)
//
// The two failures have the same SHAPE, and the shape is what this tool
// looks for:
//
//   1. THE TICKER'S REGISTRANT IS NOT THE SPOKEN COMPANY. The registrant
//      for GJS is a trust whose name merely CONTAINS "goldman sachs"; the
//      registrant for IRHO is a company that has nothing to do with iron ore.
//   2. THE REGISTRANT IS A STRUCTURED PRODUCT -- a trust, a series, ABS,
//      a preferred share, a physical-commodity trust, a BDC, a fund. No
//      trading show means any of those when it says the company's name.
//
// The check is a HEURISTIC and it reports, it does not decide: a row it
// flags is a row to read before changing. The tool prints the SEC list's
// own candidates for the spoken name, so the correct ticker is visible.
//
// Usage:
//   node tools/auditConfirmedNames.js
//   node tools/auditConfirmedNames.js --json

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIRMED = path.join(ROOT, 'config', 'ticker_names_confirmed.csv');
const SEC_LIST = path.join(ROOT, 'config', 'ticker_company_names.csv');

/**
 * The registrant words that mean "this is a structured product or a shell,
 * not the company anyone means when they say its name".
 *
 * These are matched on WORD BOUNDARIES. A substring match is wrong:
 * "netflix inc" contains "etf" ("n-ET-F-lix"), and flagging it would be
 * noise the reader has to learn to ignore.
 */
const STRUCTURED_MARKERS = [
  'trust', 'series', 'abs', 'backed', 'physical', 'bdc', 'fund', 'etf',
  'preferred', 'notes', 'debenture', 'structured', 'group securities',
  'certificate', 'depositary', 'acquisition',
];

/**
 * The words a company name is made of, minus the ones that carry no
 * identity ("the", "and", "of", "inc", "corp", "holdings", "group").
 */
const STOP_WORDS = new Set([
  'the', 'and', 'of', 'inc', 'corp', 'corporation', 'company', 'co', 'ltd',
  'plc', 'holdings', 'holding', 'group', 'sa', 'nv', 'ag', 'se', 'as', 'lp',
  'class', 'common', 'stock', 'shares', 'resources', 'energy', 'partners',
]);

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function identityWords(value) {
  return normalise(value)
    .split(' ')
    .filter((word) => word && !STOP_WORDS.has(word) && word.length > 2);
}

/**
 * The SEC list, by ticker.
 */
function loadSecList() {
  const byTicker = new Map();
  const byAlias = new Map();
  const lines = fs.readFileSync(SEC_LIST, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const match = /^([^,]+),("(?:[^"]*)"|[^,]*),(.*)$/.exec(line);
    if (!match) continue;
    const ticker = match[1].trim();
    const registrant = match[2].replace(/^"|"$/g, '').trim();
    const alias = match[3].trim();
    byTicker.set(ticker, { ticker, registrant, alias });
    if (alias) {
      const key = normalise(alias);
      if (!byAlias.has(key)) byAlias.set(key, []);
      byAlias.get(key).push({ ticker, registrant });
    }
  }
  return { byTicker, byAlias };
}

/**
 * The confirmed table's rows.
 */
function loadConfirmed() {
  const rows = [];
  const lines = fs.readFileSync(CONFIRMED, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    rows.push({
      spoken: parts[0].trim(),
      ticker: parts[1].trim().toUpperCase(),
      count: Number(parts[2]) || 0,
      note: parts.slice(3).join(',').replace(/^"|"$/g, '').trim(),
    });
  }
  return rows;
}

function main() {
  const { byTicker, byAlias } = loadSecList();
  const rows = loadConfirmed();
  const flagged = [];
  const missing = [];

  for (const row of rows) {
    const entry = byTicker.get(row.ticker);
    if (!entry) {
      missing.push(row);
      continue;
    }
    const registrant = normalise(entry.registrant);
    const spokenWords = identityWords(row.spoken);
    const registrantWords = new Set(identityWords(entry.registrant));

    // 1. Does the registrant carry the spoken company's identity words?
    //    A NAME can be a colloquialism for the registrant ("baba" for
    //    Alibaba, "facebook" for Meta, "google" for Alphabet), so a
    //    mismatch is only worth reporting when the row's own note does
    //    not explain it. An unexplained mismatch is a row to read.
    const overlap = spokenWords.filter((word) => registrantWords.has(word)).length;
    const identityMissed = spokenWords.length > 0 && overlap === 0 && !row.note;

    // 2. Is the registrant a structured product or a shell? Matched on word
    //    boundaries, so "netflix inc" does not look like an ETF.
    const registrantWordList = registrant.split(' ');
    const structured = STRUCTURED_MARKERS.find((marker) => registrantWordList.includes(marker));

    // 3. What else does the SEC list offer for this name?
    const candidates = (byAlias.get(normalise(row.spoken)) || [])
      .map((c) => c.ticker)
      .filter((t) => t !== row.ticker);

    if (identityMissed || structured) {
      flagged.push({
        spoken: row.spoken,
        confirmed_ticker: row.ticker,
        registrant: entry.registrant,
        reason: structured
          ? `the registrant is a structured product or a shell (${structured})`
          : 'the registrant does not carry the spoken name, and the note does not say why',
        sec_candidates: candidates.slice(0, 8),
        count: row.count,
        note: row.note,
      });
    }
  }

  flagged.sort((a, b) => b.count - a.count);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked: rows.length, flagged, missing }, null, 2));
    return;
  }

  console.log(`[audit-names] ${rows.length} confirmed row(s) checked, ${flagged.length} flagged, ${missing.length} unknown ticker(s)`);
  for (const row of flagged) {
    console.log(`\n  "${row.spoken}" -> ${row.confirmed_ticker}  (${row.count} occurrences)`);
    console.log(`    registrant: ${row.registrant}`);
    console.log(`    why:       ${row.reason}`);
    if (row.sec_candidates.length) console.log(`    the SEC list also offers: ${row.sec_candidates.join(', ')}`);
    if (row.note) console.log(`    the note says: ${row.note}`);
  }
  if (missing.length) {
    console.log('\n--- tickers not in the SEC list at all ---');
    for (const row of missing) console.log(`  "${row.spoken}" -> ${row.confirmed_ticker} (${row.count})`);
  }
}

main();
