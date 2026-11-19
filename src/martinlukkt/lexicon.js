'use strict';

// What the speaker said, out of what the ASR wrote.
//
// THE LEXICON
//
// `config/ticker_lexicon_martinlukkt.csv` is the corpus's own tickers: the
// book read off the frames, the stream titles, and the names he speaks. Every
// row was verified against a provider, because a ticker nobody returns is a
// misheard word, not a holding.
//
// THE CONFUSIONS
//
// `config/ticker_speech_confusions_martinlukkt.csv` is what the ASR gets
// wrong, each row verified against the evidence. "SNTK" is SNDK and he says
// so himself -- "the memory name short".
//
// THE RULE
//
// A correction comes from the CONFUSION TABLE and from nowhere else.
//
// The nearest-neighbour rule was measured and rejected here. On an 87-ticker
// lexicon "unique at the minimum distance" is meaningless -- almost
// everything is unique, because the list is small. It turned "I'm still
// shorting DM" (Desktop Metal) into DK (Delek US) and "I bought ACHL" into
// CL (Colgate). A wrong holding in a portfolio report is worse than a
// missing one, so a mishearing the table does not cover is dropped, not
// guessed.
//
// Order: the confusion table, then an exact lexicon hit. Anything else is
// `unknown`, and the caller keeps the raw read beside the resolved one.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LEXICON_PATH = path.join(ROOT, 'config', 'ticker_lexicon_martinlukkt.csv');
const CONFUSIONS_PATH = path.join(ROOT, 'config', 'ticker_speech_confusions_martinlukkt.csv');

let cache = null;

function readCsvRows(filePath, header) {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const first = trimmed.split(',')[0].trim().toUpperCase();
    if (first === header) continue;
    out.push(trimmed);
  }
  return out;
}

function load() {
  if (cache) return cache;
  const lexicon = readCsvRows(LEXICON_PATH, 'TICKER')
    .map((line) => line.split(',')[0].trim().toUpperCase())
    .filter(Boolean);
  const confusions = new Map();
  for (const line of readCsvRows(CONFUSIONS_PATH, 'GARBLED')) {
    const cells = line.split(',');
    const garbled = (cells[0] || '').trim().toUpperCase();
    const canonical = (cells[1] || '').trim().toUpperCase();
    if (garbled && canonical) confusions.set(garbled, canonical);
  }
  cache = {
    lexicon,
    known: new Set(lexicon),
    confusions,
  };
  return cache;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let previous = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) previous[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const current = new Array(n + 1);
    current[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[n];
}

/**
 * Resolve one spoken token.
 *
 * @param {string} token
 * @returns {{ticker: string, corrected: boolean, why: string, candidates: string[]}}
 */
function resolveSpokenTicker(token) {
  const { known, confusions } = load();
  const upper = String(token || '').trim().toUpperCase();
  if (!upper) return { candidates: [], corrected: false, ticker: '', why: 'empty' };

  const byConfusion = confusions.get(upper);
  if (byConfusion) {
    return {
      candidates: [], corrected: true, ticker: byConfusion, why: 'confusion',
    };
  }
  if (known.has(upper)) {
    return { candidates: [], corrected: false, ticker: upper, why: 'exact' };
  }
  return { candidates: [], corrected: false, ticker: '', why: 'unknown' };
}

module.exports = {
  resolveSpokenTicker,
};
