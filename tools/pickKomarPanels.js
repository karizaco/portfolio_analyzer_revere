'use strict';

/**
 * Pick ONE panel frame per session and cut it into readable strips.
 *
 * The measurement set is one frame per dated session -- 29 of them,
 * spanning 19 months and two applications -- so the reader is scored
 * on the corpus and not on one lucky frame. The frame picked for a
 * session is the MIDDLE of its detected frames, which is the most
 * stable moment of the panel.
 *
 *   node tools/pickKomarPanels.js
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { panelRegionForFrame } = require('../src/komar/panelLayout');

const ROOT = path.resolve(__dirname, '..');
const PANELS = path.join(ROOT, 'data', 'komar_work', 'panels');
const STRIPS = path.join(ROOT, 'data', 'komar_work', 'panel_strips');

/** The upscale a strip is read at. */
const SCALE = 4;

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PANELS, 'manifest.json'), 'utf8'));
  const bySession = new Map();
  for (const entry of manifest) {
    if (!bySession.has(entry.session_date)) bySession.set(entry.session_date, []);
    bySession.get(entry.session_date).push(entry);
  }

  fs.mkdirSync(STRIPS, { recursive: true });
  const picked = [];
  for (const [date, entries] of [...bySession.entries()].sort()) {
    entries.sort((a, b) => a.at_sec - b.at_sec);
    const entry = entries[Math.floor(entries.length / 2)];
    const framePath = path.join(PANELS, entry.frame);
    // The panel's region is a FRACTION of the frame, so the crop is
    // computed from the frame's own size -- the corpus's videos are
    // 1920x1080 and 1280x720, and a fixed crop is out of bounds on
    // one of them.
    const region = panelRegionForFrame('20260101', { height: entry.height, width: entry.width });
    const out = path.join(STRIPS, `${date}_r${entry.report_number}_01.png`);
    sharp(framePath)
      .extract({
        height: region.height,
        left: region.left,
        top: region.top,
        width: region.width,
      })
      .resize({ kernel: 'lanczos3', width: region.width * SCALE })
      .png()
      .toFile(out)
      .then(() => {
        picked.push({
          frames: entries.length,
          report_number: entry.report_number,
          session_date: date,
          at_sec: entry.at_sec,
          source: entry.frame,
          size: `${entry.width}x${entry.height}`,
          strip: path.basename(out),
          title: entry.title,
        });
        console.log(`${date} r${entry.report_number}: ${entries.length} frames, the middle one at ${entry.at_sec}s `
          + `(${entry.width}x${entry.height}) -> ${path.basename(out)}`);
      })
      .catch((error) => {
        console.log(`${date} r${entry.report_number}: ${error.message}`);
      });
  }
  setTimeout(() => {
    fs.writeFileSync(path.join(STRIPS, 'picked.json'), `${JSON.stringify(picked, null, 2)}\n`, 'utf8');
    console.log(`\n${picked.length} sessions -> ${STRIPS}`);
  }, 2000);
}

main();
