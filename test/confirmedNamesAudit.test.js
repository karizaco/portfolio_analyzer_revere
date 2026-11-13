'use strict';

// The confirmed spoken-names table is a table of CLAIMS: "when the host
// says X, the ticker is Y". A wrong claim publishes a wrong holding on
// every mention, so these tests pin the four that the Benzinga corpus
// exposed on 2026-11-13 -- and the mechanism behind each one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const {
  matchCompanyName, stemName, isDeniedSpokenStem,
} = require('../src/sevcik/companyNames');
const {
  findEnglishCompanyNames, isPhraseCollision,
} = require('../src/t3live/englishNames');
const { loadSevcikLexicon } = require('../src/sevcik/lexicon');

const ROOT = path.resolve(__dirname, '..');
const SEC_LIST = path.join(ROOT, 'config', 'ticker_company_names.csv');

/** The SEC list's registrant for a ticker, so a claim can be checked. */
function registrantFor(ticker) {
  const lines = fs.readFileSync(SEC_LIST, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = /^([^,]+),("(?:[^"]*)"|[^,]*),(.*)$/.exec(line);
    if (match && match[1].trim() === ticker) return match[2].replace(/^"|"$/g, '').trim();
  }
  return '';
}

test('"Goldman Sachs" is the BANK, not the STRATS trust that carries its name', () => {
  // GJS is "STRATS(SM) Trust for Goldman Sachs Group Securities, Series
  // 2006-2" -- a structured product whose registrant merely CONTAINS the
  // bank's name. It was the confirmed answer for 56 T3Live signals.
  assert.match(registrantFor('GJS'), /STRATS/i);
  assert.match(registrantFor('GS'), /GOLDMAN SACHS GROUP/i);

  for (const spoken of ['goldman sachs', 'goldman', 'sachs', 'Goldman Sachs', 'Goldman']) {
    assert.equal(matchCompanyName(spoken).ticker, 'GS', `"${spoken}" must be the bank`);
  }
});

test('"Iron" is IREN, not the SPAC whose registrant starts with the word', () => {
  // IRHO is "Iron Horse Acquisition II Corp." -- a blank-check company
  // pinned near $10 with no volume. The corpus names "Iron" beside NBIS
  // and CIFR, its peer group, and trades its options in the $50s.
  assert.match(registrantFor('IRHO'), /Acquisition/i);
  assert.equal(matchCompanyName('iron').ticker, 'IREN');
  assert.equal(matchCompanyName('Iron').ticker, 'IREN');

  // "Iron Mountain" is a DIFFERENT company and still resolves to itself,
  // because the pair is tried before the single word.
  assert.equal(matchCompanyName('iron mountain').ticker, 'IRM');
});

test('"Rocket" is Rocket Lab, not Rocket Pharmaceuticals', () => {
  // The row's own note said "Rocket Labs, the space company" while
  // pointing at RCKT. The corpus says "Rocket Lab" and "Rocket Labs".
  assert.match(registrantFor('RCKT'), /PHARMACEUTICALS/i);
  assert.match(registrantFor('RKLB'), /Rocket Lab/i);

  for (const spoken of ['rocket', 'rocket lab', 'rocket labs']) {
    assert.equal(matchCompanyName(spoken).ticker, 'RKLB', `"${spoken}" must be Rocket Lab`);
  }
});

test('an English given name does not reach MARA through the Czech stem', () => {
  // THE MECHANISM. The stem exists to bridge a Czech case ending, so it
  // drops trailing vowels -- and every one of these stems to "mar", which
  // is the key the real `mara -> MARA` row is stored under.
  for (const name of ['mara', 'maria', 'mario', 'mary', 'marie']) {
    assert.equal(stemName(name), 'mar', `"${name}" stems to the same key`);
  }

  // So the denial has to be by EXACT FORM. Denying the stem would take
  // the real holding with it.
  for (const name of ['maria', 'mario', 'mary', 'marie']) {
    assert.equal(isDeniedSpokenStem(name), true, `"${name}" is denied`);
    assert.equal(matchCompanyName(name).ticker, null, `"${name}" resolves to nothing`);
  }

  // And the real row still works.
  assert.equal(isDeniedSpokenStem('mara'), false);
  assert.equal(matchCompanyName('mara').ticker, 'MARA');
});

test('a company word inside a fixed phrase is not the company', () => {
  const lexicon = loadSevcikLexicon();
  const tickers = (text) => findEnglishCompanyNames(text, { lexicon })
    .filter((name) => name.ticker)
    .map((name) => name.ticker);

  // The options strategies and the triathlon.
  assert.deepEqual(tickers('Iron condor action at this point.'), []);
  assert.deepEqual(tickers('a synthetic iron butterfly here'), []);
  assert.deepEqual(tickers('I was doing the Iron Man training back then.'), []);
  assert.deepEqual(tickers('we have to iron out exactly how the pattern works'), []);

  // And the company itself still reads.
  assert.deepEqual(tickers('Iron was my best trade this week.'), ['IREN']);
  assert.deepEqual(tickers('NBIS, CIFR, Iron are three names to watch.'), ['IREN']);
});

test('the phrase test reads the text AFTER the token, not the token', () => {
  // A rule that keyed on the word alone would reject the company too.
  const text = 'Iron condor and then Iron on its own';
  assert.equal(isPhraseCollision('Iron', text, 0), true);
  assert.equal(isPhraseCollision('Iron', text, text.lastIndexOf('Iron')), false);
  // A word with no rule is never a collision.
  assert.equal(isPhraseCollision('Goldman', 'Goldman condor', 0), false);
});

test('every confirmed row points at a ticker the SEC list knows', () => {
  // A row whose ticker is not in the SEC list cannot be checked against a
  // registrant at all, so it is a claim nothing can audit. The three
  // non-US rows (IPR, MONETA, RHM) are the deliberate exception: they
  // live in the curated non-US table, which IS its own confirmation.
  const content = fs.readFileSync(path.join(ROOT, 'config', 'ticker_names_confirmed.csv'), 'utf8');
  const known = new Set(['IPR', 'MONETA', 'RHM']);
  const unknown = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const ticker = parts[1].trim().toUpperCase();
    if (!ticker || known.has(ticker)) continue;
    if (!registrantFor(ticker)) unknown.push(`${parts[0].trim()} -> ${ticker}`);
  }
  assert.deepEqual(unknown, [], 'every confirmed ticker is in the SEC list');
});
