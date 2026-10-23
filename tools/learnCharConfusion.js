'use strict';

// Learn a CHARACTER-level OCR confusion matrix from labelled reads.
//
// WHY THIS EXISTS
// The recogniser's errors on the position list are STABLE: the same pixels
// give the same mis-reading at every scale and every resampling, because
// the information is simply not in the picture. A second opinion from the
// same recogniser cannot fix that.
//
// The fix is a constraint: a position list holds tickers, and there are only
// so many tickers. Decoding a read against that lexicon turns "TOCQ" back
// into "TQQQ" — without anybody having to write down that TOCQ means TQQQ.
//
// Decoding needs to know which single-character differences are PLAUSIBLE.
// That is what this file estimates, from the labelled corpus that
// tools/buildPositionCorpus.js produces.
//
// WHY CHARACTER-LEVEL
// A ticker-level list ("TQQQ -> TOCQ") only helps for the tickers somebody
// already tripped over. A character-level list ("Q -> O", "T -> I") helps
// for every ticker containing those letters, including tickers nobody has
// seen mis-read yet.
//
// USAGE
//   node tools/learnCharConfusion.js [--corpus file] [--out file]
//                                    [--max-mean-cost N] [--min-exact N]
//                                    [--report N]
//
// The corpus is the expensive part (it runs OCR); this tool is pure string
// work and can be re-run whenever the corpus or the alignment changes.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// An entry whose rows cannot be paired with the truth confidently is a
// mis-detected table. Teaching it anything would poison the matrix, so it
// is skipped — and the count of skipped entries is reported, because a
// silent skip hides a broken corpus.
const DEFAULT_MAX_MEAN_COST = 0.5;
const DEFAULT_MIN_EXACT_RATIO = 0.5;

function parseArgs(argv) {
  const args = {
    corpus: path.join(ROOT, 'data', 'qmg_position_corpus.json'),
    out: path.join(ROOT, 'config', 'ticker_char_confusion.csv'),
    maxMeanCost: DEFAULT_MAX_MEAN_COST,
    minExactRatio: DEFAULT_MIN_EXACT_RATIO,
    report: 25,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--max-mean-cost') args.maxMeanCost = Number(argv[++i]);
    else if (a === '--min-exact-ratio') args.minExactRatio = Number(argv[++i]);
    else if (a === '--report') args.report = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/learnCharConfusion.js [--corpus file] [--out file] '
        + '[--max-mean-cost N] [--min-exact-ratio N] [--report N]');
      process.exit(0);
    }
  }
  return args;
}

/**
 * Align two strings and report the character substitutions.
 *
 * A plain Levenshtein backtrace, preferring a match/substitution over a
 * delete+insert pair when the costs tie: a substitution is the thing this
 * matrix is about, and an alignment that explains a difference with two
 * indels instead of one substitution teaches the wrong thing.
 *
 * @returns {{subs: Array<[string,string]>, ins: number, del: number, cost: number}}
 */
function alignCharacters(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j - 1] + cost, d[i - 1][j] + 1, d[i][j - 1] + 1);
    }
  }

  const subs = [];
  let ins = 0;
  let del = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      if (d[i][j] === d[i - 1][j - 1] + cost) {
        if (cost) subs.push([a[i - 1], b[j - 1]]);
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      del++;
      i--;
      continue;
    }
    ins++;
    j--;
  }
  return { subs, ins, del, cost: d[n][m] };
}

/**
 * The reads of one row, deduplicated.
 *
 * Two strip variants often read the same cell identically; counting that
 * twice would make a single lucky coincidence look like a strong rule.
 */
function uniqueHypotheses(row) {
  const seen = new Map();
  for (const h of row.hypotheses || []) {
    const text = String(h.text || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!text) continue;
    const prev = seen.get(text);
    if (prev === undefined || (h.conf || 0) > prev) seen.set(text, h.conf || 0);
  }
  return [...seen.keys()];
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

  const counts = new Map();
  let usedEntries = 0;
  let skippedEntries = 0;
  let pairs = 0;
  let exactPairs = 0;
  let indelTotal = 0;

  for (const e of entries) {
    const a = e.alignment || {};
    const meanCost = a.meanCost === null || a.meanCost === undefined ? Infinity : a.meanCost;
    const exactRatio = a.paired ? (a.exact || 0) / a.paired : 0;
    // A table that was not found cannot be paired at all.
    if (!a.paired || meanCost > args.maxMeanCost || exactRatio < args.minExactRatio) {
      skippedEntries++;
      continue;
    }
    usedEntries++;
    for (const row of e.rows || []) {
      if (!row.truth) continue;
      for (const text of uniqueHypotheses(row)) {
        const truth = String(row.truth).toUpperCase().replace(/[^A-Z]/g, '');
        if (!truth) continue;
        const { subs, ins, del } = alignCharacters(text, truth);
        indelTotal += ins + del;
        if (!subs.length && !ins && !del) {
          exactPairs++;
          continue;
        }
        pairs++;
        for (const [from, to] of subs) {
          const key = `${from}>${to}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
  }

  const rows = [...counts.entries()]
    .map(([key, count]) => {
      const [from, to] = key.split('>');
      return { from, to, count };
    })
    .sort((a, b) => (b.count - a.count) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const header = [
    '# Character-level OCR confusion matrix, learned by tools/learnCharConfusion.js',
    '# from,to,count — the number of times a read showed `from` where the',
    '# truth had `to`. Regenerate; do not edit by hand.',
    '# Entries skipped as untrustworthy:',
    `#   skipped=${skippedEntries} used=${usedEntries} maxMeanCost=${args.maxMeanCost} minExactRatio=${args.minExactRatio}`,
  ];
  const body = rows.map((r) => `${r.from},${r.to},${r.count}`);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${header.concat(body).join('\n')}\n`);

  console.log(`corpus: ${args.corpus}`);
  console.log(`entries used ${usedEntries}, skipped ${skippedEntries}`);
  console.log(`reads: ${exactPairs} exact, ${pairs} with a difference, ${indelTotal} indel characters`);
  console.log(`distinct character confusions: ${rows.length}`);
  console.log('\ntop confusions:');
  for (const r of rows.slice(0, args.report)) {
    console.log(`  ${r.from} -> ${r.to}   ${r.count}`);
  }
  console.log(`\nwrote ${path.relative(ROOT, args.out)}`);
}

main();
