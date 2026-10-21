'use strict';

// Benchmark EasyOCR recognition settings against ground truth using crops
// captured by `scanVideoWithOcr.js --keep-ocr-crops`.
//
// Why this exists: a full re-scan costs ~12 min/video because EasyOCR runs
// ~60s/frame, so recognition settings could not be A/B tested at all. Once the
// panel crops are on disk, the same question costs seconds per setting and the
// answer is a table instead of a guess.
//
// Pipeline per setting: crop PNG -> EasyOCR -> parseChartStreamPositionList ->
// score against data/qmg_ground_truth.json for the crop's date.
//
// Usage:
//   node tools/qmgOcrBenchmark.js --crops <dir> [--date <yyyymmdd>] [--set <name>]
//   node tools/qmgOcrBenchmark.js --crops data/video_ocr_probe/crop-harvest/ocr_probe/crops
//
// The crop filename encodes the timestamp (crop_<ts>.png) and the parent
// directory encodes the probe key (which embeds the date), so each crop is
// attributed to its GT date automatically.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const { runEasyOcrBatch, adaptToParserSchema } = require('../src/ocr/easyocrAdapter');
const { parseChartStreamPositionList, identifyPositionListColumn } = require('../src/parse/parseChartStream');

const GT_PATH = path.resolve(__dirname, '..', 'data', 'qmg_ground_truth.json');

// The EasyOCR crop is produced by ffmpeg at this scale (EASYOCR_SCALE in
// scanVideoWithOcr.js). Kept in sync with a comment rather than imported,
// because the scanner exposes it only inside the OCR branch.
const CROP_SCALE = 5;

const TICKER_ALLOWLIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.';

// Candidate settings. `baseline` must stay first and must reproduce today's
// behaviour exactly (no tuning keys at all) so every other row is measured
// against the status quo.
//
// `columnPass` is the structural variant: after pass 1 locates the ticker
// column, re-crop to just that column and OCR the strip on its own. That is
// aimed at the measured root cause — EasyOCR's DETECTOR merges the ticker with
// its neighbouring price columns ("090Si 18,33", "801a| 13,66") and the
// recognizer then decodes one long mixed string. With no price column in frame
// there is nothing to merge with.
const SETTINGS = [
  { name: 'baseline (no tuning)', tuning: {} },
  { name: 'allowlist', tuning: { allowlist: TICKER_ALLOWLIST } },
  { name: 'split (width_ths+margin)', tuning: { width_ths: 0.3, add_margin: 6 } },
  {
    name: 'column-isolated',
    tuning: {},
    columnPass: true,
    columnHalfWidth: 220,
    columnScale: 2,
  },
  {
    name: 'column-isolated + allowlist',
    tuning: { allowlist: TICKER_ALLOWLIST },
    columnPass: true,
    columnHalfWidth: 220,
    columnScale: 2,
  },
];

function parseCli(argv) {
  const opts = { crops: null, date: null, set: null, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--crops') opts.crops = argv[++i];
    else if (argv[i] === '--date') opts.date = argv[++i];
    else if (argv[i] === '--set') opts.set = argv[++i];
    else if (argv[i] === '--limit') opts.limit = Number(argv[++i]);
  }
  return opts;
}

// Harvest layout: <cropsRoot>/<probeKey>/crop_<ts>.png where probeKey embeds
// the date as its first token (createProbeKey -> `<datekey>_<...>`).
function collectCrops(cropsRoot, dateFilter) {
  const out = [];
  let probeDirs;
  try {
    probeDirs = fs.readdirSync(cropsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const probeKey of probeDirs) {
    const dateMatch = /^(\d{8})/.exec(probeKey);
    if (!dateMatch) continue;
    const dateKey = dateMatch[1];
    if (dateFilter && dateKey !== dateFilter) continue;
    const dir = path.join(cropsRoot, probeKey);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
    } catch {
      continue;
    }
    for (const file of files) out.push({ dateKey, probeKey, file: path.join(dir, file) });
  }
  out.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.file.localeCompare(b.file));
  return out;
}

function gtForDate(gt, dateKey) {
  const entry = gt[dateKey];
  if (!entry) return null;
  const all = new Set();
  for (const value of Object.values(entry)) {
    if (Array.isArray(value)) for (const t of value) all.add(String(t).toUpperCase());
  }
  return all.size ? all : null;
}

