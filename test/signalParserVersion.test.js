'use strict';

// The shared signal engine stamps a parser_version on every row, and the
// shared runner's PURGE deletes the rows written by a superseded version.
// So a row whose version is the engine's own constant instead of the
// caller's is a row the purge cannot see -- and, worse, a row that
// claims to have been produced by another source's vocabulary.
//
// It happened: the engine's constant said `sevcik-signals-N`, so every
// T3Live and Benzinga row was written under it. The T3Live corpus ended
// up labelled `sevcik-signals-6` on 6,953 rows.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { extractSignals, PARSER_VERSION } = require('../src/sevcik/signalExtractor');
const { loadSevcikLexicon } = require('../src/sevcik/lexicon');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = ['extractT3liveSignals', 'extractBenzingaSignals', 'extractSevcikSignals', 'extractAsymSignals'];

test('the engine stamps the CALLER\'S version, not its own', () => {
  const lexicon = loadSevcikLexicon();
  const segments = [
    { text: 'Nvidia NVDA is going up, I am buying NVDA here.', start: 0, end: 3 },
  ];
  const signals = extractSignals({
    segments,
    lexicon,
    confirmedSymbols: null,
    parserVersion: 'test-signals-9',
  });
  assert.ok(signals.length > 0, 'the synthetic segment produces a signal');
  for (const signal of signals) {
    assert.equal(signal.parser_version, 'test-signals-9');
  }
  // And without one, it falls back to the engine's own constant.
  const fallback = extractSignals({ segments, lexicon, confirmedSymbols: null });
  assert.ok(fallback.length > 0);
  for (const signal of fallback) {
    assert.equal(signal.parser_version, PARSER_VERSION);
  }
});

test('every extractor passes its own version into the engine', () => {
  for (const tool of TOOLS) {
    const source = fs.readFileSync(path.join(ROOT, 'tools', `${tool}.js`), 'utf8');
    const call = source.indexOf('extractSignals({');
    assert.ok(call !== -1, `${tool} calls extractSignals`);
    // The engine's options object must carry the version. The runner's
    // own options are a different object, and passing the version only
    // there is what the defect looked like.
    const body = source.slice(call, call + 600);
    assert.match(body, /parserVersion:\s*PARSER_VERSION/,
      `${tool} passes parserVersion into extractSignals`);
  }
});

test('the shipped catalog has no rows labelled with another source\'s version', () => {
  // A cheap guard on the artifact: a t3live row labelled `sevcik-signals`
  // is a row the purge cannot see.
  const dbPath = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
  if (!fs.existsSync(dbPath)) return; // a fresh clone has the catalog, but skip if absent
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT v.channel, s.parser_version, COUNT(*) n FROM trade_signals s
       JOIN videos v ON v.video_id = s.video_id
       GROUP BY 1, 2`,
    ).all().map((row) => ({ ...row }));
    for (const row of rows) {
      const prefix = row.parser_version.split('-').slice(0, 2).join('-');
      if (row.channel === 't3live') {
        assert.ok(prefix.startsWith('t3live'), `t3live rows labelled ${row.parser_version}`);
      } else if (row.channel === 'benzinga') {
        assert.ok(prefix.startsWith('benzinga'), `benzinga rows labelled ${row.parser_version}`);
      } else if (row.channel === 'davidsevcik') {
        assert.ok(prefix.startsWith('sevcik'), `sevcik rows labelled ${row.parser_version}`);
      } else if (row.channel === 'asymtrading') {
        assert.ok(prefix.startsWith('asym'), `asym rows labelled ${row.parser_version}`);
      }
    }
  } finally {
    db.close();
  }
});
