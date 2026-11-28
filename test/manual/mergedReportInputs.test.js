'use strict';

// What does each pipeline state's log actually carry?
//
// The video-level report scored the older runs at implausibly low recall
// (qmg-easyocr-20261020 at 0/27). Either those runs really were that
// bad, or the report is reading them wrong.
//
//   node --test test/manual/mergedReportInputs.test.js

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

const TAGS = [
  'qmg-easyocr-20261103-swallowed',
  'qmg-easyocr-20261103-corroborated',
  'qmg-easyocr-20261102-era-prefilter',
  'qmg-easyocr-20261020',
  'qmg-easyocr-20261018',
  'qmg-easyocr-20261017',
  'qmg-easyocr-20261012',
  'qmg-easyocr-20261011',
];

test('what each run\'s logs carry', () => {
  console.log('\n===== WHAT EACH RUN\'S LOGS CARRY =====\n');
  console.log('run                             logs  dates  merged>0  caps>0  crop recorded');
  console.log('-'.repeat(84));

  for (const tag of TAGS) {
    const dir = path.join(PROBE_ROOT, tag, 'ocr_probe', 'logs');
    if (!fs.existsSync(dir)) {
      console.log(`${tag.padEnd(32)} (no logs)`);
      continue;
    }
    let logs = 0; let dates = 0; let mergedNonEmpty = 0; let capsNonEmpty = 0; let crop = 0;
    const seen = new Set();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let log;
      try {
        log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      logs += 1;
      seen.add(log.date_key);
      if ((log.merged_position_list || []).length) mergedNonEmpty += 1;
      if ((log.captures || []).length) capsNonEmpty += 1;
      if (log.phash_region_fraction) crop += 1;
    }
    dates = seen.size;
    console.log(
      `${tag.padEnd(32)} ${String(logs).padStart(4)}  ${String(dates).padStart(5)}  `
      + `${String(mergedNonEmpty).padStart(9)}  ${String(capsNonEmpty).padStart(6)}  ${String(crop).padStart(6)}`
    );
  }
  console.log('');
});
