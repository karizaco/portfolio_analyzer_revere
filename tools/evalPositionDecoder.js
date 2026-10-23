'use strict';

// Score the position-list DECODER against the labelled corpus.
//
// WHAT THIS MEASURES
// The corpus (tools/buildPositionCorpus.js) holds, for every labelled frame,
// the rows of the positions table, the ground truth for each row, and every
// raw read the recogniser produced for it. This tool replays those reads
// through three decoders and reports recall and precision for each:
//
//   raw        the recogniser's own output — the baseline to beat
//   decoded    the lexicon-constrained decoder, with NO confusion model
//   learned    the decoder plus the character-level matrix learned by
//              tools/learnCharConfusion.js
//
// "raw" is scored as: a GT ticker is recovered when some hypothesis reads it
// verbatim. "decoded"/"learned" are scored on the DECODED ticker.
//
// Precision is per ROW: a row that decodes to a ticker the table does not
// hold is a false positive, exactly as it would be in production.
//
// USAGE
//   node tools/evalPositionDecoder.js [--corpus file] [--confusion file]
//                                     [--per-date] [--limit N]

const fs = require('node:fs');
const path = require('node:path');

const { decodeCell } = require('../src/normalize/tickerDecode');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');
const { loadCharConfusion, clearCharConfusionCache } = require('../src/normalize/tickerDecode');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    corpus: path.join(ROOT, 'data', 'qmg_position_corpus.json'),
    confusion: path.join(ROOT, 'config', 'ticker_char_confusion.csv'),
    perDate: false,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = path.resolve(argv[++i]);
    else if (a === '--confusion') args.confusion = path.resolve(argv[++i]);
    else if (a === '--per-date') args.perDate = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/evalPositionDecoder.js [--corpus file] [--confusion file] [--per-date] [--limit N]');
      process.exit(0);
    }
  }
  return args;
}

/**
 * A scorer that counts recovered truth and false positives.
 */
function newScore() {
  return { truth: 0, recovered: 0, decoded: 0, falsePositives: 0, empty: 0 };
}

function finish(score) {
  const recall = score.truth ? score.recovered / score.truth : 0;
  const precision = score.decoded ? (score.decoded - score.falsePositives) / score.decoded : 0;
  const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
  return {
    recall,
    precision,
    f1,
    truth: score.truth,
    recovered: score.recovered,
    decoded: score.decoded,
    falsePositives: score.falsePositives,
    empty: score.empty,
  };
}

/**
 * Score one row with one decoder.
 *
 * @param {object} row     the corpus row
 * @param {object} truth   the ground-truth ticker for that row (or null)
 * @param {object} options the decoder options
 */