// Crop the ticker column out of a panel image into a temp PNG, for pass 2.
// Widens the detected column to cover a full 5-character ticker — the parser's
// own `columnWidth` of 50px is narrower than one word box (~110-150px) and
// would clip the glyphs we are trying to read.
async function cropTickerColumn(cropFile, dominantX, halfWidth, scale) {
  const meta = await sharp(cropFile).metadata();
  const imageWidth = meta.width;
  const left = Math.max(0, Math.round(dominantX - halfWidth));
  const width = Math.min(imageWidth - left, Math.round(halfWidth * 2));
  if (width <= 8) return null;
  const out = path.join(
    os.tmpdir(),
    `qmg_bench_col_${process.pid}_${Math.round(dominantX)}.png`
  );
  let pipeline = sharp(cropFile).extract({ left, top: 0, width, height: meta.height });
  if (scale && scale !== 1) {
    pipeline = pipeline.resize(Math.round(width * scale), null, { kernel: 'lanczos3' });
  }
  await pipeline.png().toFile(out);
  return { file: out, cleanup: true };
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  if (!opts.crops) {
    console.error('usage: node tools/qmgOcrBenchmark.js --crops <dir> [--date <yyyymmdd>] [--set <name>] [--limit <n>]');
    process.exitCode = 1;
    return;
  }
  const gt = JSON.parse(fs.readFileSync(GT_PATH, 'utf8'));
  let crops = collectCrops(opts.crops, opts.date);
  if (opts.limit) crops = crops.slice(0, opts.limit);
  if (!crops.length) {
    console.error(`no crops found under ${opts.crops}${opts.date ? ` for ${opts.date}` : ''}`);
    process.exitCode = 1;
    return;
  }

  const withGt = crops.filter((c) => gtForDate(gt, c.dateKey));
  if (!withGt.length) {
    console.error('crops found, but none map to a ground-truth date');
    process.exitCode = 1;
    return;
  }

  const expected = new Set();
  for (const dateKey of new Set(withGt.map((c) => c.dateKey))) {
    for (const t of gtForDate(gt, dateKey)) expected.add(t);
  }

  console.log(`${withGt.length} crop(s), ${expected.size} GT ticker(s) across `
    + `${new Set(withGt.map((c) => c.dateKey)).size} date(s)`);
  console.log('');

  const settings = opts.set
    ? SETTINGS.filter((s) => s.name === opts.set)
    : SETTINGS;
  if (!settings.length) {
    console.error(`unknown setting "${opts.set}". known: ${SETTINGS.map((s) => s.name).join(' | ')}`);
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const setting of settings) {
    const predicted = new Set();
    let failures = 0;
    const started = Date.now();

    // Pass 1: every crop in ONE process (one model load for the whole set).
    let pass1;
    try {
      pass1 = await runEasyOcrBatch(withGt.map((c) => c.file), { ...setting.tuning, timeoutMs: 600000 });
    } catch (err) {
      console.error(`  [${setting.name}] pass 1 failed: ${String(err.message).slice(0, 160)}`);
      rows.push({ name: setting.name, recall: 0, precision: 0, hit: 0, expected: expected.size, predicted: 0, missed: [...expected], fp: [], elapsed: 0, failures: withGt.length });
      continue;
    }

    const parsedList = pass1.map((raw, i) => {
      if (!raw || raw.error) {
        failures += 1;
        return null;
      }
      const ocr = adaptToParserSchema(raw);
      return { crop: withGt[i], ocr, parsed: parseChartStreamPositionList({ ocr }) };
    }).filter(Boolean);

    // Pass 2 (column-isolated variants only): re-crop each panel to its own
    // ticker column and OCR the strip alone.
    if (setting.columnPass) {
      const strips = [];
      const owners = [];
      for (const entry of parsedList) {
        const col = identifyPositionListColumn(entry.ocr.words || [], entry.ocr._cropWidth);
        if (col.dominantColumnX == null) continue;
        const cropped = await cropTickerColumn(
          entry.crop.file, col.dominantColumnX, setting.columnHalfWidth, setting.columnScale
        );
        if (cropped) {
          strips.push(cropped.file);
          owners.push(entry);
        }
      }
      if (strips.length) {
        try {
          const stripResults = await runEasyOcrBatch(strips, { ...setting.tuning, timeoutMs: 600000 });
          stripResults.forEach((raw, i) => {
            if (!raw || raw.error) return;
            const ocr = adaptToParserSchema(raw);
            const parsed = parseChartStreamPositionList({ ocr });
            // Pass 2 is authoritative for the column, but a column-isolated
            // read can also legitimately come back empty — keep pass 1's
            // answer in that case rather than losing the whole frame.
            if (parsed.position_list.length) {
              for (const t of parsed.position_list) predicted.add(String(t).toUpperCase());
            } else {
              for (const t of owners[i].parsed.position_list) predicted.add(String(t).toUpperCase());
            }
          });
          for (const s of strips) { try { fs.unlinkSync(s); } catch (_) { /* ignore */ } }
        } catch (err) {
          console.error(`  [${setting.name}] pass 2 failed: ${String(err.message).slice(0, 160)}`);
          for (const entry of parsedList) {
            for (const t of entry.parsed.position_list) predicted.add(String(t).toUpperCase());
          }
        }
      } else {
        for (const entry of parsedList) {
          for (const t of entry.parsed.position_list) predicted.add(String(t).toUpperCase());
        }
      }
    } else {
      for (const entry of parsedList) {
        for (const t of entry.parsed.position_list) predicted.add(String(t).toUpperCase());
      }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    const hit = [...predicted].filter((t) => expected.has(t));
    rows.push({
      name: setting.name,
      recall: expected.size ? (hit.length / expected.size) * 100 : 0,
      precision: predicted.size ? (hit.length / predicted.size) * 100 : 0,
      hit: hit.length,
      expected: expected.size,
      predicted: predicted.size,
      missed: [...expected].filter((t) => !predicted.has(t)),
      fp: [...predicted].filter((t) => !expected.has(t)),
      elapsed,
      failures,
    });
  }

  for (const r of rows) {
    const flag = r.failures ? `  (${r.failures} crop failure(s))` : '';
    console.log(
      `${r.name.padEnd(28)} recall=${r.recall.toFixed(1).padStart(5)}%  `
      + `precision=${r.precision.toFixed(1).padStart(5)}%  `
      + `${r.hit}/${r.expected} gt, ${r.predicted} pred, ${r.elapsed}s${flag}`
    );
    if (r.missed.length) console.log(`${''.padEnd(28)} missed: ${r.missed.join(' ')}`);
    if (r.fp.length) console.log(`${''.padEnd(28)} fp    : ${r.fp.join(' ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});