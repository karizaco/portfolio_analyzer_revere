'use strict';

// ──────────────────────────────────────────────────────────────────────────────
// CLINE DIAGNOSTIC TEST (do not merge)
// ──────────────────────────────────────────────────────────────────────────────
// Authored by Cline to probe behavior of helpers in src/video/ocrScanLogic.js
// that are NOT in Claude Code's in-flight chart-stream work:
//   - extractObservedDate
//   - inferDateKey
//   - formatDuration
//
// Prefix "cline_diagnostic_" makes this file trivial to identify and to delete
// before committing. Run with:
//   node --test test/extractObservedDate_cline_diagnostic.test.js
//
// Goal: characterize edge cases not currently covered by the existing
// test/ocrScanLogic.test.js so we know where to add coverage later.
// ──────────────────────────────────────────────────────────────────────────────

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');

const ocrScanLogic = require('../src/video/ocrScanLogic');

const {
  extractObservedDate,
  inferDateKey,
  formatDuration
} = ocrScanLogic;

// ─── extractObservedDate ─────────────────────────────────────────────────────

test('cline_diagnostic: extractObservedDate — long-form with all-caps weekday', () => {
  assert.equal(extractObservedDate('THURSDAY, SEPTEMBER 8, 2026'), '20260908');
});

test('cline_diagnostic: extractObservedDate — short form with three-letter weekday', () => {
  assert.equal(extractObservedDate('TUE, 11/15/22'), '20221115');
});

test('cline_diagnostic: extractObservedDate — short form with full 4-digit year', () => {
  assert.equal(extractObservedDate('WED, 12/31/2025'), '20251231');
});

test('cline_diagnostic: extractObservedDate — leading whitespace tolerant', () => {
  // The function is documented as operating on raw OCR text, so leading
  // whitespace and mixed-case should be tolerated by the regex.
  assert.equal(extractObservedDate('   thursday, september 8, 2026'), '20260908');
});

test('cline_diagnostic: extractObservedDate — garbage returns null', () => {
  assert.equal(extractObservedDate('NOT A DATE AT ALL'), null);
});

test('cline_diagnostic: extractObservedDate — empty / null / undefined → null', () => {
  assert.equal(extractObservedDate(''), null);
  assert.equal(extractObservedDate(null), null);
  assert.equal(extractObservedDate(undefined), null);
});

test('cline_diagnostic: extractObservedDate — invalid month/day gracefully returns null', () => {
  assert.equal(extractObservedDate('TUE, 13/45/22'), null);
});

test('cline_diagnostic: extractObservedDate — century cutoff ambiguous (year=69 → 2069)', () => {
  // The comment says: "< 70 → 2000+YY, ≥ 70 → 1900+YY". Verify behavior.
  // We don't have a great corpus example, so just probe both edges.
  // If this fails, the documented heuristic is wrong.
  const sixtyNine = extractObservedDate('TUE, 1/1/69');
  const seventy = extractObservedDate('TUE, 1/1/70');
  // Document current behavior so we know what to fix later.
  assert.ok(sixtyNine === '20690101' || sixtyNine === null,
    `expected 20690101 or null for year=69, got ${sixtyNine}`);
  assert.ok(seventy === '19700101' || seventy === null,
    `expected 19700101 or null for year=70, got ${seventy}`);
});

test('cline_diagnostic: extractObservedDate — picks the FIRST date when multiple are present', () => {
  // The function only returns the first match. Verify it picks the first.
  const text = 'WED, 12/31/2025 AND THU, 1/1/2026';
  assert.equal(extractObservedDate(text), '20251231');
});

// ─── inferDateKey ────────────────────────────────────────────────────────────

test('cline_diagnostic: inferDateKey — explicit YYYYMMDD wins', () => {
  const tmpFile = path.join(os.tmpdir(), 'fake_20200101.mp4');
  fs.writeFileSync(tmpFile, Buffer.alloc(16));
  try {
    // Even if the filename date disagrees, explicit date wins.
    assert.equal(inferDateKey(tmpFile, '20261225'), '20261225');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('cline_diagnostic: inferDateKey — filename date wins over mtime', () => {
  const tmpFile = path.join(os.tmpdir(), 'video_20240315_xyz.mp4');
  fs.writeFileSync(tmpFile, Buffer.alloc(16));
  // Set mtime to a year that disagrees with the filename.
  const mtime = new Date('1999-01-01T00:00:00Z');
  fs.utimesSync(tmpFile, mtime, mtime);
  try {
    assert.equal(inferDateKey(tmpFile), '20240315');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('cline_diagnostic: inferDateKey — falls back to mtime when filename has no date', () => {
  const tmpFile = path.join(os.tmpdir(), 'no_date_here.mp4');
  fs.writeFileSync(tmpFile, Buffer.alloc(16));
  const mtime = new Date('2026-07-04T12:00:00Z');
  fs.utimesSync(tmpFile, mtime, mtime);
  try {
    const result = inferDateKey(tmpFile);
    assert.ok(/^2026070[34]$/.test(result),
      `expected 20260703 or 20260704 (TZ), got ${result}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

test('cline_diagnostic: inferDateKey — invalid explicit date falls back to filename', () => {
  const tmpFile = path.join(os.tmpdir(), 'vid_20250101.mp4');
  fs.writeFileSync(tmpFile, Buffer.alloc(16));
  try {
    // "not-a-date" is not YYYYMMDD, so it should fall through.
    assert.equal(inferDateKey(tmpFile, 'not-a-date'), '20250101');
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

// ─── formatDuration ──────────────────────────────────────────────────────────

test('cline_diagnostic: formatDuration — basic seconds', () => {
  assert.equal(formatDuration(45), '00:00:45');
});

test('cline_diagnostic: formatDuration — crosses minute boundary', () => {
  assert.equal(formatDuration(125), '00:02:05');
});

test('cline_diagnostic: formatDuration — crosses hour boundary', () => {
  assert.equal(formatDuration(3725), '01:02:05');
});

test('cline_diagnostic: formatDuration — rounds fractional seconds', () => {
  assert.equal(formatDuration(59.6), '00:01:00');
  assert.equal(formatDuration(59.4), '00:00:59');
});

test('cline_diagnostic: formatDuration — zero, negative, NaN all return 00:00:00', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(-5), '00:00:00');
  assert.equal(formatDuration(NaN), '00:00:00');
  assert.equal(formatDuration(Infinity), '00:00:00');
});

test('cline_diagnostic: formatDuration — large value still right-padded', () => {
  // 25:00:00 = 90000 seconds. Verifies hour field isn't truncated.
  assert.equal(formatDuration(90000), '25:00:00');
});

// ─── sanity check: confirm we exported the helpers we expected ──────────────

test('cline_diagnostic: ocrScanLogic module exposes the three helpers', () => {
  assert.equal(typeof extractObservedDate, 'function');
  assert.equal(typeof inferDateKey, 'function');
  assert.equal(typeof formatDuration, 'function');
});

