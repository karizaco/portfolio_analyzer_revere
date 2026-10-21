'use strict';

/**
 * Snapshot resolution census.
 *
 * Answers: are the surviving snapshots usable for OCR, or are they all
 * low-resolution prefilter sample frames?
 *
 * The chart-stream OCR crop is a fraction of the frame, so a 640x360
 * prefilter sample leaves a ~90x79px patch that OCRs to nothing. The
 * benchmark (test/qmgGroundTruth.test.js) therefore requires snapshots
 * at least MIN_SNAPSHOT_WIDTH (1280) wide.
 *
 * Output is aggregate only — it never lists individual image paths.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const MIN_USABLE_WIDTH = 1280;
const PREFILTER_WIDTH = 640;

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

function collectSnapshotDirs(dir, out, depth) {
  if (depth > 4) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'snapshots') {
      out.push(full);
      continue;
    }
    collectSnapshotDirs(full, out, depth + 1);
  }
  return out;
}

async function widthOf(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    return { width: meta.width || 0, height: meta.height || 0 };
  } catch (_) {
    return null;
  }
}

async function main() {
  const dirs = collectSnapshotDirs(DATA, [], 0);
  if (!dirs.length) {
    console.log('No snapshot directories found under data/');
    return;
  }

  const perDir = [];
  const widthHistogram = new Map();
  let total = 0;
  let usable = 0;
  let prefilter = 0;
  let unreadable = 0;

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
    } catch (_) {
      continue;
    }
    if (!files.length) continue;

    let dirUsable = 0;
    let dirPrefilter = 0;
    let dirOther = 0;
    const dirWidths = new Map();

    for (const file of files) {
      const info = await widthOf(path.join(dir, file));
      total++;
      if (!info || !info.width) {
        unreadable++;
        dirOther++;
        continue;
      }
      widthHistogram.set(info.width, (widthHistogram.get(info.width) || 0) + 1);
      dirWidths.set(info.width, (dirWidths.get(info.width) || 0) + 1);
      if (info.width >= MIN_USABLE_WIDTH) {
        usable++;
        dirUsable++;
      } else if (info.width <= PREFILTER_WIDTH + 32) {
        prefilter++;
        dirPrefilter++;
      } else {
        dirOther++;
      }
    }

    const label = path.relative(ROOT, dir).replace(/\\/g, '/');
    perDir.push({ label, files: files.length, dirUsable, dirPrefilter, dirOther, dirWidths });
  }

  console.log('=== snapshot resolution census ===');
  console.log('total snapshot images: %d', total);
  console.log('  usable (>=%dpx wide): %d', MIN_USABLE_WIDTH, usable);
  console.log('  prefilter-size (<=%dpx): %d', PREFILTER_WIDTH + 32, prefilter);
  console.log('  other/intermediate:   %d', total - usable - prefilter - unreadable);
  if (unreadable) console.log('  unreadable:           %d', unreadable);

  console.log('\n=== width histogram ===');
  const widths = [...widthHistogram.entries()].sort((a, b) => b[0] - a[0]);
  for (const [w, n] of widths) {
    const usable = w >= MIN_USABLE_WIDTH ? '  <-- USABLE for OCR' : (w <= PREFILTER_WIDTH + 32 ? '  (prefilter sample)' : '');
    console.log('  %5d px : %5d files%s', w, n, usable);
  }

  console.log('\n=== per snapshot directory ===');
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);
  console.log(`${pad('directory', 64)} ${rpad('files', 6)} ${rpad('usable', 6)} ${rpad('prefil', 6)} ${rpad('other', 6)}`);
  for (const d of perDir.sort((a, b) => b.files - a.files)) {
    console.log(
      `${pad(d.label.slice(0, 64), 64)} ${rpad(d.files, 6)} ${rpad(d.dirUsable, 6)} ${rpad(d.dirPrefilter, 6)} ${rpad(d.dirOther, 6)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
