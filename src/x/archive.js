'use strict';

/**
 * The X post ARCHIVE: the record of what was fetched.
 *
 *   data/x_pipeline/archive/<user_id>/<YYYY>/<YYYY-MM>.jsonl
 *
 * WHY IT IS TRACKED
 *
 * A fetched post is not cheap to fetch again: the API charges per post, the
 * browser route costs time and account risk, and an author can delete a post
 * at any time. So the canonical records are committed, like the transcript
 * JSON is -- and the untracked SQLite index (src/x/indexStore.js) is rebuilt
 * from here.
 *
 * WHY IT IS DETERMINISTIC
 *
 * One post per line, in canonical key order, sorted by id (numerically),
 * months bucketed in UTC. Re-importing the same data rewrites NOTHING, so
 * `git diff` after a re-crawl shows exactly the posts that changed. The
 * volatile numbers (likes, views) are not in the lines except for the first
 * observation, which is written once (src/x/postRecord.js, rule 4).
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonicalize, compareIds } = require('./postRecord');
const { mergeRecords } = require('./merge');
const { toPortableArtifactPath } = require('../video/portablePaths');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ARCHIVE_ROOT = path.join(ROOT, 'data', 'x_pipeline', 'archive');

/**
 * A path as it is STORED: relative to the repository root when it is
 * inside the repository, absolute when it is outside.
 *
 * The repository's rule, and its own helper -- a path outside the
 * repository has no honest relative form, and `path.relative` would
 * produce a `../..` chain that resolves nowhere on another machine.
 *
 * @param {string} file
 * @returns {string}
 */
function portablePath(file) {
  return toPortableArtifactPath(file, { repoRoot: ROOT });
}

/**
 * The file a record belongs in.
 *
 * @param {string} archiveRoot
 * @param {object} record
 * @returns {string}
 */
function archivePathFor(archiveRoot, record) {
  const iso = String(record.created_at || '');
  const year = iso.slice(0, 4);
  const month = iso.slice(0, 7);
  if (!/^\d{4}$/.test(year) || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`record ${record.post_id} has no usable created_at: ${iso}`);
  }
  return path.join(archiveRoot, String(record.user_id), year, `${month}.jsonl`);
}

/**
 * Read one month file.
 *
 * A CORRUPT LINE IS SKIPPED, not thrown.
 *
 * The archive is the record -- a fetched post cannot be re-fetched cheaply
 * (the API charges for it) and the author can delete it -- so one bad line
 * must not make the whole archive unreadable. The line is reported, and
 * the file is NOT rewritten while it holds one: rewriting it would drop
 * the bad line and with it whatever that line said.
 *
 * @param {string} file
 * @returns {{records: Map<string, object>, corrupt: Array<{line: number, text: string, error: string}>}}
 */
function readMonthFile(file) {
  const out = new Map();
  const corrupt = [];
  if (!fs.existsSync(file)) return { records: out, corrupt };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      corrupt.push({ line: index + 1, text: line.slice(0, 200), error: error.message });
      return;
    }
    out.set(String(record.post_id), record);
  });
  return { records: out, corrupt };
}

/**
 * Serialize a month: sorted by id, one canonical record per line.
 *
 * @param {Map<string, object>} records
 * @returns {string}
 */
function serializeMonth(records) {
  const ids = [...records.keys()].sort(compareIds);
  return ids.map((id) => JSON.stringify(canonicalize(records.get(id)))).join('\n') + (ids.length ? '\n' : '');
}

/**
 * Write records into the archive, merging with what is there.
 *
 * A file is written only when its content changes, and it is written
 * ATOMICALLY: to a sibling `.tmp` file, then renamed over the original.
 * A plain write that is interrupted half-way leaves a truncated month
 * file, and the archive is the one thing here that cannot be re-fetched.
 *
 * @param {Array<object>} records - canonical, validated
 * @param {object} [options]
 * @param {string} [options.archiveRoot]
 * @returns {{filesWritten: number, filesUnchanged: number, postsNew: number,
 *            postsUpdated: number, postsUnchanged: number,
 *            corruptFiles: Array<{file: string, lines: number[]}>,
 *            results: Array<{post_id: string, status: string, archive_path: string, record: object}>}}
 */
function writeToArchive(records, options = {}) {
  const archiveRoot = options.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  const byFile = new Map();
  for (const record of records) {
    const file = archivePathFor(archiveRoot, record);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(record);
  }

  const stats = {
    filesWritten: 0, filesUnchanged: 0, postsNew: 0, postsUpdated: 0, postsUnchanged: 0,
    corruptFiles: [], results: [],
  };
  for (const [file, incoming] of byFile) {
    const { records: month, corrupt } = readMonthFile(file);
    if (corrupt.length) {
      // The file is left exactly as it is: rewriting it would drop the
      // corrupt line, and that line is evidence.
      stats.corruptFiles.push({ file: portablePath(file), lines: corrupt.map((item) => item.line) });
      for (const record of incoming) {
        stats.results.push({
          post_id: record.post_id,
          status: 'skipped_corrupt',
          archive_path: portablePath(file),
          record,
        });
      }
      continue;
    }
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    for (const record of incoming) {
      const existing = month.get(record.post_id) || null;
      const { record: merged, changed } = mergeRecords(existing, record);
      month.set(record.post_id, merged);
      const status = !existing ? 'new' : (changed ? 'updated' : 'unchanged');
      if (status === 'new') stats.postsNew += 1;
      else if (status === 'updated') stats.postsUpdated += 1;
      else stats.postsUnchanged += 1;
      stats.results.push({
        post_id: record.post_id,
        status,
        archive_path: portablePath(file),
        record: merged,
      });
    }
    const after = serializeMonth(month);
    if (after !== before) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Atomic: a half-written month file would make the archive
      // unreadable, and it cannot be re-fetched.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, after, 'utf8');
      fs.renameSync(tmp, file);
      stats.filesWritten += 1;
    } else {
      stats.filesUnchanged += 1;
    }
  }
  return stats;
}

/**
 * Every archived record, optionally for one user.
 *
 * @param {object} [options]
 * @param {string} [options.archiveRoot]
 * @param {string} [options.userId]
 * @returns {Generator<{record: object, archive_path: string}>}
 */
function* iterateArchive(options = {}) {
  const archiveRoot = options.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  if (!fs.existsSync(archiveRoot)) return;
  const users = options.userId ? [String(options.userId)] : fs.readdirSync(archiveRoot).filter((name) => /^\d+$/.test(name));
  for (const user of users.sort()) {
    const userDir = path.join(archiveRoot, user);
    if (!fs.existsSync(userDir)) continue;
    for (const year of fs.readdirSync(userDir).filter((name) => /^\d{4}$/.test(name)).sort()) {
      const yearDir = path.join(userDir, year);
      for (const file of fs.readdirSync(yearDir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort()) {
        const full = path.join(yearDir, file);
        const relative = portablePath(full);
        for (const record of readMonthFile(full).records.values()) yield { record, archive_path: relative };
      }
    }
  }
}

module.exports = {
  DEFAULT_ARCHIVE_ROOT,
  archivePathFor,
  iterateArchive,
  portablePath,
  readMonthFile,
  serializeMonth,
  writeToArchive,
};
