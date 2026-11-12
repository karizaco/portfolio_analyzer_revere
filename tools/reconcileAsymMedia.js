/**
 * Record the media that is already on disk.
 *
 * The media table is keyed by (video_id, kind), so a post can hold its video
 * AND its audio. It used to be keyed by video_id alone, so recording one
 * erased the other, and the rows that were lost are still missing even
 * though the FILES are still on disk. This reads the disk and writes those
 * rows back, so a file that has already been downloaded is not downloaded
 * again -- and so the local video becomes findable by the frame extractor,
 * which needs a `video` row to use it instead of a remote range request.
 *
 * Usage: node tools/reconcileAsymMedia.js [--dry-run]
 */
const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const { ensureAsymMediaSchema, reconcileLocalMedia } = require('../src/asym/mediaStore');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

function parseArgs(argv) {
  const options = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[asym-reconcile] no catalog at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, options.dryRun ? { readOnly: true } : {});
  if (!options.dryRun) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    ensureAsymMediaSchema(db);
  }

  const summary = reconcileLocalMedia(db, { dryRun: options.dryRun });
  console.log(JSON.stringify(summary, null, 2));
  if (!options.dryRun) db.close();
}

main();
