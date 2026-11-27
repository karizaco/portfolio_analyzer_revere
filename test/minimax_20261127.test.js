'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planWindows } = require('../src/x/windows');

test('planWindows rejects impossible calendar dates', () => {
  assert.throws(
    () => planWindows({ since: '2025-02-31', until: '2025-03-01' }),
    /not a date: 2025-02-31/,
  );
});

test('planWindows aligns week windows to Monday and clips the first window', () => {
  const windows = planWindows({
    since: '2025-01-03',
    until: '2025-01-24',
    unit: 'week',
  });

  assert.deepEqual(windows, [
    { start: '2025-01-20', end: '2025-01-24' },
    { start: '2025-01-13', end: '2025-01-20' },
    { start: '2025-01-06', end: '2025-01-13' },
    { start: '2025-01-03', end: '2025-01-06' },
  ]);
});
