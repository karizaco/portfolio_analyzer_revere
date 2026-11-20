'use strict';

/**
 * Pin the PANEL MEASUREMENT SET: the twelve frames of the corpus's
 * dated sessions.
 *
 * The frames are copied out of the working folder and into the
 * fixtures, with a manifest that says where each came from -- so the
 * measurement is reproducible on a fresh clone, which is the lesson
 * the QMG benchmark learned the hard way.
 *
 *   node tools/pinKomarPanels.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const PANELS = path.join(ROOT, 'data', 'komar_work', 'panels');
const OUT = path.join(ROOT, 'test', 'fixtures', 'komar_panel', 'sessions');

/** The sessions the measurement set covers. */
const WANTED = [
  '20221119_r43', '20230108_r50', '20230529_r70', '20231106_r94',
  '20240120_r105', '20240703_r129', '20250201_r160', '20250405_r169',
  '20250824_r189', '20251005_r195', '20251019_r197', '20260509_r226',
];

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(PANELS, 'manifest.json'), 'utf8'));
  const byKey = new Map();
  for (const entry of manifest) {
    const key = `${entry.session_date}_r${entry.report_number}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }
  // The frame that was READ is the MIDDLE of the session's detected
  // frames (the picker's rule), so the pinned frame and the expectation
  // are the same moment.
  const pickedPath = path.join(ROOT, 'data', 'komar_work', 'panel_strips', 'picked.json');
  const picked = fs.existsSync(pickedPath) ? JSON.parse(fs.readFileSync(pickedPath, 'utf8')) : [];

  const pinned = [];
  for (const key of WANTED) {
    const entries = byKey.get(key) || [];
    if (!entries.length) {
      console.log(`${key}: not in the extracted frames`);
      continue;
    }
    const chosen = picked.find((entry) => (
      `${entry.session_date}_r${entry.report_number}` === key
    ));
    const entry = chosen
      ? entries.find((candidate) => candidate.at_sec === chosen.at_sec) || entries[0]
      : entries[Math.floor(entries.length / 2)];
    const source = path.join(PANELS, entry.frame);
    const target = path.join(OUT, `${key}.png`);
    fs.copyFileSync(source, target);
    const bytes = fs.readFileSync(target);
    pinned.push({
      at_sec: entry.at_sec,
      file: `${key}.png`,
      height: entry.height,
      md5: crypto.createHash('md5').update(bytes).digest('hex'),
      report_number: entry.report_number,
      session_date: entry.session_date,
      title: entry.title,
      width: entry.width,
    });
    console.log(`${key}: ${entry.width}x${entry.height} at ${entry.at_sec}s -> ${path.basename(target)}`);
  }

  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    `${JSON.stringify({
      note: 'The twelve frames of the panel measurement set, one per dated session. The rows they show are in `../sessions.json`, read off the frames by eye.',
      frames: pinned,
    }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n${pinned.length} frames -> ${OUT}`);
}

main();
