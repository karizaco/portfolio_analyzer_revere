'use strict';

// The LAYOUT-SCOPED ALIAS in the TABLE reader.
//
// The chart-stream reader has had a date-scoped alias table since
// 2026-11-06: on the 20220606-20220608 floating panel, the cell the
// OCR reads as NFU is NFLX. NFU is a REAL seed ticker, which is exactly
// why the SHARED table cannot carry the row -- its invariant is that no
// garbled form is a lexicon ticker.
//
// The table reader had no such rule, so it published NFU where the
// pixels show NFLX. The cell reads are the ones the measured sweep
// recorded:
//
//   20220606  the cell reads "NHX"  -> the decoder resolves it to NFU
//   20220607  the cell reads "NFU"  -> an exact hit on the lexicon
//   20220607  the cell reads "NFUX" -> the decoder resolves it to NFU
//
// and the truth is NFLX in all three.
//
// This file pins that the table reader now applies the LAYOUT's own
// rows, and that the canonical has to be a ticker the market has.

const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeRows } = require('../src/video/positionTableScan');
const { eraAliasMapForLayout } = require('../src/parse/parseChartStream');
const { layoutAliasEraForDate } = require('../src/video/chartStreamCrop');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');

// The lexicon is the OBJECT `loadDecodeLexiconSync()` returns -- it
// carries `tickers` and a `tickerSet` -- and the decoder needs that
// shape, not a bare Set.
const LEXICON = loadDecodeLexiconSync();

const ALIASES = eraAliasMapForLayout(layoutAliasEraForDate('20220606'));

/**
 * A cell, read by the three strip variants.
 *
 * The reader runs the ticker column three ways and keeps the three
 * reads as the cell's hypotheses, so a cell is "NHX|NHX|NFU" rather
 * than a single string. That matters: the decode wins on the EXACT
 * lexicon hit in the list, and "NFU" is one.
 *
 * @param {string[]} texts
 * @returns {object}
 */
function cell(texts) {
  return { hypotheses: texts.map((text) => ({ text, conf: 0.9, source: 'test' })) };
}

test('the layout era is the date\'s, and it is scoped', () => {
  assert.equal(layoutAliasEraForDate('20220606'), 'floating_panel_nfu_20220606_08');
  assert.equal(layoutAliasEraForDate('20220607'), 'floating_panel_nfu_20220606_08');
  assert.equal(layoutAliasEraForDate('20220608'), 'floating_panel_nfu_20220606_08');
  // One day earlier and one day later there is NO such rule.
  assert.equal(layoutAliasEraForDate('20220605'), null);
  assert.equal(layoutAliasEraForDate('20220609'), null);
});

test('the era map carries the era\'s OWN rows, and not the shared table\'s', () => {
  const map = eraAliasMapForLayout(layoutAliasEraForDate('20220606'));
  assert.equal(map.get('NFU'), 'NFLX');
  assert.equal(map.get('NF'), 'NFLX');
  // And an era that does not exist has no rows at all.
  assert.equal(eraAliasMapForLayout(null).size, 0);
  assert.equal(eraAliasMapForLayout('no_such_era').size, 0);
});

test('the table reader applies the layout\'s alias to the cell it misread', () => {
  // The three cell reads the measured sweep recorded, and all three
  // decode to NFU without the alias.
  const CELLS = [
    ['NHX', 'NHX', 'NFU'],
    ['NFU', 'NFUX', 'NFUX'],
    ['NFUX', 'NFUX', 'NFU'],
  ];
  for (const texts of CELLS) {
    const label = texts.join('|');
    const plain = decodeRows([cell(texts)], { lexicon: LEXICON });
    assert.equal(plain[0].ticker, 'NFU', `${label} decodes to NFU on its own`);
    assert.equal(plain[0].aliased_from, '');

    const aliased = decodeRows([cell(texts)], { lexicon: LEXICON, aliases: ALIASES });
    assert.equal(aliased[0].ticker, 'NFLX', `${label} becomes NFLX with the alias`);
    assert.equal(aliased[0].aliased_from, 'NFU');
  }
});

test('the alias is scoped to its dates, so a cell outside them is untouched', () => {
  // The same cell read on a date with no such rule stays NFU -- and NFU
  // is a real ticker, so it is a real (wrong) holding there.
  const decoded = decodeRows([cell(['NFU'])], { lexicon: LEXICON });
  assert.equal(decoded[0].ticker, 'NFU');
});

test('an alias cannot introduce a ticker the market does not have', () => {
  // A canonical that is not in the lexicon is refused, and the decoded
  // ticker is kept.
  const decoded = decodeRows([cell(['NFU'])], {
    lexicon: LEXICON,
    aliases: new Map([['NFU', 'NOT_A_REAL_TICKER']]),
  });
  assert.equal(decoded[0].ticker, 'NFU');
  assert.equal(decoded[0].aliased_from, '');
});

test('a cell that is not in the alias table is untouched', () => {
  const decoded = decodeRows([cell(['AAPL'])], { lexicon: LEXICON, aliases: ALIASES });
  assert.equal(decoded[0].ticker, 'AAPL');
  assert.equal(decoded[0].aliased_from, '');
});
