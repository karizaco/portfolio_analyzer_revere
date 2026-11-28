'use strict';

// Build a labelled corpus of (raw OCR string, true ticker) pairs from the
// Qullamaggie position list.
//
// WHY THIS EXISTS
// The position list is a TradingView table. Its ROW ORDER is the position
// order, so the ground truth is a free label — with one caveat, checked
// below. That makes the whole corpus labellable without a human reading a
// single cell, and the character-level OCR confusion matrix can be
// ESTIMATED rather than hand-written.
//
//   tools/buildPositionCorpus.js   (expensive: runs OCR)
//     -> data/qmg_position_corpus.json
//        tools/learnCharConfusion.js  (cheap: pure string work)
//          -> config/ticker_char_confusion.csv
//
// The expensive half is cached so the cheap half can be re-run whenever the
// alignment or the decoder changes.
//
// USAGE
//   node tools/buildPositionCorpus.js [--out file] [--limit N] [--variants K]
//                                     [--dates d1,d2]
//
// WHERE THE PIXELS COME FROM
// The scan runs already saved full 1920x1080 snapshots under
// data/video_scan_*/…/snapshots/qmg_<date>[_N].png. Those are the SOURCE
// frames.
//
// The full frame, not a crop of it, and that is not a convenience:
//   * The OCR-resolution frame is 1280x720, so a ticker glyph is ~4.5 px
//     tall there and unreadable. Measured on 20220218, the 1280-crop of a
//     perfectly legible panel read as "US / D / WCU / W / KOCO" instead of
//     "UPST / DVN / NRGU / MOS / TQQQ".
//   * The panel is not in a fixed place. 2022 puts it over the chart at the
//     bottom right, 2023 in the right sidebar, and the review crops — which
//     used a fixed fractional region — cut the 20230609 table in half. The
//     table has to be FOUND, and finding it needs the whole frame.
//
// WHY EACH ROW IS READ SEVERAL WAYS
// A single reading of a cell is not reliable. The recogniser's output
// depends on the scale and on how much of the neighbouring column the crop
// caught. Measured on the 20220218 panel the same cell came back as "UPST",
// "UPSI" and "JPSI" from three different preparations. The decoder picks
// among the hypotheses; this file records them all so the choice can be
// measured rather than guessed.
//
// WHY THE ALIGNMENT IS AN ASSIGNMENT, NOT AN OFFSET
// The table's row order is the position order, so the natural alignment is
// row i <-> truth[i]. That holds for most dates. It does NOT hold for
// every date: 20220323's ground truth is recorded as BOIL, JNUG, NUGT, X,
// URA, ... while the table reads BOIL, WEAT, URNM, NUGT, ... — the same
// holdings in a different order. A constant offset cannot express that, so
// the rows are matched to the truth by an assignment that minimises the
// total edit distance. Each entry records the mean pairing cost, and the
// learning step only trusts entries whose pairing is convincing.

const fs = require('node:fs');
const path = require('node:path');

const { findTickerColumnByInkRuns } = require('../src/video/positionColumn.js');
const { resolvePanelFromStrips, symRowIndex } = require('../src/video/positionPanel.js');
const {
  prepareColumnStrip,
  interpretColumnStrip,
  ocrStrips,
  LETTERS_ONLY,
} = require('../src/ocr/positionCellOcr.js');

const ROOT = path.resolve(__dirname, '..');
const GT_PATH = path.join(ROOT, 'data', 'qmg_ground_truth.json');

// A snapshot at least this wide came from the 1920x1080 source rather than
// from the 1280x720 OCR-resolution frame.
const SOURCE_MIN_WIDTH = 1600;

// How many ink candidates get read. The ticker column is picked by how well
// its rows match the ground truth, so the shortlist has to contain it.
//
// A candidate's ladder holds the table's title bar and its header row as
// well as its holdings, so the expected row count is the number of
// holdings plus a couple.
const ROW_COUNT_SLACK = 7;
const MAX_CANDIDATES = 5;

