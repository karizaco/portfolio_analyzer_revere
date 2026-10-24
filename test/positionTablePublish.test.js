'use strict';

// Tests for the positions-TABLE publication rules.
//
// WHY THESE TESTS EXIST
// The table reader and the legacy crop reader are two readers of the same
// thing, and the table reader only replaces the legacy one when it is
// confident. The branches that decide that — the take-over (the table
// reader found nothing) and the failure (the table reader threw) — are the
// ones a scan hits least often and the ones that silently cost holdings
// when they are wrong. In tools/scanVideoWithOcr.js they were inline
// conditionals that no test could reach.
//
// The rules are therefore pinned here as pure functions: a reading publishes
// holdings only when it was positively identified AND decoded something,
// and every other outcome hands the frame back to the legacy reader.
//
// These tests are pure — no OCR, no video.

const test = require('node:test');
const assert = require('node:assert/strict');

const { publishTableHoldings, readerForFrame } = require('../src/video/positionTablePublish');

function reading(overrides = {}) {
  return {
    found: true,
    verified: true,
    tickers: ['NRGU', 'DVN', 'MOS'],
    ...overrides,
  };
}

test('a positively identified table publishes its holdings', () => {
  const published = publishTableHoldings(reading());
  assert.deepEqual(published, ['NRGU', 'DVN', 'MOS']);
});

test('the published holdings are a copy, not the reading’s own array', () => {
  const table = reading();
  const published = publishTableHoldings(table);
  published.push('MUTATED');
  assert.deepEqual(table.tickers, ['NRGU', 'DVN', 'MOS'], 'the reading must not be mutated');
});

test('a table that was located but not verified publishes nothing', () => {
  // A lone untitled table could be the watchlist. It is located, but it is
  // not published.
  assert.equal(publishTableHoldings(reading({ verified: false })), null);
});

test('a table that decoded nothing publishes nothing', () => {
  // The table was identified, but there are no holdings in it.
  assert.equal(publishTableHoldings(reading({ tickers: [] })), null);
  assert.equal(publishTableHoldings(reading({ tickers: undefined })), null);
});

test('no table at all publishes nothing', () => {
  assert.equal(publishTableHoldings(null), null);
  assert.equal(publishTableHoldings(undefined), null);
  assert.equal(publishTableHoldings(reading({ found: false })), null);
});

test('a published table means the frame was read by the table reader', () => {
  assert.equal(readerForFrame({ table: reading() }), 'position_table');
});

test('a table that found nothing hands the frame back to the legacy reader', () => {
  const source = readerForFrame({ table: reading({ found: false }) });
  assert.equal(source, 'chart_stream', 'the legacy crop reader must take over');
});

test('a table that was not verified hands the frame back to the legacy reader', () => {
  const source = readerForFrame({ table: reading({ verified: false }) });
  assert.equal(source, 'chart_stream', 'the legacy crop reader must take over');
});

test('a table that decoded nothing hands the frame back to the legacy reader', () => {
  const source = readerForFrame({ table: reading({ tickers: [] }) });
  assert.equal(source, 'chart_stream', 'the legacy crop reader must take over');
});

test('a table reader that threw hands the frame back to the legacy reader', () => {
  // A failed table read is recorded as a reading with no holdings, so the
  // frame is not lost — it is read by the legacy crop reader instead.
  const failed = { found: false, verified: false, reason: 'error', error: 'boom' };
  const source = readerForFrame({ table: failed });
  assert.equal(source, 'chart_stream', 'a failed table read must not lose the frame');
});

test('a frame with no table reader is a legacy frame', () => {
  assert.equal(readerForFrame({ table: null }), 'chart_stream');
  assert.equal(readerForFrame({}), 'chart_stream');
});

test('the reader label only ever has two values', () => {
  // 'chart_stream' has always been the label for "not the table reader",
  // including on whiteboard scans, and the clusterer keys off it.
  const labels = new Set([
    readerForFrame({ table: reading() }),
    readerForFrame({ table: null }),
    readerForFrame({ table: reading({ verified: false }) }),
  ]);
  assert.deepEqual([...labels].sort(), ['chart_stream', 'position_table']);
});
