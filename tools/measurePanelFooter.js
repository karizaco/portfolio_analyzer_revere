'use strict';

// Can the panel's own row-count footer be READ? Measured, per era, per engine.
//
// WHY THIS EXISTS
//
// `readPanelRowCount` is the project's only INDEPENDENT check on a reading:
// the panel prints how many rows it has, so a reading with a different number
// of tickers has provably dropped a row or invented one. In production it
// reports `null` on every capture, and the reason is the pixels, not the
// reader -- the footer sits BELOW the crop's bottom edge (source y 950 in the
// 2022 era, 994 in the 2023 era).
//
// CLAUDE.md proposes a dedicated footer strip at source y ~1000-1040. Before
// building that, two things had to be measured, because a strip built on a
// wrong assumption reads nothing while looking like a working feature:
//
//   1. is the footer actually in that band?
//   2. can an OCR engine read it at that size?
//
// WHAT WAS MEASURED (2026-11-05, on qmg_20220218.png)
//
// The footer IS in the band -- y 1000-1040 contains it. But the ENGINE
// matters, and the project's default is the wrong one for this read:
//
//   engine      reading of "3 of 9 Items in Personal WatchList"
//   EasyOCR     "30 Iem inecronal acha LiX"      <- garbage, at 6x/8x/12x
//   Tesseract   "3 of 9 Items In Personal Watchlist"  <- exact
//
// EasyOCR's failure is not merely a miss: "3 of 9" collapses to "30", so the
// COUNT would be read WRONG. A wrong count is worse than no count, which is
// the project's own standing rule.
//
// That inversion is consistent with CLAUDE.md's own engine table. The footer
// is a long line of printed prose, which is what Tesseract (document-trained)
// is for; the ticker column is short isolated tokens on a dark panel, which is
// what EasyOCR (scene-text-trained) is for. The right engine depends on the
// TEXT, not on the project.
//
// This tool needs NO video: the 94 tracked ground-truth fixtures each name a
// source snapshot, and all 94 are 1920x1080 frames on disk. The manifest also
// carries the human reading of each footer (`panel_count_text`) and the count
// (`panel_count`), so every strip reading can be scored.
//
//   node tools/measurePanelFooter.js                 # both engines, 8 dates
//   node tools/measurePanelFooter.js --engine tesseract --limit 20
//   node tools/measurePanelFooter.js --dates 20220218,20231215 --json

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const { runEasyOcr, adaptToParserSchema } = require('../src/ocr/easyocrAdapter');
const {
  panelFooterStripForDate, panelFooterStripsForDate,
  readPanelFooterText, resolvePanelFooterVotes,
} = require('../src/video/panelFooter');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'qmg_ground_truth');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');

