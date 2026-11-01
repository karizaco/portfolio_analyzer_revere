#!/usr/bin/env node
'use strict';
// Build the pinned ground-truth fixture set.
//
// WHY THIS EXISTS
// ---------------
// `data/qmg_ground_truth.json` is a hand-made reading of a TradingView panel.
// It had three defects that were invisible to every test, because nothing
// compared the file to the pixels it claims to describe:
//
//   1. A capture index is RUN-RELATIVE. `qmg_20220218_2.png` holds a
//      different image in every run directory, so "capture 1" means nothing
//      without the run it was read in. The benchmark pinned one run and the
//      ground truth described another.
//   2. The panel prints its own row count ("N Items in Personal WatchList").
//      A ground truth that names more tickers than the panel counts is
//      checkable, and one that names fewer is missing a holding.
//   3. A misread ticker ("DCX" for FCX) is indistinguishable from a real
//      holding once it is in the file.
//
// A fixture set fixes all three: each case is a CROP of the panel, md5-pinned,
// showing both the ticker column and the panel's own footer count. The
// manifest records what the panel said, so the ground truth can be checked
// against an image that is in git.
//
// The corpus these crops are cut from is NOT in git, so the builder is a tool
// (not a test): it re-cuts the crops when the corpus is available. The
// CHECKER is the test -- `tools/checkGroundTruthConsistency.js`.
//
// Usage:
//   node tools/buildGroundTruthFixtures.js            # write the fixtures
//   node tools/buildGroundTruthFixtures.js --check    # verify, do not write

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'test', 'fixtures', 'qmg_ground_truth');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

// The panel region, as fractions of the frame. It is deliberately wide and
// tall enough to hold BOTH the ticker column and the footer line that prints
// the row count, in the 2022-era floating panel and the 2023-era sidebar
// alike -- a crop that hides the count is not evidence of anything.
const CROP = { x: 0.80, y: 0.52, w: 0.20, h: 0.48 };

