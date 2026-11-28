'use strict';

// Tests for the character-level OCR confusion matrix and the tool that
// learns it.
//
// WHY THESE TESTS EXIST
// The matrix used to ship INVERTED: the file said "true,observed" while
// src/normalize/tickerDecode.js reads "from,to" as read,true. A matrix
// written the other way round is not merely mislabelled — it teaches the
// decoder that the WRONG substitution is the cheap one, so the decoder
// could not repair the very misread the matrix was built for. Nothing
// caught it because no test read the shipped file.
//
// The orientation is therefore pinned twice over:
//   - by asserting the SHIPPED file repairs the documented misread, and
//   - by round-tripping the learner: whatever the learner writes must be
//     readable by the loader in the same sense. That round-trip is the
//     invariant that was broken, and it is the one that cannot rot.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCharConfusion,
  clearCharConfusionCache,
  decodeCell,
  DEFAULT_MAX_COST,
} = require('../src/normalize/tickerDecode');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');
const { parseArgs } = require('../tools/learnCharConfusion');

const ROOT = path.resolve(__dirname, '..');
const SHIPPED = path.join(ROOT, 'config', 'ticker_char_confusion.csv');
const LEARNER = path.join(ROOT, 'tools', 'learnCharConfusion.js');

/** The data rows of a confusion-matrix CSV, as {from, to, count}. */
function dataRows(csvPath) {
  return fs.readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [from, to, count] = l.split(',').map((p) => p.trim());
      return { from, to, count: Number(count) };
    });
}

/** A corpus whose rows pair with the truth, with the given reads. */
function corpusWith(entries) {
  return { generatedBy: 'test', note: 'synthetic', entries };
}

function entryWith(rows, alignment = {}) {
  return {
    date: '20220606',
    capture: '1',
    alignment: {
      meanCost: 0.3,
      exact: rows.filter((r) => r.hypotheses.some((h) => h.text === r.truth)).length,
      paired: rows.length,
      truthCount: rows.length,
      ordered: rows.length,
      ...alignment,
    },
    rows: rows.map((r, i) => ({ index: i, truth: r.truth, pairCost: null, hypotheses: r.hypotheses })),
    truth: rows.map((r) => r.truth),
  };
}

function runLearner(corpusPath, outPath, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [LEARNER, '--corpus', corpusPath, '--out', outPath, ...extraArgs],
    { encoding: 'utf8' }
  );
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

test('the shipped confusion matrix has data rows', () => {
  const rows = dataRows(SHIPPED);
  assert.ok(rows.length > 0, 'the shipped matrix must not be empty');
  for (const r of rows) {
    assert.equal(r.from.length, 1, `from must be one character: ${r.from}`);
    assert.equal(r.to.length, 1, `to must be one character: ${r.to}`);
    assert.ok(Number.isFinite(r.count) && r.count > 0, `count must be positive: ${r.from}>${r.to}`);
  }
});

test('the shipped confusion matrix is oriented read -> true', () => {
  clearCharConfusionCache();
  const model = loadCharConfusion(SHIPPED);
  // The documented misreads: the READ shows the first character, the TRUTH
  // has the second. TQQQ is read as TOCQ, so the read shows O and C.
  assert.equal(model.pairs.get('O>Q'), 4, 'O read where Q was true');
  assert.equal(model.pairs.get('C>Q'), 2, 'C read where Q was true');
  assert.equal(model.pairs.get('U>L'), 2, 'U read where L was true');
  // The inverse must be absent — an inverted matrix teaches the decoder
  // that the wrong substitution is the cheap one.
  assert.equal(model.pairs.get('Q>O'), undefined, 'the inverse must not be present');
  assert.equal(model.pairs.get('L>U'), undefined, 'the inverse must not be present');
});

test('the shipped confusion matrix repairs the misread it was built for', () => {
  clearCharConfusionCache();
  const lexicon = loadDecodeLexiconSync();
  const decoded = decodeCell([{ text: 'TOCQ', conf: 0.8 }], { lexicon });
  assert.ok(decoded, 'TOCQ must decode');
  assert.equal(decoded.ticker, 'TQQQ');
  assert.ok(decoded.cost <= DEFAULT_MAX_COST, `cost ${decoded.cost} must be within the threshold`);
});

