'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

const ROOT = path.join(__dirname, '..');

// Crop region — matches CHART_STREAM_REGION_FRACTION_DEFAULT.
// 269x238 px at 1080p: tuned to keep the position-list band while excluding
// most chart y-axis bleed above and the Personal WatchList panel below.
const CROP = { x: 0.86, y: 0.62, w: 0.14, h: 0.22 };

// Ground-truth tickers per video (loaded from data/qmg_ground_truth.json at runtime
// so per-capture GT can vary — see notes in that file).
let GT = {};
try {
  GT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/qmg_ground_truth.json'), 'utf8'));
} catch (e) {
  console.warn('Could not load data/qmg_ground_truth.json:', e.message);
}

// Helper to get per-capture GT (returns array of tickers; empty array if no GT).
function gtForCapture(dateKey, captureIdx) {
  const entry = GT[dateKey] && GT[dateKey][String(captureIdx)];
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  if (entry.tickers) return entry.tickers;
  return [];
}

// Helper to extract a flat array of all GT tickers for a video
// (union across all captures — for display purposes).
function gtDisplay(dateKey) {
  const ve = GT[dateKey];
  if (!ve) return [];
  if (Array.isArray(ve)) return ve;
  const out = [];
  const seen = new Set();
  for (const k of Object.keys(ve)) {
    if (k.startsWith('_')) continue;
    const c = ve[k];
    const arr = Array.isArray(c) ? c : (c && c.tickers) || [];
    for (const t of arr) {
      if (!seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out;
}

// All videos to show in the comparison. Each video lists the captures to OCR.
// Uses the qmg-1080p-ocr-v2 batch run from 2026-09-23 which has snapshots for
// every GT video.
const VIDEOS = [
  {
    dateKey: '20220218',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220218.png', 'qmg_20220218_2.png', 'qmg_20220218_3.png'],
    description: '9 GT tickers per capture — first Quullamaggie video, Trade-Ideas UI',
  },
  {
    dateKey: '20220222',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220222.png', 'qmg_20220222_2.png', 'qmg_20220222_3.png'],
    description: '5 GT (NUGT, MOS, TQQQ, FCX, TSLA)',
  },
  {
    dateKey: '20220301',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220301.png', 'qmg_20220301_2.png', 'qmg_20220301_3.png'],
    description: '11 GT (IBKR, CRH, XLV, KRE, MP, NUGT, EDV, RSX, FCX, VLO, COPX)',
  },
  {
    dateKey: '20220302',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220302.png', 'qmg_20220302_2.png', 'qmg_20220302_3.png'],
    description: '7 GT (NUGT, FCX, X, ERX, EDV, COPX, AGQ)',
  },
  {
    dateKey: '20220318',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220318.png', 'qmg_20220318_2.png', 'qmg_20220318_3.png'],
    description: '7 GT tickers (NUGT, FCX, REGN, URA, COPX, URNM, KWEB)',
  },
  {
    dateKey: '20220321',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220321.png', 'qmg_20220321_2.png', 'qmg_20220321_3.png'],
    description: '8 GT (DIDI, NUGT, COPX, URNM, REGN, FCX, NUZE, X)',
  },
  {
    dateKey: '20220323',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220323.png', 'qmg_20220323_2.png', 'qmg_20220323_3.png'],
    description: '11 GT tickers (largest position list)',
  },
  {
    dateKey: '20220330',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220330.png', 'qmg_20220330_2.png', 'qmg_20220330_3.png'],
    description: '8 GT tickers (NFLX, KWEB, REGN, LABU, COPX, X, NUGT, FCX)',
  },
  {
    dateKey: '20220331',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220331.png', 'qmg_20220331_2.png', 'qmg_20220331_3.png'],
    description: '8 GT (COPX, KWEB, SPXL, TQQQ, X, REGN, FCX, NUGT)',
  },
  {
    dateKey: '20220405',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220405.png', 'qmg_20220405_2.png', 'qmg_20220405_3.png'],
    description: '11 GT tickers (CWEB, REGN, KWEB, JNUG, GGPI, TAN, NEM, COPX, FCX, NUGT, X)',
  },
  {
    dateKey: '20220406',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220406.png', 'qmg_20220406_2.png', 'qmg_20220406_3.png'],
    description: '7 GT (X, FCX, REGN, COPX, NUGT, NEM, LHX)',
  },
  {
    dateKey: '20220412',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220412.png', 'qmg_20220412_2.png', 'qmg_20220412_3.png'],
    description: '11 GT (LHX, LMT, URA, URNM, WEAT, X, COPX, FCX, REGN, NUGT, JNUG)',
  },
  {
    dateKey: '20220413',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220413.png', 'qmg_20220413_2.png', 'qmg_20220413_3.png'],
    description: '11 GT tickers (WEAT, LHX, REGN, LMT, X, FCX, COPX, NUGT, JNUG, URA, URNM) — largest after 20220323',
  },
  {
    dateKey: '20220414',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220414.png', 'qmg_20220414_2.png', 'qmg_20220414_3.png'],
    description: '11 GT (NUGT, JNUG, WEAT, GUSH, COPX, URA, URNM, X, REGN, FCX, LMT)',
  },
  {
    dateKey: '20220418',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220418.png', 'qmg_20220418_2.png', 'qmg_20220418_3.png'],
    description: '12 GT (VERU, WEAT, URA, URNM, FCX, LMT, COPX, REGN, GUSH, X, NUGT, JNUG)',
  },
  {
    dateKey: '20220419',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220419.png', 'qmg_20220419_2.png', 'qmg_20220419_3.png'],
    description: '14 GT (VERU, URNM, URA, REGN, JNUG, LMT, NUGT, X, COPX, WEAT, FCX, GUSH, BOIL, KOLD)',
  },
  {
    dateKey: '20220421',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220421.png', 'qmg_20220421_2.png', 'qmg_20220421_3.png'],
    description: '16 GT (FCX, JNUG, NUGT, COPX, WEAT, VERU, URNM, URA, REGN, X, GUSH, LAC, UCO, FTNT, BOIL, TSLA) — largest',
  },
  {
    dateKey: '20220425',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220425.png', 'qmg_20220425_2.png', 'qmg_20220425_3.png'],
    description: '4 GT (KOLD, WEAT, VERU, BOIL)',
  },
  {
    dateKey: '20220426',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220426.png', 'qmg_20220426_2.png', 'qmg_20220426_3.png'],
    description: '2 GT (BOIL, WEAT) — minimal position list',
  },
  // --- Batch snapshots (frames within 4s of the same timestamp) ---
  // Generated by tools/makeBatchSnapshots.js. Multi-frame merge is valid
  // for these because all snapshots show the same position list state.
  {
    dateKey: '20220323 (batch t=1020s)',
    snapshotsDir: 'data/video_scan_test/_batch_snapshots',
    files: [
      'qmg_20220323_batch1_batch_t1018.00_i0.png',
      'qmg_20220323_batch1_batch_t1019.00_i1.png',
      'qmg_20220323_batch1_batch_t1020.00_i2.png',
      'qmg_20220323_batch1_batch_t1021.00_i3.png',
      'qmg_20220323_batch1_batch_t1022.00_i4.png',
    ],
    description: '11 GT tickers — batch (5 frames within 4s). Multi-frame merge valid here.',
  },
  {
    dateKey: '20220428 (batch t=1300s)',
    snapshotsDir: 'data/video_scan_test/_batch_snapshots',
    files: [
      'qmg_20220428_batch1_batch_t1298.00_i0.png',
      'qmg_20220428_batch1_batch_t1299.00_i1.png',
      'qmg_20220428_batch1_batch_t1300.00_i2.png',
      'qmg_20220428_batch1_batch_t1301.00_i3.png',
      'qmg_20220428_batch1_batch_t1302.00_i4.png',
    ],
    description: '4 GT tickers — batch (5 frames within 4s). Multi-frame merge valid here.',
  },
  {
    dateKey: '20220427',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220427.png'],
    description: '4 GT tickers (TSLA, BOIL, WEAT, KOLD)',
  },
  {
    dateKey: '20220428',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220428.png', 'qmg_20220428_2.png', 'qmg_20220428_3.png'],
    description: '4 GT tickers',
  },
  {
    dateKey: '20220429',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220429.png', 'qmg_20220429_2.png', 'qmg_20220429_3.png'],
    description: '5 GT (WEAT, GUSH, TSLA, X, SWN)',
  },
  {
    dateKey: '20220506',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220506.png', 'qmg_20220506_2.png', 'qmg_20220506_3.png'],
    description: '4 GT (UCO, WEAT, TSLA, LTHM)',
  },
  {
    dateKey: '20220510',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220510.png', 'qmg_20220510_2.png', 'qmg_20220510_3.png'],
    description: '2 GT tickers',
  },
  {
    dateKey: '20220517',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220517.png', 'qmg_20220517_2.png', 'qmg_20220517_3.png'],
    description: '7 GT tickers (FNGU, TQQQ, OXY, COIN, ERX, AR, WEAT)',
  },
  {
    dateKey: '20220606',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220606.png', 'qmg_20220606_2.png', 'qmg_20220606_3.png'],
    description: '8 GT tickers (dense position list, OCR-difficult)',
  },
  {
    dateKey: '20220607',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220607.png', 'qmg_20220607_2.png', 'qmg_20220607_3.png'],
    description: '7 GT tickers',
  },
  {
    dateKey: '20220608',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220608.png', 'qmg_20220608_2.png', 'qmg_20220608_3.png'],
    description: '9 GT tickers (largest after 20220323, OCR-difficult)',
  },
  {
    dateKey: '20220614',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20220614.png', 'qmg_20220614_2.png', 'qmg_20220614_3.png'],
    description: '3 GT tickers',
  },
  {
    dateKey: '20221104',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20221104.png', 'qmg_20221104_2.png', 'qmg_20221104_3.png'],
    description: '1 GT (OIH) — minimal position list',
  },
  {
    dateKey: '20221117',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20221117.png', 'qmg_20221117_2.png', 'qmg_20221117_3.png'],
    description: '6 GT tickers (FREY, OIH, ASML, U, SI, SOXL)',
  },
  {
    dateKey: '20230126',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230126.png', 'qmg_20230126_2.png', 'qmg_20230126_3.png'],
    description: '8 GT tickers (CVNA, FCX, TNA, CWEB, YINN, PDD, MDGL, GNS)',
  },
  {
    dateKey: '20230518',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230518.png', 'qmg_20230518_2.png', 'qmg_20230518_3.png'],
    description: '7 GT (PLTR, LI, AI, SHOP, MNDY, IMGN, APLD) — wider table layout',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230522',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230522.png', 'qmg_20230522_2.png', 'qmg_20230522_3.png'],
    description: '7 GT tickers (LI, IMGN, SOUN, AI, CVNA, APLD, PLTR)',
  },
  {
    dateKey: '20230523',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230523.png', 'qmg_20230523_2.png', 'qmg_20230523_3.png'],
    description: '11 GT (QBTS, LI, SOUN, IMGN, FTCH, MNDY, APLD, PLTR, DNA, AI, CVNA)',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230601',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230601.png', 'qmg_20230601_2.png', 'qmg_20230601_3.png'],
    description: '9 GT (QBTS, APLD, AI, DNA, CVNA, IONQ, PLTR, IMGN, MNDY)',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230602',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230602.png', 'qmg_20230602_2.png', 'qmg_20230602_3.png'],
    description: '15 GT (IOT, TEAM, MTCH, QBTS, ARQQ, RGTI, IMGN, PLTR, CVNA, MNDY, APLD, DNA, IONQ, AI, GSIT) — largest yet',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230605',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230605.png', 'qmg_20230605_2.png', 'qmg_20230605_3.png'],
    description: '11 GT tickers (IMGN, ARQQ, CVNA, IOT, PLTR, GSIT, MNDY, APLD, AI, QBTS, DNA) — wider table layout',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230608',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230608.png', 'qmg_20230608_2.png', 'qmg_20230608_3.png'],
    description: '13 GT (CVNA, QBTS, APLD, ARQQ, IMGN, IOT, GTLB, RGTI, DNA, MNDY, AI, PLTR, GSIT)',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
  {
    dateKey: '20230609',
    snapshotsDir: 'data/video_scan_20260923/qmg-1080p-ocr-v2/qmg-1080p-ocr-v2/snapshots',
    files: ['qmg_20230609.png', 'qmg_20230609_2.png', 'qmg_20230609_3.png'],
    description: '13 GT (RGTI, QBTS, IMGN, CVNA, IOT, ARQQ, AI, PLTR, DNA, GTLB, GSIT, APLD, MNDY)',
    cropOverride: { x: 0.83, y: 0.55, w: 0.17, h: 0.45 },
  },
];


