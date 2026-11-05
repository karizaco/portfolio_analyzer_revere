'use strict';

// Does a SHORT list read better under a tighter crop?
//
// The 2022-era crop is `0.86,0.60,0.14,0.28`. Taller than the old
// `0.86,0.62,0.14,0.22`, it buys the bottom rows of long lists (20220421:
// 11/16 -> 14/16) and costs the benchmark's `trade_ideas` frame two holdings
// in the MIDDLE of a nine-row list (TQQQ, TSLA): EasyOCR resizes the
// detection image to a fixed height, so the same glyphs are smaller when the
// crop is taller and a nine-row list leaves the bottom half of the crop empty.
//
// This script measures, over the pinned 2022-era frames, how each crop height
// reads each frame -- and what a TWO-PASS read would do: the shipped crop
// first, then a tighter crop of the same frame, taken only when the first
// pass found a short list.
//
// It runs EasyOCR for real (~60 s a frame), so it is a MANUAL tool, writes
// its results incrementally, and resumes from them:
//
//   OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KMP_DUPLICATE_LIB_OK=TRUE \
//   CUDA_VISIBLE_DEVICES= node tools/experimentCropHeight.js --out C:/tmp/crop_height.json
//
// Flags: --heights 0.28,0.24   --until 20230518   --only 20220218
//        --rows 8-9   (keep frames whose ground truth has that many rows)
//        --out <file>
//
// Mind the geometry: rows are ~0.0167 of the frame height apart and a nine-row
// list ends near y=0.81, so a crop taller than 0.60 + h must cover it --
// h=0.20 would CLIP a nine-row list. h=0.24 is the smallest height that
// still holds nine rows with a margin.

const fs = require('node:fs');
const path = require('node:path');

const { ocrImage, closeWorker } = require('../src/ocr/ocrImage');
const { parseChartStreamPositionList } = require('../src/parse/parseChartStream');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth', 'manifest.json');
const BENCHMARK = path.join(ROOT, 'test', 'fixtures', 'qmg_benchmark');

function parseFlags(argv) {
  const flags = { heights: [0.28, 0.24], until: '20230518', only: null, out: null, rows: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--heights') flags.heights = String(argv[++i]).split(',').map(Number);
    else if (a === '--until') flags.until = argv[++i];
    else if (a === '--only') flags.only = argv[++i];
    else if (a === '--out') flags.out = argv[++i];
    else if (a === '--rows') {
      const [lo, hi] = String(argv[++i]).split('-').map(Number);
      flags.rows = { lo, hi: hi || lo };
    }
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!flags.heights.every((h) => Number.isFinite(h) && h > 0 && h <= 0.4)) {
    throw new Error('--heights must be fractions in (0, 0.4]');
  }
  return flags;
}

function loadCases(flags) {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const cases = (Array.isArray(m) ? m : m.cases)
    .filter((c) => c.date < flags.until && c.panel === 'positions')
    .map((c) => ({
      id: `${c.date}[${c.capture_index}]`,
      date: c.date,
      source: path.resolve(ROOT, c.source),
      tickers: c.tickers.map((t) => String(t).toUpperCase()),
    }))
    .filter((c) => fs.existsSync(c.source));
  // The benchmark's trade_ideas frame is the one that regressed; its tracked
  // fixture is the pinned file, so it is read from there.
  const bench = path.join(BENCHMARK, 'trade_ideas_20220218_c1.png');
  const gt = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'qmg_ground_truth.json'), 'utf8'));
  if (fs.existsSync(bench) && gt['20220218'] && gt['20220218']['1']) {
    cases.unshift({ id: '20220218[1]*bench', date: '20220218', source: bench, tickers: gt['20220218']['1'] });
  }
  const byDate = flags.only ? cases.filter((c) => c.date === flags.only) : cases;
  return flags.rows ? byDate.filter((c) => c.tickers.length >= flags.rows.lo && c.tickers.length <= flags.rows.hi) : byDate;
}

async function read(source, height) {
  const ocr = await ocrImage(source, {
    chartStream: true,
    ocrEngine: 'easyocr',
    overlayRegion: { x: 0.86, y: 0.60, w: 0.14, h: height },
  });
  const parsed = parseChartStreamPositionList({ ocr });
  return Array.isArray(parsed.position_list) ? parsed.position_list : [];
}

function score(found, gt) {
  const hit = gt.filter((t) => found.includes(t));
  return { hit: hit.length, gt: gt.length, fp: found.filter((t) => !gt.includes(t)), missed: gt.filter((t) => !found.includes(t)) };
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const cases = loadCases(flags);
  const done = flags.out && fs.existsSync(flags.out) ? JSON.parse(fs.readFileSync(flags.out, 'utf8')) : {};
  console.log(`${cases.length} frames x ${flags.heights.length} heights = ${cases.length * flags.heights.length} EasyOCR reads`);
  for (const c of cases) {
    done[c.id] = done[c.id] || { gt: c.tickers, reads: {} };
    for (const h of flags.heights) {
      const key = String(h);
      if (done[c.id].reads[key]) continue;
      const started = Date.now();
      done[c.id].reads[key] = await read(c.source, h);
      const s = score(done[c.id].reads[key], c.tickers);
      console.log(`${c.id.padEnd(18)} h=${key.padEnd(5)} ${s.hit}/${s.gt} fp=${s.fp.length} missed=[${s.missed}] fp=[${s.fp}]  (${Math.round((Date.now() - started) / 1000)}s)`);
      if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(done, null, 1));
    }
  }
  await closeWorker();
}

main().catch((e) => { console.error(e); process.exit(1); });
