'use strict';

// What a stated trade becomes in the two tables. A review is not a call
// made that day, a plan has not happened, and a verb with no ticker is
// kept where it can be seen and left out of the ticker table.

const assert = require('node:assert/strict');
const test = require('node:test');

const { signalRows, tradesFromSegments } = require('../src/martinlukkt/signalRows');

const BOUGHT = [
  { start_sec: 2195, text: 'I bought' },
  { start_sec: 2200, text: 'ACHL would be the entry was' },
];

test('a buy with the ticker in the next segment is a forward long', () => {
  const rows = tradesFromSegments(BOUGHT, {
    title: 'Flipped long | 4 Nov 2026',
    video_id: 'NUT6d6Hvbmw',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, 'ACHL');
  assert.equal(rows[0].action, 'buy');
  assert.equal(rows[0].bias, 'bullish');
  assert.equal(rows[0].claim_kind, 'forward');
  assert.equal(rows[0].session_date, '20261104');
  assert.equal(rows[0].segment_index, 0);
  assert.equal(rows[0].transcript_id, null);
  assert.equal(signalRows(rows).length, 1);
});

test('a stated short is stored and is not a call that has happened', () => {
  const rows = tradesFromSegments(
    [{ start_sec: 10, text: "I'm going to short this one." }],
    { title: 'Memory shorts | 28 Oct 2026', video_id: 'x' },
  );
  assert.equal(rows[0].action, 'short');
  assert.equal(rows[0].claim_kind, 'plan');
  assert.equal(rows[0].ticker, '');
  assert.equal(signalRows(rows).length, 0);
});

test('a review stream is history, even when he says he bought', () => {
  const rows = tradesFromSegments(BOUGHT, {
    title: 'Oct trades | 25 Nov 2025',
    video_id: 'review',
  });
  assert.equal(rows[0].claim_kind, 'retrospective');
  assert.equal(rows[0].ticker, 'ACHL');
  assert.equal(rows[0].session_kind, 'review');
});
