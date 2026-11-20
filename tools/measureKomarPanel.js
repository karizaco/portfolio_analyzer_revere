'use strict';

/**
 * Measure the Komar PANEL READER against the panels' own pixels.
 *
 * WHAT THIS IS
 *
 * The panel reader is the one Komar component that is not wired to a
 * writer, and the reason was that it had never been MEASURED: every
 * reading of it so far was reported by hand. This tool scores it
 * against pinned expectations -- the rows read off the frames' own
 * pixels -- so that a change to the reader moves a number instead of a
 * feeling.
 *
 *   node tools/measureKomarPanel.js
 *   node tools/measureKomarPanel.js --json
 *
 * THE TWO SETS
 *
 *   THE ERA FIXTURES (three frames, one per era) live in
 *   `test/fixtures/komar_panel/expectations.json`, with the reader's
 *   own diagnostics.
 *
 *   THE MEASUREMENT SET (twelve sessions, one per dated session,
 *   three resolutions, both layouts and both modes) lives in
 *   `test/fixtures/komar_panel/sessions.json` and
 *   `test/fixtures/komar_panel/sessions/`. This is the set that says
 *   whether the reader can be trusted with a position series.
 *
 * THE SCORE, and what it is worth
 *
 *   the symbols, IN ORDER -- the panel is a portfolio and a holding
 *     in the wrong place is a different claim about the same day;
 *   the symbols, FOUND -- a set score, which is the honest one for a
 *     reader that merges two rows: a missing first row shifts every
 *     row after it, and the set score says what was actually FOUND.
 *
 * TWO THINGS THE SCORE DOES NOT SAY, and both are measured:
 *
 *   1. **TESSERACT'S READING DEPENDS ON WHAT THE WORKER READ BEFORE
 *      IT.** The same region read twice in one process gave "nue" and
 *      "MU" for the same ticker (the 2026-04-25 frame). So a panel
 *      reading is a measurement of the pixels AND of the order they
 *      were read in, and a run that scores differently from the one
 *      recorded here is not necessarily a worse reader.
 *   2. **THE FRAMES ARE A SAMPLE.** One frame per session, and the
 *      sessions are chosen by the author (one per month of the
 *      archive), so a frame is a moment and not a distribution.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readKomarPanel } = require('../src/komar/panelReader');
const { loadKomarLexicon } = require('../src/komar/lexicon');
const { closeWorker } = require('../src/table/tableReader');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'komar_panel');
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
const expectations = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expectations.json'), 'utf8'));
const sessions = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sessions.json'), 'utf8'));
const sessionManifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sessions', 'manifest.json'), 'utf8'));
const lexicon = loadKomarLexicon();

const options = { json: process.argv.includes('--json') };

/**
 * Score one panel reading against its expectation.
 *
 * @param {object} expected - the rows, in order
 * @param {object[]} rows - the reader's rows
 * @returns {object} the score
 */
function score(expected, rows) {
  const symbols = rows.map((row) => row.symbol);
  const wanted = expected.map((row) => (typeof row === 'string' ? row : row.symbol));
  const inOrder = wanted.filter((symbol, index) => symbols[index] === symbol).length;
  const found = wanted.filter((symbol) => symbols.includes(symbol)).length;
  return {
    expected: wanted.length,
    found,
    in_order: inOrder,
    read: symbols.length,
  };
}

async function main() {
  const results = { eras: [], sessions: [] };
  let eraHits = 0;
  let eraTotal = 0;
  let eraFound = 0;
  let sessionHits = 0;
  let sessionTotal = 0;
  let sessionFound = 0;

  // THE ERA FIXTURES.
  for (const entry of manifest.files) {
    const expected = expectations.frames[entry.file];
    const result = await readKomarPanel(path.join(FIXTURES, entry.file), {
      dateKey: expected.session_date,
      lexicon,
      mode: expected.mode,
    });
    const scored = score(expected.rows, result.rows);
    eraHits += scored.in_order;
    eraFound += scored.found;
    eraTotal += scored.expected;
    results.eras.push({
      file: entry.file,
      ...scored,
      groups: result.groups.map((group) => group.group),
      notes: result.notes,
      read_symbols: result.rows.map((row) => row.symbol),
    });
    console.log(`${entry.file}: ${scored.in_order}/${scored.expected} in order, ${scored.found} found`);
  }

  // THE MEASUREMENT SET.
  for (const frame of sessionManifest.frames) {
    const key = `${frame.session_date}_r${frame.report_number}`;
    const expected = sessions.frames[key];
    if (!expected) continue;
    const result = await readKomarPanel(path.join(FIXTURES, 'sessions', frame.file), {
      dateKey: frame.session_date,
      lexicon,
      mode: expected.mode,
    });
    const scored = score(expected.rows, result.rows);
    sessionHits += scored.in_order;
    sessionFound += scored.found;
    sessionTotal += scored.expected;
    results.sessions.push({
      key,
      ...scored,
      expected_symbols: expected.rows,
      groups: result.groups.map((group) => group.group),
      notes: result.notes,
      read_symbols: result.rows.map((row) => row.symbol),
      size: `${frame.width}x${frame.height}`,
    });
    console.log(`${key}: ${scored.in_order}/${scored.expected} in order, ${scored.found} found `
      + `(${expected.mode}, ${expected.columns} columns, ${frame.width}x${frame.height})`);
  }

  const payload = {
    eras: {
      found: `${eraFound}/${eraTotal}`,
      in_order: `${eraHits}/${eraTotal}`,
      share: eraTotal ? Number((eraHits / eraTotal).toFixed(3)) : null,
    },
    results,
    sessions: {
      found: `${sessionFound}/${sessionTotal}`,
      in_order: `${sessionHits}/${sessionTotal}`,
      share: sessionTotal ? Number((sessionHits / sessionTotal).toFixed(3)) : null,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`\nTHE ERA FIXTURES: ${payload.eras.in_order} in order, ${payload.eras.found} found`);
    console.log(`THE MEASUREMENT SET: ${payload.sessions.in_order} in order, ${payload.sessions.found} found`);
  }

  await closeWorker();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
