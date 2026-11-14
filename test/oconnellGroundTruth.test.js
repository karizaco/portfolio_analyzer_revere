'use strict';

// The O'Connell position reader, scored against a HAND-READ ground truth.
//
// WHY THIS IS A TEST AND NOT A SCORING TOOL
//
// The reader is right about the STRUCTURE -- which table is which, which
// column is which, how many lots there are -- and it has to be MEASURED
// about the VALUES. The corpus's position logs are screenshots at five
// different resolutions, and the same cell is 60 pixels wide in one
// capture and 90 in another, so a reader that is right on one resolution
// can be wrong on another.
//
// The ground truth in `data/oconnell_ground_truth.json` was read off the
// images BY HAND, field by field. This test scores the reader against it
// and REPORTS the accuracy, and it asserts a floor.
//
// WHY IT SKIPS
//
// The corpus is paid, it lives outside the repository, and it cannot be
// re-fetched -- so on a machine that does not have it there is nothing to
// read and the test has nothing to say. It skips, loudly, rather than
// passing by not running.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { oconnellSourceDir } = require('../src/oconnell/channel');
const { closeWorker } = require('../src/table/tableReader');

const ROOT = path.resolve(__dirname, '..');
const GROUND_TRUTH_PATH = path.join(ROOT, 'data', 'oconnell_ground_truth.json');

const groundTruth = JSON.parse(fs.readFileSync(GROUND_TRUTH_PATH, 'utf8'));
const sourceDir = oconnellSourceDir();

/** The fields the ground truth pins, per instrument. */
const EQUITY_FIELDS = [
  'change_pct',
  'cost_basis',
  'price',
  'gain_loss_pct',
  'size_stars',
  'stop_price',
  'risk_pct',
  'r2_price',
  'sma20',
  'sma50',
  'entry_date',
  'trade_length_days',
];

const OPTION_FIELDS = [
  'contract',
  'cost_basis',
  'price',
  'gain_loss_pct',
  'size_stars',
  'beta',
  'delta',
  'setup_label',
  'entry_date',
  'trade_length_days',
];

/**
 * The lots, in the order the sheet prints them.
 *
 * @param {object[]} positions
 * @param {string} instrument
 * @returns {object[]}
 */
function lotsOf(positions, instrument) {
  return positions.filter((position) => position.instrument === instrument);
}

/**
 * Compare one lot with its ground truth.
 *
 * @param {object} read
 * @param {object} truth
 * @param {string[]} fields
 * @returns {{misses: object[], hits: number, total: number}}
 */
function compareLot(read, truth, fields) {
  const misses = [];
  let hits = 0;
  for (const field of fields) {
    const expected = truth[field];
    const actual = read[field];
    const same = expected === actual
      || (typeof expected === 'number' && typeof actual === 'number'
        && Math.abs(expected - actual) < 0.005)
      || (expected === null && (actual === null || actual === undefined));
    if (same) {
      hits += 1;
      continue;
    }
    misses.push({ actual, expected, field });
  }
  return { hits, misses, total: fields.length };
}

test('the position reader agrees with the hand-read ground truth', { timeout: 900000 }, async (t) => {
  const { readPositionLog } = require('../tools/extractOconnellPositions');

  const documents = Object.entries(groundTruth.documents);
  let ran = 0;

  for (const [date, truth] of documents) {
    const imagePath = path.join(sourceDir, truth.image);
    if (!fs.existsSync(imagePath)) {
      t.skip(`the corpus is not on this machine (${truth.image})`);
      continue;
    }
    ran += 1;

    const reading = await readPositionLog(imagePath, Number(date.slice(0, 4)));

    // THE STRUCTURE: the lots themselves, by their count and their ticker.
    const equities = lotsOf(reading.positions, 'equity');
    const options = lotsOf(reading.positions, 'option');
    assert.equal(equities.length, truth.equities.length,
      `${date}: the equities table must hold ${truth.equities.length} lots`);
    assert.equal(options.length, truth.options.length,
      `${date}: the options table must hold ${truth.options.length} lots`);
    equities.forEach((lot, index) => {
      assert.equal(lot.ticker, truth.equities[index].ticker,
        `${date}: equity lot ${index} is ${lot.ticker}, not ${truth.equities[index].ticker}`);
    });
    options.forEach((lot, index) => {
      assert.equal(lot.ticker, truth.options[index].ticker,
        `${date}: option lot ${index} is ${lot.ticker}, not ${truth.options[index].ticker}`);
    });

    // THE VALUES: measured, and the misses are named.
    let hits = 0;
    let total = 0;
    const misses = [];
    equities.forEach((lot, index) => {
      const compared = compareLot(lot, truth.equities[index], EQUITY_FIELDS);
      hits += compared.hits;
      total += compared.total;
      compared.misses.forEach((miss) => misses.push({ ...miss, date, instrument: 'equity', index }));
    });
    options.forEach((lot, index) => {
      const compared = compareLot(lot, truth.options[index], OPTION_FIELDS);
      hits += compared.hits;
      total += compared.total;
      compared.misses.forEach((miss) => misses.push({ ...miss, date, instrument: 'option', index }));
    });

    // THE SNAPSHOT: the numbers the log reports about itself.
    const snapshotFields = Object.keys(truth.snapshot);
    for (const field of snapshotFields) {
      const expected = truth.snapshot[field];
      const actual = reading.snapshot[field];
      const same = expected === actual
        || (typeof expected === 'number' && typeof actual === 'number'
          && Math.abs(expected - actual) < 0.005);
      assert.ok(same,
        `${date}: the snapshot's ${field} is ${actual}, not ${expected}`);
    }

    const accuracy = total ? hits / total : 1;
    console.log(`[oconnell-ground-truth] ${date}: ${hits}/${total} fields `
      + `(${(accuracy * 100).toFixed(1)} %)`);
    if (misses.length) {
      console.log(`[oconnell-ground-truth] ${date} misses: `
        + misses.map((miss) => `${miss.instrument}[${miss.index}].${miss.field} `
          + `${JSON.stringify(miss.actual)} != ${JSON.stringify(miss.expected)}`).join('; '));
    }

    // THE FLOOR
    //
    // The values are read off a screenshot, and a digit in a 7-pixel cell
    // is a coin toss. The floor is set at the level the measurement
    // supports: every lot and every ticker is right, and at least nine
    // fields in ten are right.
    assert.ok(accuracy >= 0.9,
      `${date}: only ${(accuracy * 100).toFixed(1)} % of the fields are right`);
  }

  await closeWorker();
  if (!ran) {
    t.skip('the corpus is not on this machine');
  }
});
