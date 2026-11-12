'use strict';

// The number repair and the canonical reading of a sector row.
//
// WHY THESE TESTS EXIST
//
// The sector table is read out of video frames, and the cells are small.
// When the OCR loses the LAST digit of a cell -- "15.6" comes back as
// "15." -- the old repair assumed the DECIMAL POINT had been lost and
// read the digits "15" as 0.15. That is a hundred times too small, and
// because the reducer averages the two middle values of an even set, it
// then averaged 0.15 with the true 15.6 into 7.875: a number that never
// appeared on screen.
//
// The corpus carries the evidence: 12 rows have both a truncated and a
// complete reading of the same cell, and in 11 of them the truncated
// token is the integer part.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLUMN_BOUNDS,
  COLUMN_STRIPS,
  mergeReadings,
  reduceReadings,
  repairNumber,
  signOfToken,
  PARSER_VERSION,
} = require('../src/asym/sectorTable');

const frame = (n) => ({ file_path: 'f' + n, timestamp_sec: n, frame_index: n });

// ---------------------------------------------------------------------------
// The number repair
// ---------------------------------------------------------------------------

test('a whole number is believed', () => {
  const r = repairNumber('11.27');
  assert.equal(r.value, 11.27);
  assert.equal(r.repaired, false);
  assert.equal(r.complete, true);
});

test('a number with a lost decimal point is rebuilt from its digits', () => {
  const r = repairNumber('147');
  assert.equal(r.value, 1.47);
  assert.equal(r.repaired, true);
  assert.equal(r.complete, true);
});

test('a cell that lost its LAST DIGIT keeps its integer part and is INCOMPLETE', () => {
  const r = repairNumber('15.');
  assert.equal(r.value, 15, 'not 0.15 -- the point was not lost, the digit was');
  assert.equal(r.complete, false);
  assert.equal(r.truncated, true);
});

test('a cell that lost its last digit keeps its sign', () => {
  const r = repairNumber('-8.');
  assert.equal(r.value, -8);
  assert.equal(r.complete, false);
});

test('a cell whose last digit was misread as a mark is INCOMPLETE too', () => {
  const r = repairNumber('30.');
  assert.equal(r.value, 30);
  assert.equal(r.complete, false);
  // The same shape with a non-digit after the point.
  const other = repairNumber('30.');
  assert.equal(other.complete, false);
});

test('a cell that is only a sign and a point is INCOMPLETE', () => {
  const r = repairNumber('-0.');
  assert.equal(r.value, 0);
  assert.equal(r.complete, false);
});

test('a single digit cannot place the point, so it is INCOMPLETE', () => {
  const r = repairNumber('7');
  assert.equal(r.value, 0.7);
  assert.equal(r.complete, false, '7 could be 0.70 or 7.00');
});

test('a cell with a percent sign and a sign is read', () => {
  assert.equal(repairNumber('+0.27%').value, 0.27);
  assert.equal(repairNumber('-1.28%').value, -1.28);
  assert.equal(repairNumber('+0.27%').complete, true);
});

test('a cell whose minus sign was misread as a curly quote keeps its digits', () => {
  const r = repairNumber('0.02%');
  assert.equal(r.value, 0.02);
  assert.equal(r.complete, true);
});

test('an empty cell is nothing at all', () => {
  const r = repairNumber('');
  assert.equal(r.value, null);
  assert.equal(r.complete, false);
});

test('a cell with no digits is nothing at all', () => {
  assert.equal(repairNumber('v').value, null);
  assert.equal(repairNumber('pL').value, null);
});

// ---------------------------------------------------------------------------
// The canonical reading
// ---------------------------------------------------------------------------

