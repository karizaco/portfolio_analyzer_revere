'use strict';

// The seed lexicon must contain TICKERS, not the OCR VARIANTS of tickers.
//
// config/ticker_lexicon_seed.csv used to carry eleven rows that were not
// tickers at all: `AROQ`, `ARCQ`, `OBTS`, `GSII`, `IOI`, `PLIR`, `NUGI`,
// `JNUG`, `~09r3`, `GSlT`, `MNOY` — the shape a ticker takes when the
// recogniser misreads it.
//
// Why that mattered: an exact lexicon hit short-circuits the decoder at cost
// 0. So `PLIR` published as `PLIR` at 0.000 and never competed with `PLTR`,
// whose repair costs 0.375. The read was a false positive AND the true
// holding was a miss, in one stroke.
//
// The rows were deleted on 2026-10-29. With them gone the decoder repairs
// the garble to the real ticker, and the chart-stream path falls back to its
// alias table (config/ticker_ocr_confusions.csv).
//
// `JNUG` is the trap in that list: line 245 was a REDUNDANT duplicate of a
// REAL ticker that also exists on line 201. Deleting the variant block must
// not delete the real holding.
//
// The decode table at the bottom is pinned because every entry in it is a
// measured number. If the confusion matrix or the lexicon changes, one of
// these rows changes, and the change needs to be a decision rather than a
// side effect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDecodeLexiconSync, loadSeedLexiconSync } = require('../src/normalize/tickerScan');
const { decodeCell } = require('../src/normalize/tickerDecode');

const ROOT = path.resolve(__dirname, '..');
const SEED_CSV = path.join(ROOT, 'config', 'ticker_lexicon_seed.csv');

// The garbled forms, uppercased. `JNUG` is deliberately NOT here — it is a
// real ticker, and its variant row was a duplicate.
const VARIANT_ROWS = ['AROQ', 'ARCQ', 'OBTS', 'GSII', 'IOI', 'PLIR', 'NUGI', '~09R3', 'GSLT', 'MNOY'];

function seedRows() {
  const raw = fs.readFileSync(SEED_CSV, 'utf8');
  const rows = [];
  let isHeader = true;
  for (const line of raw.split(/\r?\n/)) {
    if (isHeader) {
      isHeader = false;
      if (/^ticker\s*,/i.test(line)) continue;
    }
    if (!line.trim()) continue;
    const [ticker, ...rest] = line.split(',');
    rows.push({ ticker: String(ticker).trim().toUpperCase(), note: rest.join(',').trim() });
  }
  return rows;
}

test('no OCR-variant row survives in the seed lexicon', () => {
  const rows = seedRows();
  for (const variant of VARIANT_ROWS) {
    const found = rows.filter((r) => r.ticker === variant);
    assert.equal(found.length, 0,
      `${variant} is still a seed row — a garbled read publishes verbatim and never competes with the real ticker`);
  }
});

test('no seed row is annotated as a variant', () => {
  for (const row of seedRows()) {
    assert.doesNotMatch(row.note, /variant/i,
      `${row.ticker} is annotated as an OCR variant — the seed lexicon holds tickers`);
  }
});

test('JNUG survives — the real ticker, not the variant', () => {
  const rows = seedRows().filter((r) => r.ticker === 'JNUG');
  assert.equal(rows.length, 1, 'JNUG must appear exactly once, as the real ETF');
  assert.doesNotMatch(rows[0].note, /variant/i);
  assert.ok(loadSeedLexiconSync().tickerSet.has('JNUG'));
});

test('the garbled forms decode to the real ticker', () => {
  const lexicon = loadDecodeLexiconSync();
  const expected = [
    ['PLIR', 'PLTR', 0.375],
    ['AROQ', 'ARQQ', 0.25],
    ['ARCQ', 'ARQQ', 0.5],
    ['OBTS', 'QBTS', 0.25],
    ['GSII', 'GSIT', 0.375],
    ['IOI', 'IOT', 0.375],
    ['NUGI', 'NUGT', 0.375],
    ['GSLT', 'GSIT', 0.625],
    ['MNOY', 'MNDY', 0.625],
  ];
  for (const [read, ticker, cost] of expected) {
    const decoded = decodeCell([{ text: read }], { lexicon });
    assert.ok(decoded, `${read} did not decode at all`);
    assert.equal(decoded.ticker, ticker, `${read} decoded to ${decoded.ticker}, expected ${ticker}`);
    assert.equal(decoded.cost, cost, `${read} decoded at cost ${decoded.cost}, expected ${cost}`);
  }
});

