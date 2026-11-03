'use strict';

// Build the VIDEO-level report: tools/qmg_merged_results.html.
//
// The capture-level page (tools/qmg_ocr_results.html, built by
// data/compile_results.js) reports one row per captured FRAME. Production
// publishes `merged_position_list` -- the VIDEO-level consensus -- and the
// two disagree in ways only the video level can show.
//
// The builder is run as a CHILD here rather than inlined, so the report is
// built by exactly the code that ships, and a failure in it fails the test
// rather than passing silently.
//
//   node --test test/manual/buildMergedReport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BUILDER = path.join(ROOT, 'data', 'buildQmgMergedReport.js');
const OUTPUT = path.join(ROOT, 'tools', 'qmg_merged_results.html');

test('the video-level report is built', () => {
  const res = spawnSync('node', [BUILDER], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(res.status, 0, `the builder ran:\n${res.stdout}\n${res.stderr}`);
  console.log(res.stdout);

  assert.ok(fs.existsSync(OUTPUT), 'the report exists');
  const html = fs.readFileSync(OUTPUT, 'utf8');

  // It has to be a real report, not an empty shell.
  assert.ok(html.includes('QMG merged results'), 'the title is there');
  assert.ok(html.includes('merged_position_list'), 'it names the artifact it reports');
  assert.ok(html.includes('qmg_ocr_results.html'), 'it links the capture-level page');
  assert.ok(!html.includes('undefined'), 'no undefined leaked into the page');
  assert.ok(!html.includes('NaN'), 'no NaN leaked into the page');

  // At least one date must be scored -- an empty table would be a silent
  // failure of the ground-truth lookup.
  const dates = (html.match(/<td class="mono">\d{8}<\/td>/g) || []).length;
  assert.ok(dates > 0, `the report scores at least one date (${dates})`);
});
