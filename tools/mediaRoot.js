'use strict';

/**
 * Where the re-downloaded videos live.
 *
 * The media is ~237 GB, so it does NOT live inside the git working tree — a
 * `git sparse-checkout` or `git clean` must never be able to reach it. It
 * also does not live on C:, which is at 99% capacity: on 2026-11-26 it was
 * moved to D:, which has 1.4 TB free.
 *
 * Every tool that touches the media resolves its root through this module so
 * that a future move is a one-line change here, not an edit in nine files.
 *
 * Resolution order:
 *   1. an explicit `--media-root` / `--dl-dir` flag
 *   2. the MEDIA_ROOT environment variable
 *   3. DEFAULT_MEDIA_ROOT below
 */

const path = require('node:path');

/** The canonical media root. Outside the git tree, on a drive with room. */
const DEFAULT_MEDIA_ROOT = 'D:/projects/portfolio_analyzer_revere_media';

/**
 * @param {string} [flagValue] the value of a --media-root / --dl-dir flag
 * @returns {string} the absolute media root
 */
function mediaRoot(flagValue) {
  const chosen = flagValue || process.env.MEDIA_ROOT || DEFAULT_MEDIA_ROOT;
  return path.resolve(chosen);
}

module.exports = { DEFAULT_MEDIA_ROOT, mediaRoot };
