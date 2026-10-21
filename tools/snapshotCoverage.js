'use strict';

/**
 * How many distinct videos do the surviving snapshots actually cover?
 *
 * Counts snapshot files at OCR resolution (>=1280px wide) and maps them back
 * to video date-keys, then compares against the 718 videos the SQLite catalog
 * says should be on disk. This answers "do we need to re-download everything,
 * or only the videos with no usable snapshot?".
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
// Catalog dump produced by: python -c "... sqlite3 ... -> data/_catalog_snapshot.json"
const CATALOG = path.join(ROOT, 'data', '_catalog_snapshot.json');
const MIN_USABLE_WIDTH = 1280;

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
    if (['node_modules', '.git', '.claude'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'snapshots') {
      out.push(full);
      continue;
    }
    collectSnapshotDirs(full, out, depth + 1);
  }
  return out;
}

async function main() {
  const dirs = collectSnapshotDirs(DATA, [], 0);
  const usableByKey = new Map();   // dateKey -> count of usable snapshots
  const lowresByKey = new Map();   // dateKey -> count of low-res snapshots
  const perDirUsable = new Map();  // dir label -> count

  for (const dir of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
    } catch (_) {
      continue;
    }
    for (const file of files) {
      let width = 0;
      try {
        const meta = await sharp(path.join(dir, file)).metadata();
        width = meta.width || 0;
      } catch (_) {
        continue;
      }
      const m = file.match(/(\d{8})/);
      if (!m) continue;
      const key = m[1];
      const map = width >= MIN_USABLE_WIDTH ? usableByKey : lowresByKey;
      map.set(key, (map.get(key) || 0) + 1);
      if (width >= MIN_USABLE_WIDTH) {
        const label = path.relative(ROOT, dir).replace(/\\/g, '/');
        perDirUsable.set(label, (perDirUsable.get(label) || 0) + 1);
      }
    }
  }

  console.log('=== snapshot coverage by video ===');
  console.log('distinct date-keys with a USABLE (>=%dpx) snapshot: %d', MIN_USABLE_WIDTH, usableByKey.size);
  console.log('distinct date-keys with ONLY low-res snapshots:      %d', lowresByKey.size);
  console.log('total distinct date-keys seen in any snapshot:       %d',
    new Set([...usableByKey.keys(), ...lowresByKey.keys()]).size);

  const rows = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
    .filter((r) => r.download_path);

  const covered = [];
  const notCovered = [];
  for (const row of rows) {
    const key = (row.upload_date || '').replace(/-/g, '');
    if (usableByKey.has(key)) covered.push(row);
    else notCovered.push(row);
  }

  const byChannel = (arr) => {
    const out = {};
    for (const r of arr) out[r.channel] = (out[r.channel] || 0) + 1;
    return out;
  };

  console.log('\n=== vs the SQLite catalog (%d videos with a download_path) ===', rows.length);
  console.log('covered by a usable snapshot: %d  %s', covered.length, JSON.stringify(byChannel(covered)));
  console.log('NOT covered (need re-download): %d  %s', notCovered.length, JSON.stringify(byChannel(notCovered)));

  const multi = [...usableByKey.entries()].filter(([, n]) => n > 1).length;
  console.log('\ndate-keys with 2+ usable snapshots: %d', multi);

  console.log('\n=== per-directory usable snapshot counts ===');
  for (const [label, n] of [...perDirUsable.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('  %5d  %s', n, label);
  }

}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