const CROPS_OUT_DIR = path.join(ROOT, 'data', 'video_scan_test', '_review_crops');

// Preprocess a snapshot like the OCR pipeline does. cropOverride lets callers
// use a different region (e.g. wider for newer videos with shifted table).
async function preprocessForOcr(snapshotPath, cropOverride = null) {
  const meta = await sharp(snapshotPath).metadata();
  const region = cropOverride || CROP;
  const left = Math.round(meta.width * region.x);
  const top = Math.round(meta.height * region.y);
  const cropW = Math.round(meta.width * region.w);
  const cropH = Math.round(meta.height * region.h);
  // Updated 2026-09-25: 5x upscale + sharpen sigma 2.0 + 100px black padding.
  // See src/ocr/ocrImage.js for the rationale (matching the production pipeline).
  const ocrBuf = await sharp(snapshotPath)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(cropW * 5, cropH * 5, { kernel: 'lanczos3' })
    .grayscale()
    .negate()
    .linear(1.8, -64)
    .normalize()
    .sharpen({ sigma: 2.0 })
    .extend({
      top: 100, bottom: 100, left: 100, right: 100,
      background: { r: 0, g: 0, b: 0 }
    })
    .withMetadata({ density: 300 })
    .png()
    .toBuffer();
  return { left, top, cropW, cropH, ocrBuf };
}