test('the shipped confusion matrix states its orientation in the header', () => {
  const header = fs.readFileSync(SHIPPED, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('#'))
    .join('\n');
  assert.match(header, /from,to,count/);
  assert.match(header, /READ/i, 'the header must say which end is the read');
  assert.match(header, /TRUTH|true/i, 'the header must say which end is the truth');
});

test('the learner writes in the orientation the loader reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-confusion-'));
  const corpusPath = path.join(dir, 'corpus.json');
  const outPath = path.join(dir, 'learned.csv');
  fs.writeFileSync(corpusPath, JSON.stringify(corpusWith([
    entryWith([
      { truth: 'COPX', hypotheses: [{ text: 'COPX', conf: 0.9 }] },
      { truth: 'TQQQ', hypotheses: [{ text: 'TOCQ', conf: 0.8 }] },
    ]),
  ])));

  const run = runLearner(corpusPath, outPath);
  assert.equal(run.status, 0, `the learner failed: ${run.stderr}`);

  // What the learner wrote must be readable in the same sense: the read
  // shows O, the truth has Q.
  clearCharConfusionCache();
  const model = loadCharConfusion(outPath);
  assert.equal(model.pairs.get('O>Q'), 1, 'the learner must write read -> true');
  assert.equal(model.pairs.get('Q>O'), undefined, 'the learner must not write true -> read');
});

test('the learner refuses to replace a non-empty matrix with an empty one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-confusion-'));
  const corpusPath = path.join(dir, 'corpus.json');
  const outPath = path.join(dir, 'existing.csv');
  // A corpus whose reads are all exact: usable, but it teaches nothing.
  fs.writeFileSync(corpusPath, JSON.stringify(corpusWith([
    entryWith([{ truth: 'COPX', hypotheses: [{ text: 'COPX', conf: 0.9 }] }]),
  ])));
  const before = 'O,Q,4\nI,T,3\n';
  fs.writeFileSync(outPath, before);

  const run = runLearner(corpusPath, outPath);
  assert.notEqual(run.status, 0, 'the learner must refuse');
  assert.match(run.stderr, /empty matrix/i);
  assert.equal(fs.readFileSync(outPath, 'utf8'), before, 'the existing matrix must be untouched');
});

test('the learner refuses to write when the corpus is unusable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-confusion-'));
  const corpusPath = path.join(dir, 'corpus.json');
  const outPath = path.join(dir, 'existing.csv');
  fs.writeFileSync(corpusPath, JSON.stringify(corpusWith([])));
  const before = 'O,Q,4\nI,T,3\n';
  fs.writeFileSync(outPath, before);

  const run = runLearner(corpusPath, outPath);
  assert.notEqual(run.status, 0, 'the learner must refuse');
  assert.match(run.stderr, /refusing to write/i);
  assert.equal(fs.readFileSync(outPath, 'utf8'), before, 'the existing matrix must be untouched');
});

test('the learner still writes an empty matrix to a fresh path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmg-confusion-'));
  const corpusPath = path.join(dir, 'corpus.json');
  const outPath = path.join(dir, 'fresh.csv');
  fs.writeFileSync(corpusPath, JSON.stringify(corpusWith([
    entryWith([{ truth: 'COPX', hypotheses: [{ text: 'COPX', conf: 0.9 }] }]),
  ])));

  const run = runLearner(corpusPath, outPath);
  assert.equal(run.status, 0, `the learner failed: ${run.stderr}`);
  assert.equal(dataRows(outPath).length, 0, 'nothing was learned, so there are no data rows');
});

test('the learner defaults to the tracked matrix, which is why it must not clobber it', () => {
  const args = parseArgs(['node', 'tools/learnCharConfusion.js']);
  assert.equal(args.out, SHIPPED, 'the default output is the tracked matrix');
  assert.equal(args.corpus, path.join(ROOT, 'data', 'qmg_position_corpus.json'));
});
