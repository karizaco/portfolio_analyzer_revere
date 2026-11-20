'use strict';

/**
 * One crawler per X session.
 *
 * Two browser crawls on one account double the request rate X sees, and
 * the project's process guard cannot see Chromium at all (it only counts
 * node and python). So the crawler polices itself: a lock file holding the
 * owning pid. A second crawler is refused with that pid; a lock whose
 * process is gone is stale and is taken over.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCK = path.resolve(__dirname, '..', '..', 'data', 'x_pipeline', '.browser.lock');

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Take the lock.
 *
 * The file is created EXCLUSIVELY (`wx`), so two crawlers starting in
 * the same instant cannot both take it -- a check-then-write leaves a
 * window in which both pass the check and both write, which is exactly
 * the "two crawls on one account" case the lock exists to prevent.
 *
 * A lock whose holder is gone is STALE and is taken over; one whose
 * holder is alive refuses the second crawler and names the pid.
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {string} [options.label]
 * @returns {{release: Function, file: string}}
 */
function acquireLock(options = {}) {
  const file = options.file || DEFAULT_LOCK;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, label: options.label || '', started_at: new Date().toISOString() });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return heldLock(file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = readHolder(file);
      if (holder && holder.pid !== process.pid && isAlive(Number(holder.pid))) {
        const refused = new Error(`another X crawl is running (pid ${holder.pid}, ${holder.label || ''}, since ${holder.started_at}). `
          + 'Only one crawl per X session.');
        refused.code = 'locked';
        throw refused;
      }
      // Stale (the holder is gone) or our own: take it over.
      try { fs.rmSync(file, { force: true }); } catch (_) { /* gone already */ }
    }
  }
  throw new Error(`could not take the lock at ${file}`);
}

/**
 * The lock's current holder, or null when the file is unreadable.
 *
 * @param {string} file
 * @returns {object|null}
 */
function readHolder(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

/**
 * The lock this process holds: released on exit, and only by its owner.
 *
 * @param {string} file
 * @returns {{release: Function, file: string}}
 */
function heldLock(file) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (holder.pid === process.pid) fs.rmSync(file, { force: true });
    } catch (_) { /* gone already */ }
  };
  process.once('exit', release);
  return { release, file };
}

module.exports = { DEFAULT_LOCK, acquireLock, isAlive, readHolder };
