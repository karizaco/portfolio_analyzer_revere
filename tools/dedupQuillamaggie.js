'use strict';

/**
 * dedupQuillamaggie.js
 *
 * Cleans up qullamaggie video duplication between data/video_pipeline/downloads/
 * and data/video_pipeline/downloads_hires/.
 *
 * What it does:
 *  1. Finds qullamaggie MP4 files that exist in both directories (same basename).
 *  2. For each duplicate pair: keeps the larger file, deletes the smaller.
 *  3. Updates SQLite `download_path` for deleted rows to NULL (or the surviving path).
 *  4. Deletes the entire downloads_720p/ directory (all 6 files are qullamaggie dupes).
 *
 * Safe: SQLite is updated BEFORE files are deleted. Dry-run by default.
 * Usage:
 *   node tools/dedupQuillamaggie.js          # dry-run
 *   node tools/dedupQuillamaggie.js --execute  # actually delete
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', 'data', 'video_pipeline');
const DOWNLOADS = path.join(ROOT, 'downloads');
const HIRES = path.join(ROOT, 'downloads_hires');
const OLDDIR = path.join(ROOT, 'downloads_720p');
const DB = path.join(ROOT, 'state.sqlite');

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const PY = process.platform === 'win32' ? 'py' : 'python3';

function log(...a) { console.log('[dedup]', ...a); }
function warn(...a) { console.warn('[dedup] WARN:', ...a); }

function dirFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.mp4'));
  } catch { return []; }
}

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return -1; }
}

function sqliteQuery(sql) {
  const script = `import json, sqlite3
c = sqlite3.connect(r"${DB.replace(/\\\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute(${JSON.stringify(sql)}).fetchall()
out = [dict(r) for r in rows]
json.dump(out, sys.stdout)
`;
  const r = spawnSync(PY, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) { warn('SQLite error:', r.stderr); return []; }
  return JSON.parse(r.stdout);
}

function sqliteRun(sql, params) {
  const script = `import sqlite3
c = sqlite3.connect(r"${DB.replace(/\\\\/g, '/')}")
c.execute(${JSON.stringify(sql)}, ${JSON.stringify(params)})
c.commit()
`;
  const r = spawnSync(PY, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) warn('SQLite update failed:', r.stderr, r.stdout);
  return r;
}

log(`Mode: ${EXECUTE ? 'EXECUTE (will delete files)' : 'DRY-RUN (no files will be deleted)'}`);

// 1. Collect qullamaggie files from both directories
const dlFiles = new Map(dirFiles(DOWNLOADS).map(f => [f, path.join(DOWNLOADS, f)]));
const hiresFiles = new Map(dirFiles(HIRES).map(f => [f, path.join(HIRES, f)]));

// 2. Find basenames that appear in both (by upload_date + video_id)
const overlapped = [];
for (const [basename, dlPath] of dlFiles) {
  if (hiresFiles.has(basename)) {
    const dlSize = fileSize(dlPath);
    const hiPath = hiresFiles.get(basename);
    const hiSize = fileSize(hiPath);
    overlapped.push({ basename, dlPath, dlSize, hiPath, hiSize });
  }
}

log(`Found ${overlapped.length} duplicate qullamaggie MP4s across downloads/ and downloads_hires/`);

if (!overlapped.length) {
  log('Nothing to dedup.');
} else {
  for (const { basename, dlPath, dlSize, hiPath, hiSize } of overlapped) {
    const keep = dlSize >= hiSize ? { path: dlPath, size: dlSize, dir: 'downloads' }
                                  : { path: hiPath,  size: hiSize, dir: 'downloads_hires' };
    const del = dlSize < hiSize  ? { path: dlPath, size: dlSize, dir: 'downloads' }
                                  : { path: hiPath,  size: hiSize, dir: 'downloads_hires' };
    const reclaim = (del.size / 1024 / 1024).toFixed(1);
    log(`  ${basename}`);
    log(`    keep: ${keep.path} (${(keep.size / 1024 / 1024).toFixed(1)} MB, ${keep.dir})`);
    log(`    delete: ${del.path} (${reclaim} MB, ${del.dir})`);

    if (EXECUTE) {
      // Update SQLite: redirect download_path to the surviving copy (or NULL if
      // there is no surviving copy — video will be re-downloaded on next scan).
      const videoIdMatch = basename.match(/^(\d{8})_(.+)\.mp4$/);
      if (videoIdMatch) {
        const uploadDate = videoIdMatch[1];
        const videoId = videoIdMatch[2];
        const survivingPath = keep.path;
        const sql = `UPDATE videos SET download_path=?, status='scanning', error='' WHERE video_id=? AND upload_date=?`;
        log(`    updating SQLite: download_path=${survivingPath} for ${videoId}`);
        sqliteRun(sql, [survivingPath, videoId, uploadDate]);
      }
      try {
        fs.unlinkSync(del.path);
        log(`    DELETED ${del.path}`);
      } catch (e) {
        warn(`    FAILED to delete ${del.path}: ${e.message}`);
      }
    }
  }
}

const totalReclaim = overlapped.reduce((s, d) => s + Math.min(d.dlSize, d.hiSize), 0);
log(`Total reclaimable from duplicates: ${(totalReclaim / 1024 / 1024).toFixed(1)} MB`);

// 3. Delete downloads_720p/ if empty/already-superseded
if (fs.existsSync(OLDDIR)) {
  const oldFiles = dirFiles(OLDDIR);
  const oldSize = oldFiles.reduce((s, f) => s + fileSize(path.join(OLDDIR, f)), 0);
  log(`downloads_720p/: ${oldFiles.length} files, ${(oldSize / 1024 / 1024).toFixed(1)} MB`);
  if (EXECUTE) {
    for (const f of oldFiles) {
      const p = path.join(OLDDIR, f);
      // Check if a copy already exists in downloads/
      const inDl = path.join(DOWNLOADS, f);
      if (fs.existsSync(inDl)) {
        log(`  downloads_720p/${f} already in downloads/ — skipping individual delete`);
      } else {
        try { fs.unlinkSync(p); log(`  DELETED downloads_720p/${f}`); } catch (e) { warn(e.message); }
      }
    }
    // Remove the dir if empty
    try {
      const remaining = fs.readdirSync(OLDDIR);
      if (!remaining.length) { fs.rmdirSync(OLDDIR); log('  Removed downloads_720p/ directory'); }
      else log(`  downloads_720p/ still has files: ${remaining.join(', ')}`);
    } catch (e) { warn(e.message); }
  }
} else {
  log('downloads_720p/: not found (already gone)');
}

log('Done.');