function scoreRow(row, truth, options, score) {
  const hypotheses = row.hypotheses || [];

  // The RAW baseline: the truth was read verbatim by some hypothesis.
  const rawHit = hypotheses.some((h) => String(h.text || '').toUpperCase() === truth);
  if (rawHit) score.rawRecovered++;

  if (!truth) {
    // A row the ground truth says does not exist. If the decoder produces a
    // ticker for it, that is a false positive.
    const decoded = decodeCell(hypotheses, options);
    if (decoded) {
      score.decoded++;
      score.falsePositives++;
    }
    return decoded;
  }

  score.truth++;
  const decoded = decodeCell(hypotheses, options);
  if (!decoded) {
    score.empty++;
    return null;
  }
  score.decoded++;
  if (decoded.ticker === truth) {
    score.recovered++;
  } else {
    score.falsePositives++;
  }
  return decoded;
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.corpus)) {
    console.error(`corpus not found: ${args.corpus}`);
    console.error('run tools/buildPositionCorpus.js first');
    process.exit(1);
  }
  const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'));
  const entries = corpus.entries || [];
  const selected = args.limit ? entries.slice(0, args.limit) : entries;

  // The DECODE lexicon, not the seed: it also holds the tickers that were
  // observed in a Qullamaggie position list but are not in the seed list.
  // Without them the decoder can neither recover nor refuse those rows, and
  // the recall it reports is a property of the lexicon rather than of the
  // decoder.
  const lexicon = loadDecodeLexiconSync();
  clearCharConfusionCache();
  const learned = loadCharConfusion(args.confusion);

  const scorers = {
    raw: newScore(),
    decoded: newScore(),
    learned: newScore(),
  };
  const perDate = new Map();
  const mistakes = [];

  for (const entry of selected) {
    const key = `${entry.date}#${entry.capture}`;
    const dateScores = perDate.get(key) || {
      raw: newScore(), decoded: newScore(), learned: newScore(),
    };
    for (const row of entry.rows || []) {
      const truth = row.truth ? String(row.truth).toUpperCase() : null;
      const hypotheses = row.hypotheses || [];

      // RAW: recovered when a hypothesis reads the truth verbatim.
      if (truth) {
        for (const s of [scorers.raw, dateScores.raw]) {
          s.truth++;
          if (hypotheses.some((h) => String(h.text || '').toUpperCase() === truth)) s.recovered++;
        }
      }

      const plain = decodeCell(hypotheses, { lexicon, confusion: { pairs: new Map(), max: 0 } });
      const withModel = decodeCell(hypotheses, { lexicon, confusion: learned });

      for (const [name, decoded] of [['decoded', plain], ['learned', withModel]]) {
        const score = scorers[name];
        const dateScore = dateScores[name];
        if (!truth) {
          if (decoded) {
            score.decoded++;
            score.falsePositives++;
            dateScore.decoded++;
            dateScore.falsePositives++;
          }
          continue;
        }
        score.truth++;
        dateScore.truth++;
        if (!decoded) {
          score.empty++;
          dateScore.empty++;
          continue;
        }
        score.decoded++;
        dateScore.decoded++;
        if (decoded.ticker === truth) {
          score.recovered++;
          dateScore.recovered++;
        } else {
          score.falsePositives++;
          dateScore.falsePositives++;
          if (name === 'learned') {
            mistakes.push({
              date: entry.date,
              capture: entry.capture,
              truth,
              decoded: decoded.ticker,
              cost: decoded.cost,
              raw: decoded.raw,
              conf: decoded.confidence,
            });
          }
        }
      }
    }
    perDate.set(key, dateScores);
  }

  console.log(`corpus: ${args.corpus}`);
  console.log(`entries: ${selected.length}  lexicon: ${lexicon.tickers.length} tickers  `
    + `confusion model: ${learned.pairs.size} pairs`);
  console.log('');

  const rows = [];
  for (const name of ['raw', 'decoded', 'learned']) {
    const r = finish(scorers[name]);
    rows.push({ decoder: name, ...r });
  }
  console.log('decoder    recall   precision   F1      truth  recovered  decoded  FP   empty');
  for (const r of rows) {
    // The raw baseline's precision is not measurable here: every row of this
    // corpus is a holding, so a verbatim read is right by construction and
    // the only false positives the raw reads produce live in the chart area,
    // which this corpus does not contain.
    const precision = r.decoder === 'raw' ? '     -' : `${(r.precision * 100).toFixed(1).padStart(8)}%`;
    const f1 = r.decoder === 'raw' ? '    -' : `${(r.f1 * 100).toFixed(1).padStart(5)}%`;
    console.log(
      `${r.decoder.padEnd(10)}`
      + `${(r.recall * 100).toFixed(1).padStart(5)}%  `
      + `${precision}  `
      + `${f1}  `
      + `${String(r.truth).padStart(8)}  ${String(r.recovered).padStart(9)}  `
      + `${String(r.decoded).padStart(7)}  ${String(r.falsePositives).padStart(3)}  `
      + `${String(r.empty).padStart(5)}`
    );
  }

  if (args.perDate) {
    console.log('\nper date:');
    console.log('date#cap        raw   decoded   learned');
    for (const [key, s] of perDate) {
      const raw = finish(s.raw);
      const dec = finish(s.decoded);
      const lrn = finish(s.learned);
      console.log(
        `${key.padEnd(16)}`
        + `${(raw.recall * 100).toFixed(0).padStart(4)}%  `
        + `${(dec.recall * 100).toFixed(0).padStart(7)}%  `
        + `${(lrn.recall * 100).toFixed(0).padStart(7)}%`
      );
    }
  }

  if (mistakes.length) {
    console.log('\nwrong decodes (learned model):');
    for (const m of mistakes.slice(0, 40)) {
      console.log(`  ${m.date} c${m.capture}: "${m.raw}" -> ${m.decoded} (truth ${m.truth}, cost ${m.cost.toFixed(2)})`);
    }
    if (mistakes.length > 40) console.log(`  ... and ${mistakes.length - 40} more`);
  }

  // The top learned confusions — a character-level model should look like
  // "O -> Q", "T -> I"; a ticker-level one would look like "AROQ -> ARQQ".
  const pairs = [...learned.pairs.entries()].sort((a, b) => b[1] - a[1]);
  if (pairs.length) {
    console.log('\ntop learned character confusions (read char -> true char):');
    for (const [key, count] of pairs.slice(0, 20)) {
      console.log(`  ${key.replace('>', ' -> ')}   ${count}`);
    }
  } else {
    console.log('\nno learned confusions yet — run tools/learnCharConfusion.js');
  }
}

main();