test('a read the decoder strips to a single letter decodes to nothing', () => {
  // `~09r3` was the tenth variant row. The decoder strips every non-A-Z
  // character out of the read before the lookup, so it arrives as `R` and
  // could never match the key `~09R3` — it was inert either way. Deleting it
  // changes nothing, which is why the seed row could go without a repair.
  const lexicon = loadDecodeLexiconSync();
  assert.equal(decodeCell([{ text: '~09r3' }], { lexicon }), null);
});

test('the real tickers still decode to themselves at zero cost', () => {
  const lexicon = loadDecodeLexiconSync();
  for (const ticker of ['JNUG', 'PLTR', 'ARQQ', 'QBTS', 'GSIT', 'IOT', 'NUGT', 'MNDY', 'URNM']) {
    const decoded = decodeCell([{ text: ticker }], { lexicon });
    assert.ok(decoded, `${ticker} did not decode`);
    assert.equal(decoded.ticker, ticker);
    assert.equal(decoded.cost, 0);
  }
});

test('the O-for-D confusion row changes no existing decode', () => {
  // The one row added to config/ticker_char_confusion.csv when the variant
  // rows were deleted. Measured: it changes NO decode, loses NO decode, and
  // adds 38 correct repairs.
  //
  // The candidate set is every single-substitution read of every lexicon
  // ticker that CONTAINS AN O. That restriction is sound: the pair is
  // `O>D` — the READ holds an O where the truth holds a D — so a read with no
  // O can never be affected by it.
  const { loadCharConfusion } = require('../src/normalize/tickerDecode');
  const base = loadCharConfusion();
  assert.ok(base.pairs.has('O>D'), 'the O-for-D row is missing from the confusion matrix');

  const lexicon = loadDecodeLexiconSync();
  const withoutOD = { pairs: new Map(base.pairs), max: base.max };
  withoutOD.pairs.delete('O>D');

  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const reads = new Set();
  for (const ticker of lexicon.tickers) {
    for (let i = 0; i < ticker.length; i += 1) {
      for (const c of A) {
        if (c === ticker[i]) continue;
        reads.add(ticker.slice(0, i) + c + ticker.slice(i + 1));
      }
    }
  }
  const candidates = [...reads].filter((r) => r.includes('O'));
  assert.ok(candidates.length > 1000, `expected a large candidate set, got ${candidates.length}`);

  let changed = 0;
  let gained = 0;
  let lost = 0;
  for (const read of candidates) {
    const before = decodeCell([{ text: read }], { lexicon, confusion: withoutOD });
    const after = decodeCell([{ text: read }], { lexicon, confusion: base });
    const a = before ? before.ticker : null;
    const b = after ? after.ticker : null;
    if (a === b) continue;
    if (b === null) lost += 1;
    else if (a === null) gained += 1;
    else changed += 1;
  }
  assert.equal(changed, 0, 'the O-for-D row must not change an existing decode');
  assert.equal(lost, 0, 'the O-for-D row must not lose a decode');
  assert.equal(gained, 38, 'the O-for-D row should add exactly the measured repairs');
});

test('the O-for-D row repairs MNOY to MNDY', () => {
  const { loadCharConfusion } = require('../src/normalize/tickerDecode');
  const lexicon = loadDecodeLexiconSync();
  const withoutOD = { pairs: new Map(loadCharConfusion().pairs), max: loadCharConfusion().max };
  withoutOD.pairs.delete('O>D');
  assert.equal(decodeCell([{ text: 'MNOY' }], { lexicon, confusion: withoutOD }), null);
  const repaired = decodeCell([{ text: 'MNOY' }], { lexicon });
  assert.ok(repaired);
  assert.equal(repaired.ticker, 'MNDY');
  assert.equal(repaired.cost, 0.625);
});

test('the seed lexicon still holds the real holdings', () => {
  const set = loadSeedLexiconSync().tickerSet;
  for (const ticker of ['JNUG', 'NUGT', 'MNDY', 'GSIT', 'IOT', 'ARQQ', 'QBTS', 'PLTR', 'URNM']) {
    assert.ok(set.has(ticker), `${ticker} is missing from the seed lexicon`);
  }
});
