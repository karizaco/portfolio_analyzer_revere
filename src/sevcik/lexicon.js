'use strict';

// The tickers the Sevcik channel is allowed to report.
//
// WHY IT IS NOT THE SHARED SEED LEXICON
//
// The seed lexicon (`config/ticker_lexicon_seed.csv`) is the allow list
// for the OCR paths, and it is built around the two channels this
// project already reads: Revere's whiteboard and Qullamaggie's position
// list. It has 240 rows.
//
// The Sevcik speaker names companies the seed does not carry at all.
// Measured against the generated SEC name table: 10,170 of the 10,410
// US-listed tickers are NOT in the seed, and the channel names some of
// them -- as does every large-cap name he is likely to trade.
//
// So the Sevcik source has its OWN allow list: the shared seed, plus
// every ticker in the generated SEC name table, plus the curated non-US
// table.
//
// WHY THIS IS SAFE
//
// The allow list is a filter on what may be PUBLISHED, and widening it
// does not widen what may be RECOGNISED. A ticker is still only reported
// when it was actually said, and the name matcher still refuses an
// ambiguous name.
//
// The alternative -- gating the Sevcik source on the shared seed --
// would mean that a name the speaker says plainly ("Apple", "Tesla",
// "Intel") is dropped because a project that reads whiteboards does not
// care about them.
//
// THE SCOPE OF THE WIDENING
//
// The SEC table covers US listings, and the curated non-US table covers
// the European names the speaker was heard to say. Together they are
// every ticker this source can name. Nothing is published that was not
// in one of the two tables.

const fs = require('node:fs');
const path = require('node:path');

const { loadSeedLexiconSync } = require('../normalize/tickerScan');
const { loadCompanyNames, loadNonUsNames } = require('./companyNames');

/**
 * The tickers the Sevcik source may report.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeGenerated] - include the generated
 *   SEC name table (default true)
 * @param {boolean} [options.includeNonUs] - include the curated non-US
 *   table (default true)
 * @param {boolean} [options.includeSeed] - include the shared seed
 *   lexicon (default true)
 * @returns {Set<string>}
 */
function loadSevcikLexicon(options = {}) {
  const {
    includeGenerated = true,
    includeNonUs = true,
    includeSeed = true,
  } = options;

  const tickers = new Set();

  if (includeSeed) {
    for (const ticker of loadSeedLexiconSync().tickers) tickers.add(ticker);
  }
  if (includeGenerated) {
    for (const row of loadCompanyNames()) tickers.add(row.ticker);
  }
  if (includeNonUs) {
    for (const row of loadNonUsNames()) tickers.add(row.ticker);
  }

  return tickers;
}

/**
 * The tickers the Sevcik source may report, written to a file.
 *
 * The generated table is 10,410 rows and the seed is 240, so the
 * combined list is a FILE rather than something the tools build on every
 * run. The file is generated, and regenerating it is what the build tool
 * does.
 *
 * @param {object} [options]
 * @param {string} [options.outPath]
 * @returns {{path: string, count: number}}
 */
function writeSevcikLexicon(options = {}) {
  const outPath = options.outPath
    || path.resolve(__dirname, '..', '..', 'config', 'ticker_lexicon_sevcik.csv');

  const tickers = [...loadSevcikLexicon()].sort();

  const lines = [
    '# The tickers the Sevcik source may report.',
    '#',
    '# GENERATED. It is the shared seed lexicon plus every ticker in',
    '# config/ticker_company_names.csv (the SEC list) plus',
    '# config/ticker_names_non_us.csv (the curated European names).',
    '#',
    '# It is separate from the shared seed because the seed is built',
    '# around the OCR channels: 10,170 of the 10,410 SEC tickers are',
    '# not in it, and this speaker names large caps by name.',
    '#',
    '# Regenerate with: node tools/buildSevcikLexicon.js',
    'ticker',
  ];
  for (const ticker of tickers) lines.push(ticker);

  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  return { path: outPath, count: tickers.length };
}

module.exports = {
  loadSevcikLexicon,
  writeSevcikLexicon,
};