// The ways each column is read. Each is a hypothesis, not a vote.
const STRIP_VARIANTS = [
  { scale: 6, padLeft: 4, padRight: 2, tag: 's6p4' },
  { scale: 6, padLeft: 0, padRight: 2, tag: 's6p0' },
  { scale: 8, padLeft: 2, padRight: 4, tag: 's8p2' },
];

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'data', 'qmg_position_corpus.json'),
    limit: 0,
    variants: STRIP_VARIANTS.length,
    dates: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--variants') args.variants = Number(argv[++i]);
    else if (a === '--dates') args.dates = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--help' || a === '-h') {
      console.log('usage: node tools/buildPositionCorpus.js [--out file] [--limit N] [--variants K] [--dates d1,d2]');
      process.exit(0);
    }
  }
  return args;
}

/** The ground truth for a capture, in either of its two stored shapes. */
function truthOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.tickers)) return value.tickers;
  return null;
}

/**
 * Index the full-frame snapshots by (date, capture).
 *
 * Several scan runs saved the same date, and each run captured a different
 * moment of the video, so the same (date, capture) can exist more than once
 * with different content. The most recent run wins: it is the one whose
 * frame selection the current pipeline would reproduce.
 *
 * The capture index is the snapshot's suffix minus one: "qmg_20230609.png"
 * is capture 0, "qmg_20230609_2.png" is capture 1.
 */
function indexSnapshots() {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'frames' || e.name === 'node_modules') continue;
        walk(full, depth + 1);
        continue;
      }
      const m = e.name.match(/^qmg_(\d{8})(?:_(\d+))?\.png$/);
      if (!m) continue;
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      const width = buf.readUInt32BE(16);
      if (width < SOURCE_MIN_WIDTH) continue;
      const capture = m[2] ? Number(m[2]) - 1 : 0;
      const key = `${m[1]}|${capture}`;
      // The run directory decides which frame is canonical: a later run
      // supersedes an earlier one for the same date and capture.
      //
      // The comparison has to use the WHOLE run path. The first three path
      // segments are identical for every run under
      // data/video_scan_test/_rerun/, so comparing them ties all of those
      // runs together and leaves the winner to the directory walk's order,
      // which is arbitrary. Two runs of the same video can hold a
      // different moment of the screen — and therefore a different table —
      // so the choice decides what the corpus is a corpus OF. The
      // modification time is the "later run" signal; the path breaks a tie
      // between runs written in the same instant, so the choice is
      // reproducible.
      const run = path.relative(ROOT, dir).replace(/\\/g, '/');
      const written = fs.statSync(dir).mtimeMs;
      const prev = out.get(key);
      if (!prev) {
        out.set(key, { file: full, date: m[1], capture, width, run, written });
      } else if (written > prev.written || (written === prev.written && run > prev.run)) {
        out.set(key, { file: full, date: m[1], capture, width, run, written });
      }
    }
  };
  for (const d of fs.readdirSync(path.join(ROOT, 'data'))) {
    if (!d.startsWith('video_scan')) continue;
    walk(path.join(ROOT, 'data', d), 0);
  }
  return out;
}

/** Plain Levenshtein distance, used only to pair rows with the truth. */
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/**
 * Pair the detected rows with the ground-truth holdings.
 *
 * Exact matches are paired first, then the rest by increasing distance.
 * The pairing cost is recorded: an entry whose rows cannot be paired
 * convincingly is a mis-detected table and must not teach the confusion
 * model anything.
 *
 * @returns {{pairs: Array<{rowIndex:number, truthIndex:number, truth:string, cost:number}>, meanCost:number, exact:number}}
 */
