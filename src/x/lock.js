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
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {string} [options.label]
 * @returns {{release: Function, file: string}}
 */
function acquireLock(options = {}) {
  const file = options.file || DEFAULT_LOCK;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { holder = null; }
    if (holder && holder.pid !== process.pid && isAlive(Number(holder.pid))) {
      const error = new Error(`another X crawl is running (pid ${holder.pid}, ${holder.label || ''}, since ${holder.started_at}). `
        + 'Only one crawl per X session.');
      error.code = 'locked';
      throw error;
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, label: options.label || '', started_at: new Date().toISOString() }));
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

module.exports = { DEFAULT_LOCK, acquireLock, isAlive };