test('the COMPLETE readings are the canonical ones', () => {
  // The real shape of the bug: one frame read the cell whole, another
  // read it without its last digit.
  const readings = [
    { sector: 'Real Estate', roc_1mo: 15.6, pct_change: 15.6, change_complete: true, sign_source: 'colour', frame: frame(2), confidence: 64 },
    { sector: 'Real Estate', roc_1mo: 15, pct_change: 15, change_complete: false, sign_source: 'colour', frame: frame(0), confidence: 67 },
    { sector: 'Real Estate', roc_1mo: 15.6, pct_change: 15.6, change_complete: true, sign_source: 'colour', frame: frame(3), confidence: 66 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.pct_change, 15.6, 'the truncated 15 does not win');
  assert.equal(reduced.approximate, false);
  assert.equal(reduced.change_readings, 2, 'only the complete readings are used');
  assert.equal(reduced.readings, 3, 'all three readings are counted');
});

test('an even set of readings is NOT averaged into a number that never appeared', () => {
  const readings = [
    { sector: 'Utilities', pct_change: 30.5, change_complete: true, sign_source: 'colour', frame: frame(4), confidence: 67 },
    { sector: 'Utilities', pct_change: 0.3, change_complete: false, sign_source: 'colour', frame: frame(5), confidence: 64 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.pct_change, 30.5, 'not 15.4, which is the average of the two');
  assert.equal(reduced.change_readings, 1);
});

test('with nothing but incomplete readings, the value is used and FLAGGED', () => {
  const readings = [
    { sector: 'Energy', pct_change: -8, change_complete: false, sign_source: 'colour', frame: frame(1), confidence: 67 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.pct_change, -8);
  assert.equal(reduced.approximate, true, 'the value is a lower bound, not a reading');
});

test('the row is attributed to the frame that supplied the value', () => {
  const readings = [
    { sector: 'Health Care', pct_change: 11.27, change_complete: true, sign_source: 'colour', frame: frame(7), confidence: 70 },
    { sector: 'Health Care', pct_change: 11.27, change_complete: true, sign_source: 'colour', frame: frame(2), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  // Both frames read the same value; the median is that value, and the
  // frame has to be one of the frames that read it.
  const frames = [7, 2];
  assert.ok(frames.includes(reduced.change_frame.frame_index));
});

test('a sector with no readings reduces to nothing', () => {
  assert.equal(reduceReadings([]), null);
});

test('the parser version moved when the repair changed', () => {
  assert.equal(PARSER_VERSION, 'asym-sector-4');
});

// ---------------------------------------------------------------------------
// The three columns of the table
// ---------------------------------------------------------------------------

test('the three numeric columns do not overlap', () => {
  // The bug this guards against: the "% Change" column and the
  // "Rate of Change (1yr)" column were read as ONE column, so the
  // one-year number was stored under the name pct_change. The three
  // bands are measured off real frames, so they must stay apart.
  const bands = [COLUMN_BOUNDS.roc, COLUMN_BOUNDS.change, COLUMN_BOUNDS.roc1yr];
  for (let i = 1; i < bands.length; i += 1) {
    assert.ok(
      bands[i].min >= bands[i - 1].max,
      'column ' + i + ' starts inside the previous column'
    );
  }
});

test('the "% Change" column stops before the one-year column starts', () => {
  // Measured off a 1920x1080 frame: the day % Change text spans
  // x 254..294 and the one-year ROC spans x 326..355.
  assert.ok(COLUMN_BOUNDS.change.max <= 300);
  assert.ok(COLUMN_BOUNDS.roc1yr.min >= 318);
});

test('the one-year column is read as its own strip', () => {
  // The strip is what carries the SIGN of the one-year number: the
  // glyph is white, so the minus is a one-pixel dash that the wide
  // panel read loses.
  assert.ok(COLUMN_STRIPS.roc1yr.min >= 318);
  assert.ok(COLUMN_STRIPS.roc1yr.max <= 360);
  assert.notEqual(COLUMN_STRIPS.roc1yr.min, COLUMN_STRIPS.roc.min);
});

// ---------------------------------------------------------------------------
// The sign of a cell, read from its own text
// ---------------------------------------------------------------------------

test('a minus in the text is a minus', () => {
  assert.equal(signOfToken('-1.97'), -1);
  assert.equal(signOfToken('25.56'), 1);
});

test('a cell with no text has no sign', () => {
  assert.equal(signOfToken(''), 0);
  assert.equal(signOfToken(null), 0);
});

// ---------------------------------------------------------------------------
// Merging the panel's reading with the strip's
// ---------------------------------------------------------------------------

test('the complete reading wins the merge', () => {
  const merged = mergeReadings('10.', '10.30');
  assert.equal(merged.value, 10.3);
  assert.equal(merged.complete, true);
  assert.equal(merged.raw, '10.30');
});

test('a complete preferred reading wins over a complete fallback', () => {
  const merged = mergeReadings('10.30', '10.3');
  assert.equal(merged.value, 10.3);
  assert.equal(merged.raw, '10.30');
});

test('with nothing complete, the preferred reading is used and flagged', () => {
  const merged = mergeReadings('10.', '10.');
  assert.equal(merged.value, 10);
  assert.equal(merged.complete, false);
});

test('the merge of two empty readings is nothing', () => {
  const merged = mergeReadings('', '');
  assert.equal(merged.value, null);
  assert.equal(merged.complete, false);
});

// ---------------------------------------------------------------------------
// The one-year column through the reducer
// ---------------------------------------------------------------------------

test('the one-year value is reduced like the other two', () => {
  const readings = [
    { sector: 'Basic Materials', roc_1yr: -1.97, roc1yr_complete: true, sign_source: 'ocr', frame: frame(1), confidence: 70 },
    { sector: 'Basic Materials', roc_1yr: -1.97, roc1yr_complete: true, sign_source: 'ocr', frame: frame(2), confidence: 70 },
    { sector: 'Basic Materials', roc_1yr: -1.9, roc1yr_complete: false, sign_source: 'ocr', frame: frame(0), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.roc_1yr, -1.97, 'the truncated reading does not win');
  assert.equal(reduced.roc1yr_readings, 2);
  assert.equal(reduced.roc1yr_spread, 0);
});

test('a one-year value with nothing complete is flagged', () => {
  const readings = [
    { sector: 'Technology', roc_1yr: 6.3, roc1yr_complete: false, sign_source: 'ocr', frame: frame(0), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.roc_1yr, 6.3);
  assert.equal(reduced.approximate, true);
});

test('the three metrics are reduced independently', () => {
  // A row where the day change was read whole but the one-year was
  // truncated: the day change must NOT be dragged down with it.
  const readings = [
    { sector: 'Real Estate', roc_1mo: -1.99, roc_complete: true, pct_change: -0.33, change_complete: true, roc_1yr: 10.3, roc1yr_complete: true, sign_source: 'colour', frame: frame(0), confidence: 70 },
    { sector: 'Real Estate', roc_1mo: -1.99, roc_complete: true, pct_change: -0.33, change_complete: true, roc_1yr: 10.3, roc1yr_complete: true, sign_source: 'colour', frame: frame(1), confidence: 70 },
    { sector: 'Real Estate', roc_1mo: -2, roc_complete: false, pct_change: -0.33, change_complete: true, roc_1yr: 10, roc1yr_complete: false, sign_source: 'colour', frame: frame(2), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.pct_change, -0.33);
  assert.equal(reduced.roc_1mo, -1.99);
  assert.equal(reduced.roc_1yr, 10.3);
});

test('complete_readings counts FRAMES, not cells', () => {
  // There are three cells per frame, so summing the cells would make
  // complete_readings three times readings and the two columns would
  // not be comparable.
  const readings = [
    { sector: 'Energy', roc_1mo: 4.16, roc_complete: true, pct_change: -0.69, change_complete: true, roc_1yr: 4.88, roc1yr_complete: true, sign_source: 'colour', frame: frame(0), confidence: 70 },
    { sector: 'Energy', roc_1mo: 4.16, roc_complete: true, pct_change: -0.69, change_complete: true, roc_1yr: 4.88, roc1yr_complete: true, sign_source: 'colour', frame: frame(1), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.readings, 2);
  assert.equal(reduced.complete_readings, 2);
});

test('a frame with a truncated cell is not a complete frame', () => {
  const readings = [
    { sector: 'Energy', roc_1mo: 4.16, roc_complete: true, pct_change: -0.69, change_complete: true, roc_1yr: 4.88, roc1yr_complete: true, sign_source: 'colour', frame: frame(0), confidence: 70 },
    { sector: 'Energy', roc_1mo: 4, roc_complete: false, pct_change: -0.69, change_complete: true, roc_1yr: 4.88, roc1yr_complete: true, sign_source: 'colour', frame: frame(1), confidence: 70 },
  ];
  const reduced = reduceReadings(readings);
  assert.equal(reduced.readings, 2);
  assert.equal(reduced.complete_readings, 1);
});
