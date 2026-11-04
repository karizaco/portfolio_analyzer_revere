'use strict';

// Load the repository's .env file into process.env.
//
// WHY THIS EXISTS
//
// The pipeline needs two credentials that must not be in git:
//
//   DEEPGRAM_API_KEY   transcribes the caption-less videos
//   YOUTUBE_COOKIES    a cookie file, for a throttled YouTube session
//
// A key in a tracked file is a key in git history, and this repository is
// pushed to GitHub. So the value lives in `.env`, which is gitignored,
// and this loader reads it.
//
// WHY NOT THE `dotenv` PACKAGE
//
// It is a dependency for one file with a dozen lines in it, and the
// project's dependency list is deliberately short (sharp, tesseract.js).
// The format this reads is the simplest possible: `KEY=value`, one per
// line, `#` for a comment. That is enough and it cannot drift.
//
// THE RULES
//
//   * A value that is ALREADY in process.env WINS. The environment is the
//     explicit answer, and a .env file is the fallback.
//   * A key whose value is quoted has the quotes stripped, so a value
//     with a `#` or a space in it survives.
//   * Nothing is logged. This file never prints what it read.
//
// Usage:
//   require('./loadEnv')();          // from the repository root
//   require('../src/transcript/loadEnv')();

const fs = require('node:fs');
const path = require('node:path');

/**
 * Read the .env file and apply it to process.env.
 *
 * @param {object} [options]
 * @param {string} [options.path] - the .env file to read
 * @param {boolean} [options.override] - overwrite values already set
 * @returns {string[]} the keys that were applied
 */
function loadEnv(options = {}) {
  const envPath = options.path || path.resolve(__dirname, '..', '..', '.env');

  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    // No .env file is the normal case on a fresh clone, and it is not an
    // error: every credential has a documented alternative.
    return [];
  }

  const applied = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(separator + 1).trim();

    // Strip a matched pair of quotes, so a value may contain spaces and
    // a '#' without being cut short.
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      // An unquoted value ends at an inline comment.
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }

    // The environment wins: it is the explicit answer.
    if (!options.override && process.env[key]) continue;

    process.env[key] = value;
    applied.push(key);
  }

  return applied;
}

module.exports = { loadEnv };