function parseArgs(argv) {
  const args = { limit: 8, dates: null, json: false, engines: ['tesseract', 'easyocr'], y: null, h: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--dates') args.dates = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--engine') args.engines = [String(argv[++i] || '').toLowerCase()];
    else if (a === '--json') args.json = true;
    else if (a === '--y') args.y = Number(argv[++i]);
    else if (a === '--h') args.h = Number(argv[++i]);
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

async function cutStrip(sourcePath, dateKey, outPath, override = {}) {
  const base = panelFooterStripForDate(dateKey);
  const strip = {
    ...base,
    y: override.y == null ? base.y : override.y,
    h: override.h == null ? base.h : override.h,
  };
  const meta = await sharp(sourcePath).metadata();
  const left = Math.round(strip.x * meta.width);
  const top = Math.round(strip.y * meta.height);
  const width = Math.min(Math.round(strip.w * meta.width), meta.width - left);
  const height = Math.min(Math.round(strip.h * meta.height), meta.height - top);
  await sharp(sourcePath)
    .extract({ left, top, width, height })
    .resize({ width: width * strip.upscale, kernel: 'lanczos3' })
    .grayscale()
    .normalise()
    .png()
    .toFile(outPath);
  return { left, top, width, height, upscale: strip.upscale, sourceWidth: meta.width };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const cases = (Array.isArray(manifest) ? manifest : manifest.cases)
    .filter((c) => c.panel === 'positions' && c.panel_count != null)
    .filter((c) => !args.dates || args.dates.includes(c.date))
    .filter((c) => c.source && fs.existsSync(path.join(ROOT, c.source)));

  // One capture per date, so a small run still covers both layout eras.
  const byDate = new Map();
  for (const c of cases) if (!byDate.has(c.date)) byDate.set(c.date, c);
  const picked = [...byDate.values()].slice(0, args.limit);
  if (!picked.length) throw new Error('no fixture cases with a source snapshot on disk');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-footer-'));
  let worker = null;
  const results = [];

  try {
    for (const c of picked) {
      const sourcePath = path.join(ROOT, c.source);
      const stripPath = path.join(tmpDir, `${c.date}_${c.capture_index}.png`);
      const bands = args.y == null
        ? panelFooterStripsForDate(c.date)
        : [{ y: args.y }];
      const geom = await cutStrip(sourcePath, c.date, stripPath, { y: bands[0].y, h: args.h });
      const row = {
        date: c.date,
        era: c.date >= '20230518' ? 'right_sidebar' : 'floating_panel',
        capture_index: c.capture_index,
        expected_count: c.panel_count,
        expected_text: c.panel_count_text,
        geometry: geom,
        engines: {},
      };

      for (const engine of args.engines) {
        const readings = [];
        const raws = [];
        for (const band of bands) {
          const bandPath = path.join(tmpDir, `${c.date}_${c.capture_index}_${band.y}.png`);
          await cutStrip(sourcePath, c.date, bandPath, { y: band.y, h: args.h });
          let text = '';
          if (engine === 'tesseract') {
            if (!worker) worker = await createWorker('eng');
            const r = await worker.recognize(bandPath);
            text = String((r.data && r.data.text) || '');
          } else {
            const o = adaptToParserSchema(await runEasyOcr(bandPath, {}), { engine: 'easyocr' });
            text = String(o.text || '');
          }
          const read = readPanelFooterText(text);
          raws.push(`y=${band.y}:${read ? read.count : '-'}`);
          readings.push({ count: read ? read.count : null, band: band.y, text: read ? read.text : null });
        }
        const resolved = resolvePanelFooterVotes(readings);
        row.engines[engine] = {
          raw: raws.join(' '),
          perBand: readings.map((r) => ({ band: r.band, count: r.count })),
          count: resolved ? resolved.count : null,
          votes: resolved ? resolved.votes : 0,
          footer: resolved ? resolved.text : null,
          rejected: resolved ? resolved.rejected : [],
          agrees: Boolean(resolved) && resolved.count === c.panel_count,
        };
      }
      results.push(row);

      if (!args.json) {
        console.log(`\n${row.date}  ${row.era}  (manifest ${row.expected_count}: "${row.expected_text}")`);
        for (const engine of args.engines) {
          const e = row.engines[engine];
          const mark = e.agrees ? 'OK  ' : (e.count == null ? 'NONE' : 'WRONG');
          console.log(`  ${engine.padEnd(10)} ${mark} count=${String(e.count).padStart(4)}  raw="${e.raw}"`);
        }
      }
    }
  } finally {
    if (worker) await worker.terminate();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* scratch */ }
  }

  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return;
  }

  console.log('\n=== summary ===');
  for (const engine of args.engines) {
    const agree = results.filter((r) => r.engines[engine].agrees).length;
    const wrong = results.filter((r) => r.engines[engine].count != null && !r.engines[engine].agrees);
    const none = results.filter((r) => r.engines[engine].count == null).length;
    console.log(`${engine.padEnd(10)} agrees ${agree}/${results.length}   wrong ${wrong.length}   no-read ${none}`);
    for (const r of wrong) {
      console.log(`   WRONG ${r.date}: read ${r.engines[engine].count}, panel says ${r.expected_count}`);
    }
  }
  const byEra = {};
  for (const r of results) {
    const e = byEra[r.era] || (byEra[r.era] = { n: 0, ok: 0 });
    e.n += 1;
    if (r.engines[args.engines[0]].agrees) e.ok += 1;
  }
  console.log(`\nby era (${args.engines[0]}):`);
  for (const [era, v] of Object.entries(byEra)) console.log(`  ${era.padEnd(16)} ${v.ok}/${v.n}`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