// The cases, and what the panel said. `tickers` and `panel_count` are what a
// reader of the crop sees; they are cross-checked against
// `data/qmg_ground_truth.json` by the checker, so a ground truth that drifts
// away from the pixels is a failing test rather than a silent edit.
const CASES = [
  // --- 2022-era floating panel (bottom-right) ---
  {
    date: '20220218', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220218.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 9, panel_count_text: '3 of 9 Items in Personal WatchList',
    tickers: ['ROKU', 'TQQQ', 'TSLA', 'FCX', 'COPX', 'MOS', 'NRGU', 'DWAC', 'DVN'],
  },
  {
    date: '20220218', capture_index: 1,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220218_2.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 9, panel_count_text: '9 Items in Personal WatchList',
    tickers: ['UPST', 'DVN', 'NRGU', 'MOS', 'TQQQ', 'TSLA', 'FCX', 'DWAC', 'COPX'],
    benchmark_case: 'trade_ideas',
  },
  {
    date: '20220218', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220218_3.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 9, panel_count_text: '9 Items in Personal WatchList',
    tickers: ['UPST', 'DVN', 'NRGU', 'MOS', 'TQQQ', 'TSLA', 'FCX', 'DWAC', 'COPX'],
  },
  {
    date: '20220222', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220222.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 7, panel_count_text: '6 of 7 Items in Personal WatchList',
    tickers: ['NRGU', 'DVN', 'MOS', 'COPX', 'TQQQ', 'FCX', 'TSLA'],
  },
  {
    date: '20220222', capture_index: 1,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220222_2.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 7, panel_count_text: '7 Items in Personal WatchList',
    tickers: ['NRGU', 'DVN', 'MOS', 'COPX', 'TQQQ', 'FCX', 'TSLA'],
  },
  {
    date: '20220222', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220222_3.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 7, panel_count_text: '2 of 7 Items in Personal WatchList',
    tickers: ['NRGU', 'DVN', 'MOS', 'COPX', 'TQQQ', 'FCX', 'TSLA'],
  },
  {
    date: '20220301', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220301.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 7, panel_count_text: '5 of 7 Items in Personal WatchList',
    tickers: ['GUSH', 'ERX', 'NUGT', 'COPX', 'FCX', 'X', 'MP'],
  },
  {
    date: '20220301', capture_index: 1,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220301_2.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 6, panel_count_text: '6 Items in Personal WatchList',
    tickers: ['GUSH', 'ERX', 'FCX', 'X', 'COPX', 'MP'],
  },
  {
    date: '20220301', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220301_3.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 8, panel_count_text: '8 Items in Personal WatchList',
    tickers: ['GUSH', 'MP', 'NUGT', 'ERX', 'RSX', 'X', 'FCX', 'COPX'],
  },
  {
    date: '20220302', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220302.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 6, panel_count_text: '6 Items in Personal WatchList',
    tickers: ['GUSH', 'ERX', 'COPX', 'X', 'FCX', 'NUGT'],
  },
  {
    date: '20220302', capture_index: 1,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220302_2.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 7, panel_count_text: '7 Items in Personal WatchList',
    tickers: ['NUGT', 'GUSH', 'FCX', 'X', 'ERX', 'COPX', 'AGQ'],
  },
  {
    date: '20220302', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220302_3.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 8, panel_count_text: '1 of 8 Items in Personal WatchList',
    tickers: ['NUGT', 'GUSH', 'FCX', 'X', 'ERX', 'COPX', 'AGQ', 'RSX'],
  },
  // 20220429's three captures are ANCHORED TO TWO DIFFERENT RUNS, and that is
  // not an accident -- it is the only way each capture can be true:
  //
  //   c0  batch2  "6 Items in Personal WatchList"   6 rows (WEAT..SWN)
  //   c1  batch2  "4 Items in Personal WatchList"   4 rows (WEAT..TSLA)
  //   c2  1017    "2 of 5 Items in Personal..."    5 rows (WEAT..GUSH, X)
  //
  // The 1017 run's c0 shows only FOUR rows, so a ground truth claiming six
  // tickers for capture 0 cannot have been read there -- the six-row frame
  // exists only in the batch2 run. Conversely the batch2 run's c2 shows
  // SWN, not X, so capture 2 is the 1017 frame and only the 1017 frame.
  // 20220406's three captures are ALSO anchored to two runs, and the GT's
  // capture order is the reverse of the 1011 run's file order:
  //
  //   c0  batch2  "6 of 7 Items in Personal..."   7 rows, SORTED view
  //   c1  batch2  "6 of 7 Items in Personal..."   7 rows, same frame
  //   c2  1011    "1 of 8 Items in Personal..."   8 rows, incl. LMT
  //
  // The 1011 run's OWN file order is [8, 8, 7] -- its base file is the
  // eight-row LMT frame -- so a capture index alone cannot say which frame
  // is meant, and the manifest's `source` column is the only thing that can.
  {
    date: '20220406', capture_index: 0,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch2/snapshots/qmg_20220406_3.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch2',
    panel_count: 7, panel_count_text: '6 of 7 Items in Personal WatchList',
    tickers: ['X', 'FCX', 'REGN', 'COPX', 'NUGT', 'NEM', 'LHX'],
    note: 'The seven-row SORTED view. The 1011 run\'s capture 0 is the eight-row LMT frame, so the index alone does not identify the frame.',
  },
  {
    date: '20220406', capture_index: 1,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch2/snapshots/qmg_20220406_6.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch2',
    panel_count: 7, panel_count_text: '6 of 7 Items in Personal WatchList',
    tickers: ['X', 'FCX', 'REGN', 'COPX', 'NUGT', 'NEM', 'LHX'],
    note: 'The same seven-row reading as capture 0, in a second snapshot file of the same run.',
  },
  {
    date: '20220406', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261011/snapshots/qmg_20220406.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261011',
    panel_count: 8, panel_count_text: '1 of 8 Items in Personal WatchList',
    tickers: ['FCX', 'COPX', 'X', 'LHX', 'NUGT', 'LMT', 'NEM', 'REGN'],
    note: 'The eight-row frame, which carries LMT. In this run it is capture 0, not capture 2.',
  },
  {
    date: '20220429', capture_index: 0,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch2/snapshots/qmg_20220429.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch2',
    panel_count: 6, panel_count_text: '6 Items in Personal WatchList',
    tickers: ['WEAT', 'GUSH', 'UCO', 'TSLA', 'X', 'SWN'],
    note: 'The six-row frame exists only in the batch2 run; the 1017 run\'s capture 0 shows four rows.',
  },
  {
    date: '20220429', capture_index: 1,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch2/snapshots/qmg_20220429_2.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch2',
    panel_count: 4, panel_count_text: '4 Items in Personal WatchList',
    tickers: ['WEAT', 'GUSH', 'UCO', 'TSLA'],
    note: 'The 1017 run\'s capture 1 shows the same four rows, so this reading is not run-specific.',
  },
  {
    date: '20220429', capture_index: 2,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261017/snapshots/qmg_20220429_3.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261017',
    panel_count: 5, panel_count_text: '2 of 5 Items in Personal WatchList',
    tickers: ['WEAT', 'TSLA', 'UCO', 'X', 'GUSH'],
    note: 'The batch2 run\'s capture 2 shows SWN, not X; only the 1017 frame carries X.',
  },
  {
    date: '20220606', capture_index: 0,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 8, panel_count_text: '8 Items in Personal WatchList',
    tickers: ['GOVX', 'LABU', 'UCO', 'ALB', 'CBIO', 'VLO', 'TNA', 'NFLX'],
  },
  {
    date: '20220606', capture_index: 1,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606_2.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 8, panel_count_text: '8 Items in Personal WatchList',
    tickers: ['GOVX', 'LABU', 'UCO', 'ALB', 'CBIO', 'VLO', 'TNA', 'NFLX'],
    benchmark_case: 'normal_2022',
  },
  {
    // The GT read this frame's first ticker as BOIL while all eleven sibling
    // captures read GOVX -- the substitution signature of a misread, not of a
    // changed position list. The panel reads GOVX and counts eight items.
    date: '20220606', capture_index: 3,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20220606_4.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 8, panel_count_text: '8 Items in Personal WatchList',
    tickers: ['GOVX', 'LABU', 'UCO', 'ALB', 'CBIO', 'VLO', 'TNA', 'NFLX'],
    note: 'The ground truth read the first ticker as BOIL here. The panel reads GOVX; corrected 2026-11-01.',
  },
  {
    date: '20221104', capture_index: 0,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20221104.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 1, panel_count_text: '1 Item in Personal WatchList',
    tickers: ['OIH'],
    benchmark_case: 'sparse',
  },
  {
    // Capture 1 was missing from the ground truth entirely, although the
    // snapshot exists and the panel shows the same single holding.
    date: '20221104', capture_index: 1,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20221104_2.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 1, panel_count_text: '1 Item in Personal WatchList',
    tickers: ['OIH'],
    note: 'Added 2026-11-01: the capture was absent from the ground truth, although the snapshot exists and reads OIH.',
  },
  {
    date: '20221104', capture_index: 2,
    panel: 'positions',
    source: 'data/video_ocr_probe/qmg-1080p-batch1/snapshots/qmg_20221104_3.png',
    run: 'data/video_ocr_probe/qmg-1080p-batch1',
    panel_count: 1, panel_count_text: '1 of 1 Item in Personal WatchList',
    tickers: ['OIH'],
    note: 'The panel says "1 of 1 Item" -- the plural follows the TOTAL, not the selected row.',
  },

  // --- 2023-era right sidebar ---
  {
    date: '20230518', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261017/snapshots/qmg_20230518.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261017',
    panel_count: 8, panel_count_text: '8 Items in Personal WatchList',
    tickers: ['APLD', 'AI', 'PLTR', 'CVNA', 'IMGN', 'SHOP', 'MNDY', 'LI'],
  },
  {
    date: '20230609', capture_index: 0,
    panel: 'positions',
    source: 'data/video_scan_test/_rerun/qmg-easyocr-20261012/snapshots/qmg_20230609.png',
    run: 'data/video_scan_test/_rerun/qmg-easyocr-20261012',
    panel_count: 13, panel_count_text: '13 Items in Personal WatchList',
    tickers: ['RGTI', 'QBTS', 'IMGN', 'CVNA', 'IOT', 'ARQQ', 'AI', 'PLTR', 'DNA', 'GTLB', 'GSIT', 'APLD', 'MNDY'],
    benchmark_case: 'dense_2023',
  },
];

