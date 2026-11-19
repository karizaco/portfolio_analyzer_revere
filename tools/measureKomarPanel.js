'use strict';

/**
 * Measure the Komar PANEL READER against the panels' own pixels.
 *
 * WHAT THIS IS
 *
 * The panel reader is the one Komar component that is not wired to a
 * writer, and the reason is that it had never been MEASURED: every
 * reading of it so far was reported by hand. This tool scores it
 * against the pinned expectation -- the rows read off the frames' own
 * pixels, one frame per era -- so that a change to the reader moves a
 * number instead of a feeling.
 *
 *   node tools/measureKomarPanel.js
 *   node tools/measureKomarPanel.js --json
 *
 * THE SCORE, and what it is worth
 *
 *   the symbols, in order -- the reading's ORDER matters, because the
 *     panel is a portfolio and a holding in the wrong place is a
 *     different claim about the same day;
 *   the prices, matched by symbol, where the crop does not cut the
 *     value.
 *
 * TWO THINGS THE SCORE DOES NOT SAY, and they are both measured:
 *
 *   1. **TESSERACT'S READING DEPENDS ON WHAT THE WORKER READ BEFORE
 *      IT.** The same region read twice in one process gave "nue" and
 *      "MU" for the same ticker (the 2026-04-25 frame). So the score
 *      is a measurement of the pixels AND the order they were read
 *      in, and a run that scores differently from the one below is
 *      not necessarily a worse reader.
 *   2. **THE FRAMES ARE A SAMPLE.** One frame per era, and the era A
 *      frame is a WATCHLIST of indices and ETFs (US02, IWN, QQQ, SPY)
 *      while the era C frame is a PORTFOLIO of holdings.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readKomarPanel } = require('../src/komar/panelReader');
const { loadKomarLexicon } = require('../src/komar/lexicon');
const { closeWorker } = require('../src/table/tableReader');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'komar_panel');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
const lexicon = loadKomarLexicon();

const options = { json: process.argv.includes('--json') };

/**
 * Do two numbers agree, allowing for the reading's tolerance?
 *
 * @param {number|null} expected
 * @param {number|null} actual
 * @returns {boolean}
 */
function sameNumber(expected, actual) {
  if (expected === null || expected === undefined) return true;
  if (actual === null || actual === undefined) return false;
  return Math.abs(Number(expected) - Number(actual)) <= Math.max(0.02, Math.abs(expected) * 0.002);
}

async function main() {
  const frames = [];
  let symbolHits = 0;
  let setHits = 0;
  let totalRows = 0;
  let priceHits = 0;
  let priceCount = 0;

  for (const entry of manifest.files) {
    const expected = expectations.frames[entry.file];
    const result = await readKomarPanel(path.join(FIXTURES, entry.file), {
      dateKey: expected.session_date,
      lexicon,
      mode: expected.mode,
    });
    const symbols = result.rows.map((row) => row.symbol);
    const hits = expected.rows.filter((row, index) => symbols[index] === row.symbol).length;
    // The SET score: the symbols found, whatever their order. The
    // in-order score is the strict one, but a row that merged two
    // rows shifts every row after it, and the set score says what was
    // actually FOUND.
    const expectedSet = new Set(expected.rows.map((row) => row.symbol));
    const found = [...new Set(symbols)].filter((symbol) => expectedSet.has(symbol)).length;

    let hitsHere = 0;
    let pricesHere = 0;
    let pricesCounted = 0;
    for (const row of expected.rows) {
      const read = result.rows.find((candidate) => candidate.symbol === row.symbol);
      if (!read) continue;
      for (const field of ['last', 'chg', 'chg_pct']) {
        if (row[field] === null || row[field] === undefined) continue;
        pricesCounted += 1;
        if (sameNumber(row[field], read[field])) pricesHere += 1;
      }
    }

    symbolHits += hits;
    totalRows += expected.rows.length;
    setHits += found;
    priceHits += pricesHere;
    priceCount += pricesCounted;
    frames.push({
      era: result.era,
      expected_symbols: expected.rows.map((row) => row.symbol),
      file: entry.file,
      groups: result.groups.map((group) => group.group),
      notes: result.notes,
      prices: `${pricesHere}/${pricesCounted}`,
      read_symbols: symbols,
      set: `${found}/${expectedSet.size}`,
      symbols: `${hits}/${expected.rows.length}`,
    });
  }

  const payload = {
    frames,
    generated_at: new Date().toISOString(),
    prices: `${priceHits}/${priceCount}`,
    prices_share: priceCount ? Number((priceHits / priceCount).toFixed(3)) : null,
    set: `${setHits}/${totalRows}`,
    set_share: totalRows ? Number((setHits / totalRows).toFixed(3)) : null,
    symbols: `${symbolHits}/${totalRows}`,
    symbols_share: totalRows ? Number((symbolHits / totalRows).toFixed(3)) : null,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const frame of frames) {
      console.log(`\n${frame.file} (${frame.era})`);
      console.log(`  the groups: ${frame.groups.join(' | ') || '(none)'}`);
      console.log(`  read:     ${frame.read_symbols.join(' ')}`);
      console.log(`  expected: ${frame.expected_symbols.join(' ')}`);
      console.log(`  the symbols: ${frame.symbols} in order, ${frame.set} found, the prices: ${frame.prices}`);
      if (frame.notes.length) console.log(`  the notes: ${frame.notes.join('; ')}`);
    }
    console.log(`\nTHE PANEL READER: ${payload.symbols} symbols in order, ${payload.set} found, `
      + `${payload.prices} prices `
      + `(${(payload.prices_share * 100).toFixed(1)} %)`);
  }

  await closeWorker();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