function assignRowsToTruth(rows, truth) {
  const pairs = [];
  const usedRow = new Set();
  const usedTruth = new Set();

  const costOf = (row, ti) => {
    const t = truth[ti];
    let best = Infinity;
    for (const h of row.hypotheses) {
      if (!h.text) continue;
      const d = editDistance(h.text, t);
      if (d < best) best = d;
    }
    return best;
  };

  // Exact matches first: they are the anchors.
  for (let r = 0; r < rows.length; r++) {
    for (let t = 0; t < truth.length; t++) {
      if (usedRow.has(r) || usedTruth.has(t)) continue;
      if (rows[r].hypotheses.some((h) => h.text === truth[t])) {
        pairs.push({ rowIndex: r, truthIndex: t, truth: truth[t], cost: 0 });
        usedRow.add(r);
        usedTruth.add(t);
      }
    }
  }

  // Then the rest, cheapest pair first.
  const rest = [];
  for (let r = 0; r < rows.length; r++) {
    if (usedRow.has(r)) continue;
    for (let t = 0; t < truth.length; t++) {
      if (usedTruth.has(t)) continue;
      const c = costOf(rows[r], t);
      if (c <= 3) rest.push({ rowIndex: r, truthIndex: t, truth: truth[t], cost: c });
    }
  }
  rest.sort((a, b) => (a.cost - b.cost) || (a.rowIndex - b.rowIndex) || (a.truthIndex - b.truthIndex));
  for (const p of rest) {
    if (usedRow.has(p.rowIndex) || usedTruth.has(p.truthIndex)) continue;
    pairs.push(p);
    usedRow.add(p.rowIndex);
    usedTruth.add(p.truthIndex);
  }

  pairs.sort((a, b) => a.rowIndex - b.rowIndex);
  const exact = pairs.filter((p) => p.cost === 0).length;
  const meanCost = pairs.length
    ? pairs.reduce((s, p) => s + p.cost, 0) / pairs.length
    : Infinity;
  return { pairs, meanCost, exact };
}

/**
 * How many of a column's rows read exactly as one of the ground-truth
 * holdings.
 */
function countGroundTruthHits(rows, truth) {
  const wanted = new Set(truth);
  const used = new Set();
  let hits = 0;
  for (const r of rows || []) {
    const text = String((r && r.text) || '').toUpperCase();
    if (wanted.has(text) && !used.has(text)) {
      used.add(text);
      hits++;
    }
  }
  return hits;
}

/**
 * Read a batch of images, surviving a batch-wide failure.
 *
 * One EasyOCR process serves the whole batch, so a single bad image can
 * take the batch down. A missing reading must not take the sweep with it:
 * the entry simply has fewer hypotheses.
 */