// Legacy parser (no column filter). Accept any ticker-shaped token in lexicon.
function legacyParse(text, lexicon) {
  const tokens = text.split(/[\s,;:()\[\]{}<>\/\\|]+/);
  const seen = new Set();
  const accepted = [];
  for (const tok of tokens) {
    const stripped = tok.replace(/^\|+|\|+$/g, '');
    const cleaned = stripped.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (!/^[A-Z][A-Z0-9]{0,4}$/.test(cleaned)) continue;
    if (lexicon.tickerSet.has(cleaned)) accepted.push(cleaned);
  }
  return accepted;
}

async function main() {
  const { parseChartStreamPositionList } = require(path.join(ROOT, 'src/parse/parseChartStream'));
  const { loadSeedLexiconSync } = require(path.join(ROOT, 'src/normalize/tickerScan'));
  const lexicon = loadSeedLexiconSync();

  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });

  fs.mkdirSync(CROPS_OUT_DIR, { recursive: true });

  const videoResults = [];
  for (const video of VIDEOS) {
    const captures = [];
    const allColumnLists = []; // for multi-frame merge
    const allLegacyLists = [];
    for (const file of video.files) {
      const snapshotPath = path.join(ROOT, video.snapshotsDir, file);
      if (!fs.existsSync(snapshotPath)) continue;

      const { left, top, cropW, cropH, ocrBuf } = await preprocessForOcr(snapshotPath, video.cropOverride);
      const stem = `${video.dateKey}__${file.replace('.png', '')}`;
      const rawPath = path.join(CROPS_OUT_DIR, `${stem}__raw_crop.png`);
      const ocrPath = path.join(CROPS_OUT_DIR, `${stem}__ocr_crop.png`);
      await sharp(snapshotPath).extract({ left, top, width: cropW, height: cropH }).png().toFile(rawPath);
      fs.writeFileSync(ocrPath, ocrBuf);

      const ocrResult = await worker.recognize(ocrBuf, {}, { tsv: true });
      const text = ocrResult.data.text || '';
      const conf = Math.round(ocrResult.data.confidence || 0);
      const tsvLines = (ocrResult.data.tsv || '').split('\n').slice(1).filter(l => l.trim());
      const words = tsvLines.map(l => {
        const c = l.split('\t');
        return { text: (c[11] || '').trim(), left: +c[6], top: +c[7], width: +c[8], height: +c[9], conf: +c[10], line: +c[4] };
      }).filter(w => w.text);

      const ocr = { text, lines: text.split('\n'), words };
      const columnResult = parseChartStreamPositionList({ ocr });
      const detectedColumn = columnResult.position_list;
      const detectedLegacy = legacyParse(text, lexicon);
      allColumnLists.push(detectedColumn);
      allLegacyLists.push(detectedLegacy);

      // Per-capture GT: filename suffix → capture index ('' → 0, '_2' → 1, '_3' → 2).
      // Extract capture index. Standard snapshots use suffix _2/_3 → cap 1/2.
      // Batch snapshots use _i0/_i1/.../_i4 → cap 0/1/2/3/4.
      let captureIdx;
      const iMatch = file.match(/_i(\d+)\.png$/);
      if (iMatch) {
        captureIdx = iMatch[1];
      } else if (file.endsWith('_3.png')) {
        captureIdx = '2';
      } else if (file.endsWith('_2.png')) {
        captureIdx = '1';
      } else {
        captureIdx = '0';
      }
      const gt = gtForCapture(video.dateKey, captureIdx);

      const correctColumn = gt.filter(t => detectedColumn.includes(t));
      const extraColumn = detectedColumn.filter(t => !gt.includes(t));
      const missingColumn = gt.filter(t => !detectedColumn.includes(t));

      const correctLegacy = gt.filter(t => detectedLegacy.includes(t));
      const extraLegacy = detectedLegacy.filter(t => !gt.includes(t));

      // Captures without GT still get evaluated, just don't track recall.
      captures.push({
        file,
        gt,
        crops: {
          // Single level of "../" since the HTML is at tools/qmg_crop_comparison.html
          // and the crops are at data/video_scan_test/_review_crops/.
          raw: '../' + path.relative(ROOT, rawPath).replace(/\\/g, '/'),
          ocr: '../' + path.relative(ROOT, ocrPath).replace(/\\/g, '/'),
        },
        correctColumn,
        correctLegacy,
        extraColumn,
        extraLegacy,
        missingColumn,
        ocrText: text.replace(/</g, '&lt;').slice(0, 600),
        conf,
        detectedColumn,
        detectedLegacy,
      });
    }

    // Multi-frame merge: ticker must appear in ≥2 captures to be accepted.
    // Only enabled for batch snapshots (dateKey contains '(batch'), where
    // the captures are within seconds of each other and show the same
    // position list. Standard captures are minutes apart and not safe to
    // merge.
    const isBatchSnapshot = video.dateKey.includes('(batch');
    let mergedColumn = [];
    let mergedLegacy = [];
    if (isBatchSnapshot) {
      const { mergeMultiplePositionLists } = require(path.join(ROOT, 'src/parse/parseChartStream'));
      mergedColumn = mergeMultiplePositionLists(allColumnLists, { minOccurrences: 2 });
      mergedLegacy = mergeMultiplePositionLists(allLegacyLists, { minOccurrences: 2 });
    }
    // Build the union of GT tickers across all captures of this video.
    // Some videos (20220606) have capture-indexed GT — take the union so
    // the merged aggregate counts tickers that appear in any capture.
    const videoEntry = GT[video.dateKey];
    const gtSet = new Set();
    if (videoEntry) {
      if (Array.isArray(videoEntry)) {
        for (const t of videoEntry) gtSet.add(t);
      } else {
        for (const k of Object.keys(videoEntry)) {
          if (k.startsWith('_')) continue;
          const c = videoEntry[k];
          if (Array.isArray(c)) {
            for (const t of c) gtSet.add(t);
          } else if (c && c.tickers) {
            for (const t of c.tickers) gtSet.add(t);
          }
        }
      }
    }
    const gt = [...gtSet];
    videoResults.push({
      ...video,
      captures,
      mergedColumn: { list: mergedColumn, correct: [], extra: [] },
      mergedLegacy: { list: mergedLegacy, correct: [], extra: [] }
    });
  }

  await worker.terminate();

  // Per-video aggregates
  const aggregateStats = videoResults.map(v => {
    const gt = gtDisplay(v.dateKey);
    const totGT = gt.length;
    // Count UNIQUE tickers found across ALL captures (not summed duplicates)
    const allColumnDetected = new Set();
    const allLegacyDetected = new Set();
    const allColumnCorrect = new Set();
    const allLegacyCorrect = new Set();
    const allColumnFP = new Set();
    const allLegacyFP = new Set();
    for (const c of v.captures) {
      for (const t of c.detectedColumn) allColumnDetected.add(t);
      for (const t of c.detectedLegacy) allLegacyDetected.add(t);
      for (const t of c.correctColumn) allColumnCorrect.add(t);
      for (const t of c.correctLegacy) allLegacyCorrect.add(t);
      for (const t of c.extraColumn) allColumnFP.add(t);
      for (const t of c.extraLegacy) allLegacyFP.add(t);
    }
    const isBatch = v.dateKey.includes('(batch');
    return {
      dateKey: v.dateKey,
      description: v.description,
      gtCount: totGT,
      column: { correct: allColumnCorrect.size, fp: allColumnFP.size, detected: allColumnDetected.size,
                recall: totGT ? Math.round(100 * allColumnCorrect.size / totGT) : 0,
                precision: allColumnDetected.size ? Math.round(100 * allColumnCorrect.size / allColumnDetected.size) : 0 },
      legacy: { correct: allLegacyCorrect.size, fp: allLegacyFP.size, detected: allLegacyDetected.size,
                recall: totGT ? Math.round(100 * allLegacyCorrect.size / totGT) : 0,
                precision: allLegacyDetected.size ? Math.round(100 * allLegacyCorrect.size / allLegacyDetected.size) : 0 },
      mergedLegacy: isBatch ? v.mergedLegacy : null,
    };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quullamaggie Position-List OCR — Crop & Detection Review</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: #0d0d0d; color: #e0e0e0; padding: 20px; }
  h1 { color: #fff; margin-bottom: 5px; }
  h2 { color: #fff; margin-top: 30px; border-bottom: 1px solid #333; padding-bottom: 8px; }
  table.summary { border-collapse: collapse; width: 100%; margin: 15px 0 25px; background: #1a1a1a; border-radius: 6px; overflow: hidden; }
  table.summary th { background: #2a2a2a; padding: 10px 12px; text-align: left; font-size: 12px; color: #fff; border-bottom: 1px solid #333; }
  table.summary td { padding: 10px 12px; font-size: 13px; border-bottom: 1px solid #2a2a2a; }
  table.summary td.good { color: #6d6; font-weight: 600; }
  table.summary td.bad { color: #f66; font-weight: 600; }
  table.summary td.warn { color: #fc6; font-weight: 600; }
  .legend { background: #1a1a1a; border: 1px solid #333; padding: 15px; border-radius: 6px; margin-bottom: 20px; font-size: 12px; line-height: 1.6; }
  .legend code { background: #2a2a2a; padding: 2px 5px; border-radius: 3px; }
  .capture-row { display: grid; grid-template-columns: 220px 280px 1fr; gap: 15px; margin: 15px 0; padding: 15px; background: #1a1a1a; border-radius: 6px; border: 1px solid #333; }
  .crop-box { background: #000; border: 1px solid #333; border-radius: 4px; padding: 8px; text-align: center; }
  .crop-box img { width: 100%; height: auto; display: block; border-radius: 3px; }
  .crop-box .crop-label { font-size: 11px; color: #888; margin-bottom: 6px; }
  .detection-box { padding: 0 5px; }
  .ticker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 5px; margin-bottom: 10px; }
  .ticker { padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; text-align: center; }
  .ticker.gt-correct { background: #1a3a1a; color: #6d6; border: 1px solid #4a4; }
  .ticker.gt-missed  { background: #3a1a1a; color: #f88; border: 1px dashed #f44; opacity: 0.7; }
  .ticker.fp         { background: #3a2a1a; color: #fa6; border: 1px solid #f84; }
  .gt-list-label { font-size: 11px; color: #888; margin-top: 8px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
  .ocr-text { font-family: monospace; font-size: 11px; color: #999; background: #0a0a0a; padding: 8px; border-radius: 3px; max-height: 140px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 10px; }
  .recall-row { display: flex; gap: 20px; margin: 10px 0; font-size: 14px; }
  .recall-row .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .capture-title { font-size: 14px; color: #fff; font-weight: 600; margin-bottom: 4px; }
  .missing-banner { background: #3a1a1a; border-left: 4px solid #f44; padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 12px; color: #faa; }
</style>
</head>
<body>
<h1>Quullamaggie Position-List OCR — Crop & Detection Review</h1>
<p style="color:#888">For each capture: <b>Raw crop</b> = 250×434px region from snapshot (parser input). <b>OCR crop</b> = 3× upscaled, inverted, contrast-boosted image fed to Tesseract. <b>Detection box</b> = both parsers' results side-by-side, color-coded.</p>
<p style="color:#888"><b>OCR is re-run for every capture</b> so legacy and column-aware parsers are compared on identical Tesseract output (Tesseract is non-deterministic across runs).</p>

<div class="legend">
  <p><b>Color coding:</b> <span class="ticker gt-correct">Green</span> = GT ticker correctly detected. <span class="ticker gt-missed">Red dashed</span> = GT ticker MISSED. <span class="ticker fp">Orange</span> = false positive (detected but not in GT).</p>
  <p><b>Three parser configurations compared:</b></p>
  <ul style="margin:4px 0 4px 24px">
    <li><b>Single-capture legacy</b> — accept any ticker-shape token in the seed lexicon.</li>
    <li><b>Single-capture column-aware</b> — only accept ticker-shape words that land in the dominant ticker column AND have a price token to their RIGHT on the same line.</li>
    <li><b>Multi-frame merge (≥2/3 captures)</b> — accept tickers that survive across multiple captures of the same video. Dramatically reduces FPs from single-frame OCR garbling.</li>
  </ul>
</div>

<h2>Per-video aggregate (across all captures)</h2>
<table class="summary">
  <tr>
    <th rowspan="2">Date</th>
    <th rowspan="2">GT tickers</th>
    <th colspan="2">Legacy (single capture)</th>
    <th colspan="2">Column-aware (single)</th>
    <th colspan="2">Multi-frame merge (batch only)</th>
  </tr>
  <tr>
    <th>Recall</th><th>Precision (FPs)</th>
    <th>Recall</th><th>Precision (FPs)</th>
    <th>Recall</th><th>Precision (FPs)</th>
  </tr>
${aggregateStats.map(s => `
  <tr>
    <td><b>${s.dateKey}</b><br><span style="color:#888; font-size:11px">${s.description}</span></td>
    <td>${s.gtCount}</td>
    <td class="${s.legacy.recall >= 50 ? 'good' : s.legacy.recall >= 25 ? 'warn' : 'bad'}">${s.legacy.recall}% (${s.legacy.correct}/${s.gtCount})</td>
    <td class="${s.legacy.fp <= 1 ? 'good' : 'bad'}">${s.legacy.precision}% (${s.legacy.fp} FPs)</td>
    <td class="${s.column.recall >= 50 ? 'good' : s.column.recall >= 25 ? 'warn' : 'bad'}">${s.column.recall}% (${s.column.correct}/${s.gtCount})</td>
    <td class="${s.column.fp <= 1 ? 'good' : 'bad'}">${s.column.precision}% (${s.column.fp} FPs)</td>
    ${s.mergedLegacy ? `
    <td class="${s.mergedLegacy.recall >= 50 ? 'good' : s.mergedLegacy.recall >= 25 ? 'warn' : 'bad'}">${s.mergedLegacy.recall}% (${s.mergedLegacy.correct}/${s.gtCount})</td>
    <td class="${s.mergedLegacy.fp <= 1 ? 'good' : 'bad'}">${s.mergedLegacy.precision}% (${s.mergedLegacy.fp} FPs)</td>
    ` : '<td colspan="2" style="color:#666">n/a (captures minutes apart)</td>'}
  </tr>`).join('')}
</table>
<p style="color:#888; font-size:11px; margin-top:6px">
  <b>Reading the table:</b> Each cell shows recall (correct / GT) and precision (FPs).
  "Legacy" = any ticker-shape token in lexicon. "Column-aware" = only tickers in the
  dominant column with price-on-right. For batch snapshots only (where multiple
  captures are within seconds), a "Multi-frame merge" column shows the ≥2/5
  consensus result.
</p>

${videoResults.map(v => {
  // Build display GT: union of all per-capture GTs, or "no GT" if none.
  const displayGT = gtDisplay(v.dateKey);
  return `
<h2>${v.dateKey} — ${v.description}</h2>
<p style="color:#888; font-size:12px;">GT: ${displayGT.length ? displayGT.join(', ') : '<span style="color:#666">(no GT — visual review only)</span>'}</p>

${v.mergedLegacy && v.mergedLegacy.list && v.mergedLegacy.list.length > 0 ? `
<div style="background:#1a1a1a; border-left:4px solid #6d6; padding:10px 14px; border-radius:4px; margin:8px 0; font-size:12px;">
  <b style="color:#6d6">Multi-frame merge (≥2/${v.captures.length} captures):</b>
  &nbsp;<b>Detected:</b> <span style="color:#fff">${v.mergedLegacy.list.join(', ') || '∅'}</span>
  &nbsp;<span style="color:#888">(GT missed: ${displayGT.filter(t => !v.mergedLegacy.list.includes(t)).join(', ') || '(none)'})</span>
</div>` : ''}

${v.captures.map((cap, idx) => {
  // Per-capture GT (varies between captures in some videos)
  const capGT = cap.gt || [];
  return `
  <div class="capture-row">
    <div class="crop-box">
      <div class="crop-label">RAW CROP<br><span style="font-size:10px">(parser input, 250×434px)</span></div>
      <img src="${cap.crops.raw}" alt="raw crop ${idx}">
    </div>
    <div class="crop-box">
      <div class="crop-label">OCR CROP<br><span style="font-size:10px">(3× scale + invert + sharpen)</span></div>
      <img src="${cap.crops.ocr}" alt="ocr crop ${idx}">
      <div style="color:#888; font-size:11px; margin-top:6px">OCR conf: ${cap.conf}</div>
    </div>
    <div class="detection-box">
      <div class="capture-title">${cap.file}</div>

      <div class="recall-row">
        <div>
          <div class="label">Legacy parser</div>
          <div class="${cap.correctLegacy.length >= capGT.length * 0.6 ? 'good' : cap.correctLegacy.length >= 2 ? 'warn' : 'bad'}" style="font-size:16px; font-weight:600;">
            ${cap.correctLegacy.length}/${capGT.length} correct, ${cap.extraLegacy.length} FP
          </div>
        </div>
        <div>
          <div class="label">Column-aware parser</div>
          <div class="${cap.correctColumn.length >= capGT.length * 0.6 ? 'good' : cap.correctColumn.length >= 2 ? 'warn' : 'bad'}" style="font-size:16px; font-weight:600;">
            ${cap.correctColumn.length}/${capGT.length} correct, ${cap.extraColumn.length} FP
          </div>
        </div>
      </div>

      ${cap.missingColumn.length > 0 ? `
        <div class="missing-banner">⚠ Missed GT tickers (column-aware): <b>${cap.missingColumn.join(', ')}</b> — check OCR crop to see if Tesseract garbled these</div>
      ` : ''}

      <div class="gt-list-label">Ground truth tickers (${capGT.length})</div>
      <div class="ticker-grid">
        ${capGT.map(t => {
          const colHit = cap.correctColumn.includes(t);
          const legHit = cap.correctLegacy.includes(t);
          let cls = 'gt-missed';
          if (colHit && legHit) cls = 'gt-correct';
          else if (colHit) cls = 'gt-correct';
          else if (legHit) cls = 'gt-correct';
          return `<div class="ticker ${cls}" title="Detected: ${legHit ? 'legacy✓' : 'legacy✗'} ${colHit ? 'column✓' : 'column✗'}">${t}</div>`;
        }).join('')}
      </div>

      ${cap.extraLegacy.length > 0 || cap.extraColumn.length > 0 ? `
        <div class="gt-list-label">False positives (orange = FPs; column-aware should have FEWER)</div>
        <div class="ticker-grid">
          ${cap.extraColumn.map(t => `<div class="ticker fp" title="Column-aware FP">${t}</div>`).join('')}
          ${cap.extraLegacy.filter(t => !cap.extraColumn.includes(t)).map(t => `<div class="ticker fp" title="Legacy-only FP (column filter rejected)" style="background:#2a1a1a">${t}*</div>`).join('')}
        </div>
      ` : '<div style="color:#4a4; font-size:11px; margin-top:8px">✓ Zero false positives on both parsers</div>'}

      <div class="gt-list-label">OCR text (Tesseract output)</div>
      <div class="ocr-text">${cap.ocrText || '(empty)'}</div>
    </div>
  </div>
`;
}).join('')}
`;
}).join('')}
</body>
</html>`;

  const outPath = path.join(ROOT, 'tools', 'qmg_crop_comparison.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('Written:', outPath);
  console.log('Total captures shown:', videoResults.reduce((sum, v) => sum + v.captures.length, 0));
  console.log('Crops in:', CROPS_OUT_DIR);
}

main().catch((err) => { console.error(err); process.exit(1); });
