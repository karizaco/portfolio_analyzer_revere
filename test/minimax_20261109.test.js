const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'tools', 'aggregateOcrTimeline.js');
const DATE_TAG = '20261109';

test('aggregateOcrTimeline writes output when the first requested tag is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-timeline-missing-first-'));
  const logsDirectory = path.join(
    root,
    'data',
    `video_scan_${DATE_TAG}`,
    'ocr-test',
    'ocr_probe',
    'logs'
  );
  fs.mkdirSync(logsDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(logsDirectory, '20261109_20261108_vidMISS01_1a2b3c4d_snapshot.json'),
    JSON.stringify({
      status: 'done',
      channel: 'revere',
      captures: []
    })
  );

  execFileSync(
    process.execPath,
    [SCRIPT, '--date-tag', DATE_TAG, 'missing,ocr-test'],
    { cwd: root, stdio: 'pipe' }
  );

  const outputPath = path.join(
    root,
    'data',
    `video_scan_${DATE_TAG}`,
    'missing',
    'timeline.json'
  );
  const timeline = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  assert.equal(timeline.totals.videos, 1);
  assert.deepEqual(timeline.run_tags, ['missing', 'ocr-test']);
});
