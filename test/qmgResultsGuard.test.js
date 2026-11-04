'use strict';

// A results file that cannot be parsed is not an empty run.
//
// The daemons used to catch that error and start over, then write the new
// (empty, then partial) results over the file. A truncated write — the
// process was killed mid-save — is exactly the file that fails to parse, and
// it is the only copy of the previous run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readExistingJson, writeResults } = require('../tools/qmg_scan_daemon_support');
const { timeoutMsForEngine } = require('../tools/scanAllGtVideos');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-guard-'));
}

test('a missing results file is a fresh run', () => {
  assert.equal(readExistingJson(path.join(scratch(), 'nope.json')), null);
});

test('a corrupt results file is refused, not treated as empty', () => {
  const file = path.join(scratch(), 'results.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => readExistingJson(file), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
});

test('merge mode does not overwrite an unreadable results file', () => {
  const file = path.join(scratch(), 'results.json');
  fs.writeFileSync(file, '{truncated');
  assert.throws(() => writeResults(file, { results: [{ videoId: 'a', status: 'ok' }] }, {
    keyOf: (row) => row.videoId,
    scored: (row) => (row.status === 'ok' ? 1 : 0),
    mode: 'merge',
  }), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{truncated');
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('the EasyOCR sweep timeout is the batch budget, not the 300s kill', () => {
  assert.equal(timeoutMsForEngine('easyocr'), 40 * 60 * 1000);
  assert.equal(timeoutMsForEngine('tesseract'), 300 * 1000);
  assert.equal(timeoutMsForEngine('TESSERACT'), 300 * 1000);
});