function ffmpegBin() {
  // The WinGet package directory uses UNDERSCORES ("Gyan.FFmpeg_Microsoft..."),
  // not the dotted form -- a dotted path here silently falls through to the
  // bare "ffmpeg", which may not be on PATH.
  const winGet = 'C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages';
  const candidates = [
    path.join(REPO, 'tools', 'ffmpeg.exe'),
    path.join(winGet, 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe'),
    path.join(winGet, 'Gyan.FFmpeg.Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin', 'ffmpeg.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'ffmpeg';
}

function md5File(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

// PNG dimensions straight out of the IHDR chunk -- no image library needed.
function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function fixtureName(entry) {
  return `${entry.date}_c${entry.capture_index}.png`;
}

function buildOne(entry, outDir) {
  const src = path.join(REPO, entry.source);
  if (!fs.existsSync(src)) return { entry, skipped: 'source snapshot is not on disk' };
  const size = pngSize(src);
  if (!size) return { entry, skipped: 'source is not a PNG' };
  if (size.width < 1280) {
    return { entry, skipped: `source is only ${size.width}px wide (the panel glyphs need >= 1280)` };
  }
  const out = path.join(outDir, fixtureName(entry));
  const filter = `crop=iw*${CROP.w}:ih*${CROP.h}:iw*${CROP.x}:ih*${CROP.y},scale=iw*2:ih*2:flags=lanczos`;
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', filter, '-y', out], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return { entry, out, md5: md5File(out), source_md5: md5File(src), size };
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function build({ check }) {
  const existing = readManifest();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Every case must NAME the widget it was read from. The 2022-era frame has
  // three right-hand widgets, and the upper one prints the SAME footer form
  // ("N Items in Personal WatchList") as the positions table -- so the footer
  // text alone cannot say which panel a reading came from, and a reading taken
  // off the wrong widget satisfies the panel-count invariant perfectly.
  // Declaring the widget makes that a recorded fact instead of an assumption.
  for (const entry of CASES) {
    if (!entry.panel) {
      console.error(`  ${entry.date} c${entry.capture_index}: the case does not say which panel it was read from`);
      return 2;
    }
  }

  const results = [];
  for (const entry of CASES) {
    const built = buildOne(entry, OUT_DIR);
    results.push({ entry, built });
  }
  const missing = results.filter((r) => r.built.skipped);
  if (missing.length && check) {
    console.error(`check: ${missing.length} case(s) have no source snapshot on this machine:`);
    for (const m of missing) console.error(`  ${m.entry.date} c${m.entry.capture_index}: ${m.built.skipped}`);
    console.error('check: the corpus is not in git, so the fixtures cannot be rebuilt here.');
    return 2;
  }

  const manifest = {
    generated_by: 'node tools/buildGroundTruthFixtures.js',
    note: 'A crop of the TradingView positions panel, md5-pinned, showing the ticker column AND the footer that prints the panel\'s own row count. The crop is the evidence: `tickers` is what a reader of the image sees, and `panel_count` is the number the panel itself prints. `panel` names the widget the rows were read from -- it is `positions` for every case here, and it is recorded because the 2022-era frame carries THREE right-hand widgets and the upper watchlist prints the SAME footer form as the positions table, so the footer text alone cannot say which panel a reading came from. `data/qmg_ground_truth.json` must agree with this manifest -- that is what tools/checkGroundTruthConsistency.js checks. The capture index is RUN-RELATIVE: `run` says which run directory the index refers to, and `source` is the exact file the crop was cut from.',
    crop: CROP,
    cases: [],
  };
  for (const { entry, built } of results) {
    const record = {
      date: entry.date,
      capture_index: entry.capture_index,
      run: entry.run,
      source: entry.source,
      source_md5: built.source_md5,
      file: fixtureName(entry),
      md5: built.md5,
      panel: entry.panel,
      panel_count: entry.panel_count,
      panel_count_text: entry.panel_count_text,
      tickers: entry.tickers,
    };
    if (entry.benchmark_case) record.benchmark_case = entry.benchmark_case;
    if (entry.note) record.note = entry.note;
    manifest.cases.push(record);
  }

  if (check) {
    if (!existing) {
      console.error('check: no manifest.json');
      return 2;
    }
    const a = JSON.stringify(existing);
    const b = JSON.stringify(manifest);
    if (a === b) {
      console.log('check: manifest matches the rebuild (byte-identical)');
      return 0;
    }
    console.error('check: manifest differs from the rebuild');
    const oldCases = new Map((existing.cases || []).map((c) => [`${c.date}#${c.capture_index}`, c]));
    for (const c of manifest.cases) {
      const old = oldCases.get(`${c.date}#${c.capture_index}`);
      if (!old) { console.error(`  new case: ${c.date} c${c.capture_index}`); continue; }
      if (old.md5 !== c.md5) console.error(`  ${c.date} c${c.capture_index}: md5 ${old.md5} -> ${c.md5}`);
      if (JSON.stringify(old.tickers) !== JSON.stringify(c.tickers)) {
        console.error(`  ${c.date} c${c.capture_index}: tickers ${JSON.stringify(old.tickers)} -> ${JSON.stringify(c.tickers)}`);
      }
    }
    return 1;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`wrote ${manifest.cases.length} fixtures + manifest.json -> ${path.relative(REPO, OUT_DIR)}`);
  return 0;
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  process.exitCode = build({ check });
}

module.exports = { CASES, CROP, MANIFEST, OUT_DIR, fixtureName, md5File, pngSize };