async function readBatch(strips, options) {
  if (!strips.length) return [];
  try {
    return await ocrStrips(strips, { timeoutMs: 1800000, ...options });
  } catch (e) {
    console.log(`  batch of ${strips.length} failed: ${e.message.split('\n')[0]}`);
    return strips.map(() => ({ error: e.message }));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
  const snaps = indexSnapshots();

  const targets = [];
  for (const [key, snap] of snaps) {
    const [date, capStr] = key.split('|');
    const capture = Number(capStr);
    const truth = truthOf(gt[date] && gt[date][String(capture)]);
    if (!truth || !truth.length) continue;
    targets.push({ ...snap, truth });
  }
  targets.sort((a, b) => (a.date + String(a.capture)).localeCompare(b.date + String(b.capture)));
  const filtered = args.dates ? targets.filter((t) => args.dates.has(t.date)) : targets;
  const selected = args.limit ? filtered.slice(0, args.limit) : filtered;

  console.log(`corpus candidates: ${selected.length} (date, capture) pairs`);

  // ---- Pass 1: find the candidate columns -----------------------------------
  // The pixel work is done for every frame first: the ink finder proposes
  // the columns of white, left-aligned, evenly-pitched text. There is more
  // than one of them — a frame holds the watchlist, the positions table and
  // the chat overlay — and the ground truth says which one is the positions
  // table, because it holds the ground-truth tickers.
  const prepared = [];
  for (const t of selected) {
    try {
      const ink = await findTickerColumnByInkRuns(t.file, {});
      if (!ink.candidates.length) {
        console.log(`  ${t.date} c${t.capture}: no ink column found`);
        continue;
      }
      // Shortlist by row count: the positions table holds the ground-truth
      // holdings, plus a title bar and a header row.
      const want = t.truth.length;
      const plausible = ink.candidates.filter(
        (c) => c.rowCount >= want - 1 && c.rowCount <= want + ROW_COUNT_SLACK
      );
      const shortlist = (plausible.length ? plausible : ink.candidates)
        .slice(0, MAX_CANDIDATES);
      prepared.push({ target: t, ink, candidates: shortlist });
    } catch (e) {
      console.log(`  ${t.date} c${t.capture}: detect failed: ${e.message}`);
    }
  }

  // ---- Pass 2: read each candidate column -----------------------------------
  // One strip per candidate, all read in ONE EasyOCR process: the model is
  // ~80 MB and loading it per image would cost more than the recognition.
  //
  // The strip is the WHOLE ladder, header row included, because the header
  // label is what identifies the column. A watchlist's header says "WL";
  // only the positions table's says "Sym".
  const variants = STRIP_VARIANTS.slice(0, Math.max(1, args.variants));
  const probe = variants[0];
  const probeStrips = [];
  for (const j of prepared) {
    j.probes = [];
    for (const c of j.candidates) {
      const column = { left: c.left, right: c.right };
      const strip = await prepareColumnStrip(j.target.file, column, c.rows, probe);
      if (strip) {
        j.probes.push({ candidate: c, column, strip });
        probeStrips.push(strip);
      }
    }
  }
  console.log(`candidate strips to read: ${probeStrips.length}`);
  // The strips are read with a letters-only alphabet: a price, a percentage
  // or a stray digit can then never be mistaken for part of a ticker.
  const probeOcr = await readBatch(probeStrips, { allowlist: LETTERS_ONLY });

  let probeCursor = 0;
  for (const j of prepared) {
    j.reads = j.probes.map((p) => {
      const ocr = probeOcr[probeCursor++];
      return interpretColumnStrip(ocr, p.strip);
    });
    // Pick the candidate that HOLDS THE GROUND TRUTH.
    //
    // A frame holds several tables — the watchlist, the positions list, the
    // chat overlay — and the ink alone cannot say which one is which: both
    // the watchlist and the positions list have a "Sym" column, and the
    // chat overlay is a column of tickers too. The ground truth can: the
    // positions table is the one whose rows are the ground-truth holdings.
    //
    // This is a LABELLING step, not a detection step: the corpus is built
    // from labelled reads, so using the label to find the labelled column
    // is sound. The production panel finder has no ground truth and uses
    // the header instead (see resolvePanelFromStrips).
    let best = null;
    for (let i = 0; i < j.probes.length; i++) {
      const read = j.reads[i];
      if (!read.rows || !read.rows.length) continue;
      const symRow = symRowIndex(read.rows);
      const dataRows = symRow >= 0 ? read.rows.slice(symRow + 1) : read.rows;
      const hits = countGroundTruthHits(dataRows, j.target.truth);
      const score = hits * 1000 + (symRow >= 0 ? 50 : 0) + dataRows.length;
      if (!best || score > best.score) {
        best = { score, i, symRow, hits };
      }
    }
    if (!best) continue;
    j.winner = j.probes[best.i];
    j.symRow = best.symRow;
    j.gtHits = best.hits;
    j.panel = resolvePanelFromStrips(
      [{ candidate: j.winner.candidate, column: j.winner.column }],
      [{ rows: j.reads[best.i].rows }]
    );
  }
  const withColumn = prepared.filter((j) => j.panel.column && j.panel.rows.length);
  console.log(`panels with a ticker column: ${withColumn.length}`);

  // ---- Pass 3: read the winning column several ways --------------------------
  const extraStrips = [];
  for (const j of withColumn) {
    j.variants = [];
    if (!j.winner) continue;
    for (const v of variants) {
      const strip = await prepareColumnStrip(j.target.file, j.winner.column, j.winner.candidate.rows, v);
      if (strip) {
        j.variants.push({ tag: v.tag, strip });
        extraStrips.push(strip);
      }
    }
  }
  console.log(`column strips to read (variants): ${extraStrips.length}`);
  const variantOcr = await readBatch(extraStrips, { allowlist: LETTERS_ONLY });

  let variantCursor = 0;
  for (const j of withColumn) {
    j.variantReads = j.variants.map((v) => {
      const ocr = variantOcr[variantCursor++];
      return { tag: v.tag, rows: interpretColumnStrip(ocr, v.strip).rows };
    });
  }

  // ---- Assemble -------------------------------------------------------------
  const entries = [];
  for (const j of withColumn) {
    const truth = j.target.truth;
    // One row per detected table row; its hypotheses are every variant's
    // reading of it. The rows start after the header label, so index 0 is
    // the first holding.
    const firstDataRow = j.symRow >= 0 ? j.symRow + 1 : 0;
    const ladderRows = j.winner ? j.winner.candidate.rows : [];
    const rowCount = Math.max(0, ladderRows.length - firstDataRow);
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const hypotheses = [];
      for (const read of j.variantReads) {
        const r = read.rows[firstDataRow + i];
        if (!r || !r.text) continue;
        hypotheses.push({
          text: r.text,
          conf: Number((r.conf || 0).toFixed(4)),
          source: read.tag,
        });
      }
      rows.push({ index: i, hypotheses });
    }
    const { pairs, meanCost, exact } = assignRowsToTruth(rows, truth);
    const truthOfRow = new Map();
    for (const pair of pairs) truthOfRow.set(pair.rowIndex, pair);

    entries.push({
      date: j.target.date,
      capture: j.target.capture,
      file: path.relative(ROOT, j.target.file).replace(/\\/g, '/'),
      run: j.target.run,
      resolution: 'source',
      imageWidth: j.target.width,
      table: {
        column: j.panel.column,
        rows: rowCount,
        headerText: j.panel.headerText,
        headerRowDropped: j.symRow >= 0,
        fallback: !!j.panel.fallback,
        candidates: j.candidates.length,
      },
      alignment: {
        meanCost: Number.isFinite(meanCost) ? Number(meanCost.toFixed(4)) : null,
        exact,
        paired: pairs.length,
        truthCount: truth.length,
        // The order-preserving alignment: how many rows line up with the
        // truth at the SAME index.
        ordered: pairs.filter((x) => x.rowIndex === x.truthIndex).length,
      },
      rows: rows.map((r) => {
        const pair = truthOfRow.get(r.index);
        return {
          index: r.index,
          truth: pair ? pair.truth : null,
          pairCost: pair ? pair.cost : null,
          hypotheses: r.hypotheses,
        };
      }),
      truth,
    });
  }

  entries.sort((a, b) => (a.date + String(a.capture)).localeCompare(b.date + String(b.capture)));
  const payload = {
    generatedBy: 'tools/buildPositionCorpus.js',
    note: 'rows[i].truth is the ground truth paired with detected row i (an assignment, '
      + 'not a fixed offset) and null when the row could not be paired. Each row lists '
      + 'every way that row was read.',
    entries,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);

  // ---- Report ---------------------------------------------------------------
  let exactHits = 0;
  let exactTotal = 0;
  let paired = 0;
  let totalRows = 0;
  for (const e of entries) {
    let hit = 0;
    let counted = 0;
    for (const r of e.rows) {
      if (!r.truth) continue;
      counted++;
      if (r.hypotheses.some((h) => h.text === r.truth)) hit++;
    }
    exactHits += hit;
    exactTotal += counted;
    paired += e.alignment.paired;
    totalRows += e.rows.length;
    console.log(
      `${e.date} c${e.capture} rows${e.table.rows}/gt${e.truth.length} `
      + `pairs${e.alignment.paired} exact${e.alignment.exact} mean${e.alignment.meanCost} `
      + `ord${e.alignment.ordered} read ${hit}/${counted} `
      + `${e.table.fallback ? 'FALLBACK ' : ''}hdr="${e.table.headerText.slice(0, 44)}"`
    );
  }
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
  console.log(`\nrows read exactly: ${exactHits}/${exactTotal} (${pct(exactHits, exactTotal)}%)`);
  console.log(`rows paired: ${paired}/${totalRows}`);
  console.log(`wrote ${path.relative(ROOT, args.out)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
