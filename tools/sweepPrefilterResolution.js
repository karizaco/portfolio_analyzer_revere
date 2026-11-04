'use strict';

/**
 * The WIDE prefilter-resolution measurement.
 *
 * CLAUDE.md (§ 'The prefilter's RESOLUTION — 640×360 is the first one that
 * works') says shipping a higher prefilter resolution needs three things, and
 * this tool supplies the first of them:
 *
 *   1. a WIDE measurement — one video, six labelled frames, is not enough,
 *      and the 2022-era floating panel and the 2023-era right sidebar have
 *      different geometry, so the two eras have to be measured SEPARATELY;
 *   2. a re-tune of the scale-bound constants (`rowDensityTarget`,
 *      `multiColStripeCountTarget`), whose measured values move with the
 *      resolution;
 *   3. a decision on the stripe term itself.
 *
 * Nothing is shipped by this tool. It MEASURES.
 *
 * WHY IT NEEDS NO NEW OCR PASS
 *
 * The labels it scores against are already in the corpus: every probe log
 * records the retained OCR'd candidate pool (selected captures plus the top
 * and rejected candidates), with a timestamp and `chart_stream.position_list`
 * for each frame. `tools/extractPrefilterLabels.js` extracts them. Using the
 * whole retained pool is important: selected captures alone are biased toward
 * frames that already read holdings.
 *
 * WHAT IT MEASURES
 *
 * For each (resolution, region) it builds the prefilter's ranking of the
 * video's frames and asks the only question that matters:
 *
 *   does the frame the prefilter likes best actually HOLD the positions?
 *
 * The 2026-11-02 measurement on one video found the ranking INVERTED — the
 * highest-scoring frame read ZERO holdings while the frame that read the
 * date exactly ranked near the bottom. The question is repeated here, per
 * date, at three resolutions, for both measurement rectangles, and for both
 * eras.
 *
 * THE TWO REGIONS
 *
 *   fallback   the hard-coded rectangle every chart-stream frame used until
 *              the era rule was threaded through ({left: 0.85, top: 0.55})
 *   era        the rectangle the OCR engine's crop actually reads, derived
 *              from the upload date (src/video/chartStreamCrop.js)
 *
 * The rectangles are compared with each other AND with themselves across
 * resolutions, so a resolution change is never confused with a rectangle
 * change.
 *
 * THE TWO TEMPORAL DECAYS
 *
 * Production runs the 2022-era dates with the scan tool's default
 * `--temporal-decay 1800` and the 2023-era sidebar dates with `--temporal-decay 0`
 * (tools/runQmgOcrBatch.js). The temporal boost is worth up to 6 points and
 * decays with the timestamp, so it is a real confound between the eras. Every
 * ranking is therefore computed TWICE — with production's decay and with no
 * decay at all — and both are reported.
 *
 * USAGE
 *
 *   node tools/sweepPrefilterResolution.js                       # every date
 *   node tools/sweepPrefilterResolution.js --era 2023            # one era
 *   node tools/sweepPrefilterResolution.js --dates 20230609,20220421
 *   node tools/sweepPrefilterResolution.js --stride 4            # thin scoring
 *   node tools/sweepPrefilterResolution.js --out data/sweep.json
 *
 * OPTIONS
 *   --dates "<d,d>"      the dates to measure (default: every measurable one)
 *   --era <2022|2023>    restrict to one layout era
 *   --resolutions "<w>x<h>,..."  the prefilter working resolutions
 *   --fps <n>            the extraction rate (default 0.25, production's)
 *   --width <n>          the sample width (default 640, production's)
 *   --stride <n>         score every n-th frame (default 1 = every frame)
 *   --top-k <n>          the pool size production OCRs (default 12)
 *   --min-labels <n>     a date needs this many aligned labels (default 2)
 *   --limit <n>          stop after n dates
 *   --sources <list>     comma-separated captures,candidates,rejected sources
 *                       (default: all three)
 *   --out <path>         where to write the JSON (default
 *                        data/prefilter_resolution_sweep.json)
 *   --keep-frames        keep the extracted frames (they are large)
 *   --print <detail|summary>  how much of the per-date detail to print
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  analyzeFrameBeforeOcr,
  scoreFramePrefilterBreakdown,
  spearman
} = require('../src/video/ocrScanLogic');
const { resolveFfmpegBin } = require('../src/video/ffmpegBin');
const {
  chartStreamEraForDate,
  chartStreamPrefilterRegionForDate
} = require('../src/video/chartStreamCrop');
const {
  SAMPLE_FPS,
  collect,
  eraFor,
  labelsString,
  normalizeSources
} = require('./extractPrefilterLabels');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_OUT = path.join(ROOT, 'data', 'prefilter_resolution_sweep.json');

// Production's temporal decay, per era. The 2022-era dates get the scan
// tool's default 1800; the 2023-era sidebar dates get an explicit 0.
// See tools/runQmgOcrBatch.js -> getFlagsForDate.
function productionTemporalDecay(dateKey) {
  return chartStreamEraForDate(dateKey) === 'right_sidebar' ? 0 : 1800;
}

// The two rectangles under test.
function buildRegions(dateKey) {
  return [
    { name: 'fallback', region: { left: 0.85, top: 0.55 } },
    { name: 'era', region: chartStreamPrefilterRegionForDate(dateKey) }
  ];
}

// The production frame extraction: `fps=<fps>,scale=<width>:-2` into
// `frame_%06d.png`. The prefilter sees THESE frames, at this width, so the
// measurement has to see them too — a measurement taken at a different
// width measures a different pipeline.
function extractSampleFrames(videoPath, frameDirectory, fps, sampleWidth) {
  const command = [
    resolveFfmpegBin(null),
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${fps},scale=${Math.max(2, Math.trunc(sampleWidth))}:-2`,
    path.join(frameDirectory, 'frame_%06d.png')
  ];
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'ffmpeg frame extraction failed.');
  }
}

// Spearman's rho over [rank, value] pairs comes from the shared module, so
// this tool and `tools/measurePrefilterRegion.js` cannot report different
// numbers for the same ranking. NEGATIVE means the ranking is right: a LOW
// rank (a good frame) carries a HIGH value (many holdings).

/**
 * Judge one ranking of a video's frames against the labels.
 *
 * The verdict is about ONE thing: does a frame that holds NOTHING rank
 * above a frame that holds the positions?
 *
 *   OK          no zero-holding frame outranks any holding frame
 *   PARTIAL     a zero-holding frame outranks SOME of the holding frames
 *   INVERTED    the best zero-holding frame outranks EVERY holding frame
 *   NO_ZERO_FRAME  the date has no zero-holding labelled frame, so the
 *                  question cannot be asked of it
 *
 * @param {Array} ranking  frames sorted by score, best first
 * @param {Array} labels   [{ts, holdings}] — the aligned labels
 * @param {object} options {fps, topK}
 */
function evaluateRanking(ranking, labels, options = {}) {
  const fps = options.fps || SAMPLE_FPS;
  const topK = options.topK || 12;

  const labelByIndex = new Map();
  const conflicts = [];
  for (const label of labels) {
    const index = Math.round(label.ts * fps);
    const prior = labelByIndex.get(index);
    if (!prior) {
      labelByIndex.set(index, { ...label, index });
      continue;
    }
    if (prior.holdings === label.holdings) continue;
    // Two runs of the same date read the same frame differently. The frame
    // DID hold positions if ANY reading of it found them, so the larger
    // reading wins — and the conflict is counted, because a frame whose
    // reading is not stable is a weaker label than one that is.
    conflicts.push({ index, ts: label.ts, holdings: [prior.holdings, label.holdings] });
    if (label.holdings > prior.holdings) labelByIndex.set(index, { ...label, index });
  }

  const rankByIndex = new Map();
  ranking.forEach((row, index) => rankByIndex.set(row.frameIndex, index + 1));

  const labelled = [];
  for (const row of ranking) {
    const label = labelByIndex.get(row.frameIndex);
    if (!label) continue;
    labelled.push({
      frameIndex: row.frameIndex,
      timestamp: row.timestamp,
      holdings: label.holdings,
      score: row.score,
      rank: rankByIndex.get(row.frameIndex),
      stats: row.stats,
      components: row.components
    });
  }

  const holdingFrames = labelled.filter((l) => l.holdings > 0);
  const zeroFrames = labelled.filter((l) => l.holdings === 0);

  const bestLabelled = labelled.length
    ? labelled.reduce((a, b) => (b.score >= a.score ? b : a))
    : null;
  const bestZero = zeroFrames.length
    ? zeroFrames.reduce((a, b) => (b.score >= a.score ? b : a))
    : null;
  const mostHolding = holdingFrames.length
    ? holdingFrames.reduce((a, b) => (b.holdings >= a.holdings ? b : a))
    : null;

  // How many holding frames the BEST zero-holding frame outranks. This is
  // the strict pair test: the zero frame has to lose to the holding frames
  // for the ranking to be usable.
  const zeroOutranks = bestZero
    ? holdingFrames.filter((l) => bestZero.rank < l.rank).length
    : null;

  let verdict;
  if (!labelled.length) verdict = 'NO_LABELS';
  else if (!zeroFrames.length) verdict = 'NO_ZERO_FRAME';
  else if (!holdingFrames.length) verdict = 'NO_HOLDING_FRAME';
  else if (zeroOutranks === holdingFrames.length) verdict = 'INVERTED';
  else if (zeroOutranks > 0) verdict = 'PARTIAL';
  else verdict = 'OK';

  const brief = (frame) => (frame
    ? {
      ts: frame.timestamp,
      holdings: frame.holdings,
      rank: frame.rank,
      score: frame.score,
      components: frame.components
    }
    : null);

  return {
    scored_frames: ranking.length,
    labelled_frames: labelled.length,
    label_conflicts: conflicts.length,
    holding_frames: holdingFrames.length,
    zero_frames: zeroFrames.length,
    best_labelled: brief(bestLabelled),
    best_zero: brief(bestZero),
    most_holding: brief(mostHolding),
    zero_outranks: zeroOutranks,
    // NEGATIVE is GOOD: a low rank should carry a high holding count.
    spearman_rank_holdings: spearman(holdingFrames.map((l) => [l.rank, l.holdings])),
    holding_frames_in_top_k: holdingFrames.filter((l) => l.rank <= topK).length,
    top_k: topK,
    verdict,
    labelled: labelled.map((l) => ({
      ts: l.timestamp,
      holdings: l.holdings,
      rank: l.rank,
      score: l.score,
      mid_tone: l.stats.midToneRatioTicker,
      mid_tone_region: l.stats.midToneRatioTickerRegion,
      row_density: l.stats.rowDensity,
      stripes: l.stats.multiColStripeCount,
      mean_luma: l.stats.meanLuma,
      components: l.components
    }))
  };
}

function parseArgs(argv) {
  const args = {
    dates: null,
    era: null,
    resolutions: [
      { width: 160, height: 90 },
      { width: 320, height: 180 },
      { width: 640, height: 360 }
    ],
    fps: SAMPLE_FPS,
    width: 640,
    stride: 1,
    topK: 12,
    minLabels: 2,
    limit: null,
    sources: normalizeSources(),
    out: DEFAULT_OUT,
    keepFrames: false,
    print: 'summary'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dates') args.dates = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--era') args.era = String(argv[++i] || '').trim();
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--width') args.width = Number(argv[++i]);
    else if (a === '--stride') args.stride = Math.max(1, Math.trunc(Number(argv[++i]) || 1));
    else if (a === '--top-k') args.topK = Math.max(1, Math.trunc(Number(argv[++i]) || 12));
    else if (a === '--min-labels') args.minLabels = Math.max(1, Math.trunc(Number(argv[++i]) || 2));
    else if (a === '--limit') args.limit = Math.max(1, Math.trunc(Number(argv[++i]) || 1));
    else if (a === '--sources') args.sources = normalizeSources(argv[++i]);
    else if (a === '--out') args.out = path.resolve(ROOT, String(argv[++i] || ''));
    else if (a === '--keep-frames') args.keepFrames = true;
    else if (a === '--print') args.print = String(argv[++i] || 'summary');
    else if (a === '--resolutions') {
      const parsed = String(argv[++i] || '')
        .split(',')
        .map((part) => {
          const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(part);
          return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
        })
        .filter(Boolean);
      if (parsed.length) args.resolutions = parsed;
    } else if (a === '--help' || a === '-h') {
      console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return args;
}

async function listFramePaths(frameDirectory) {
  const entries = await fs.promises.readdir(frameDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => path.join(frameDirectory, entry.name))
    .sort();
}

/**
 * Score one video's frames at every resolution, in every region, under both
 * temporal decays, and judge each resulting ranking.
 */
async function measureVideo({ dateKey, videoPath, labels, args }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefilter-sweep-'));
  const frameDirectory = path.join(tempRoot, 'frames');
  fs.mkdirSync(frameDirectory, { recursive: true });

  try {
    extractSampleFrames(videoPath, frameDirectory, args.fps, args.width);
    const framePaths = await listFramePaths(frameDirectory);

    const regions = buildRegions(dateKey);
    const decays = [
      { name: 'production', value: productionTemporalDecay(dateKey) },
      { name: 'none', value: 0 }
    ];

    // The frames that get SCORED. The stride thins the set so a wide sweep
    // is affordable; the LABELLED frames are always scored whatever the
    // stride, because a comparison that dropped the frame under test would
    // answer a different question.
    const labelledIndices = new Set(labels.map((l) => Math.round(l.ts * args.fps)));
    const scoredIndices = [];
    for (let index = 0; index < framePaths.length; index += 1) {
      if (index % args.stride === 0 || labelledIndices.has(index)) scoredIndices.push(index);
    }

    const results = {};
    for (const resolution of args.resolutions) {
      const tag = `${resolution.width}x${resolution.height}`;
      for (const candidate of regions) {
        // One pass over the frames: the stats for this (resolution, region),
        // and the score under each decay.
        const rows = [];
        for (const index of scoredIndices) {
          const stats = await analyzeFrameBeforeOcr(
            framePaths[index],
            candidate.region,
            { width: resolution.width, height: resolution.height }
          );
          const timestamp = Number((index / args.fps).toFixed(3));
          const perDecay = {};
          for (const decay of decays) {
            const scored = scoreFramePrefilterBreakdown(
              stats,
              'snapshot',
              'chart_stream',
              decay.value,
              timestamp
            );
            perDecay[decay.name] = { score: scored.total, components: scored.components };
          }
          rows.push({
            frameIndex: index,
            timestamp,
            score: perDecay.production.score,
            scoreNoTemporal: perDecay.none.score,
            components: perDecay.production.components,
            componentsNoTemporal: perDecay.none.components,
            stats
          });
        }

        for (const decay of decays) {
          const key = decay.name === 'production' ? 'score' : 'scoreNoTemporal';
          const ranked = rows
            .slice()
            .sort((a, b) => b[key] - a[key] || b.timestamp - a.timestamp);
          const judged = evaluateRanking(ranked, labels, { fps: args.fps, topK: args.topK });
          const resultKey = `${candidate.name}@${tag}@${decay.name}`;
          results[resultKey] = {
            region: candidate.name,
            region_rect: candidate.region,
            resolution: tag,
            decay_name: decay.name,
            temporal_decay: decay.value,
            ...judged
          };
        }
      }
    }

    return {
      date: dateKey,
      // The SHORT era ('2022' / '2023'), the same form the label extractor
      // uses — the roll-up groups by it, and two forms of the same label
      // would silently split every bucket.
      era: eraFor(dateKey),
      layout_era: chartStreamEraForDate(dateKey),
      video: path.relative(ROOT, videoPath).split(path.sep).join('/'),
      frames_extracted: framePaths.length,
      frames_scored: scoredIndices.length,
      sources: args.sources,
      labels: labels.map((l) => ({
        ts: l.ts,
        holdings: l.holdings,
        source: l.source,
        sources: l.sources
      })),
      results
    };
  } finally {
    if (!args.keepFrames) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`    frames kept in ${tempRoot}`);
    }
  }
}

// The per-era roll-up: how many dates land on each verdict, and what the
// ranking looks like on average.
//
// The bucket key carries the ERA, because a result key like
// `fallback@160x90@production` is used by BOTH eras and the two have to be
// counted separately — the 2022-era floating panel and the 2023-era right
// sidebar have different geometry, and CLAUDE.md is explicit that they have
// to be measured separately.
function summarize(dates) {
  const keys = new Set();
  for (const date of dates) {
    for (const key of Object.keys(date.results || {})) keys.add(key);
  }

  const summary = {};
  for (const key of keys) {
    for (const era of ['2022', '2023']) {
      const bucket = {
        era,
        result_key: key,
        dates: 0,
        verdicts: {},
        mean_spearman: null,
        mean_best_labelled: null
      };
      const spearmans = [];
      const bestLabelled = [];
      for (const date of dates) {
        if (date.era !== era) continue;
        const entry = (date.results || {})[key];
        if (!entry) continue;
        bucket.dates += 1;
        bucket.verdicts[entry.verdict] = (bucket.verdicts[entry.verdict] || 0) + 1;
        if (typeof entry.spearman_rank_holdings === 'number') spearmans.push(entry.spearman_rank_holdings);
        if (entry.best_labelled) bestLabelled.push(entry.best_labelled.holdings);
      }
      if (!bucket.dates) continue;
      bucket.mean_spearman = spearmans.length
        ? Number((spearmans.reduce((a, b) => a + b, 0) / spearmans.length).toFixed(3))
        : null;
      bucket.mean_best_labelled = bestLabelled.length
        ? Number((bestLabelled.reduce((a, b) => a + b, 0) / bestLabelled.length).toFixed(2))
        : null;
      summary[`${era}|${key}`] = bucket;
    }
  }
  return summary;
}

function printSummary(dates, summary, args) {
  console.log('\n=== per era, per resolution, per region ===\n');
  console.log(
    'era    resolution  region     decay      dates  OK  PART  INV  no-zero  mean spearman  mean best-labelled holdings'
  );
  console.log('-'.repeat(112));

  const rows = Object.values(summary);
  rows.sort((a, b) => a.era.localeCompare(b.era)
    || a.result_key.localeCompare(b.result_key));

  for (const row of rows) {
    const [region, resolution, decay] = row.result_key.split('@');
    const v = row.verdicts;
    console.log(
      row.era.padEnd(6)
      + resolution.padEnd(12)
      + region.padEnd(11)
      + decay.padEnd(11)
      + String(row.dates).padStart(5)
      + String(v.OK || 0).padStart(4)
      + String(v.PARTIAL || 0).padStart(6)
      + String(v.INVERTED || 0).padStart(5)
      + String(v.NO_ZERO_FRAME || 0).padStart(9)
      + String(row.mean_spearman === null ? '-' : row.mean_spearman).padStart(15)
      + String(row.mean_best_labelled === null ? '-' : row.mean_best_labelled).padStart(28)
    );
  }

  console.log('\n  A NEGATIVE mean spearman is GOOD: a low rank should carry a high holding count.');
  console.log('  INVERTED means the best zero-holding frame outranks EVERY holding frame.');
  console.log('  PARTIAL means it outranks some of them.');

  if (args.print === 'detail') {
    for (const date of dates) {
      console.log(`\n--- ${date.date} (${date.era}-era) — ${date.video}`);
      console.log(`    ${date.frames_extracted} frame(s) extracted, ${date.frames_scored} scored`);
      for (const [key, entry] of Object.entries(date.results || {})) {
        const [region, resolution, decay] = key.split('@');
        if (decay !== 'production') continue;
        console.log(
          `    ${resolution.padEnd(8)} ${region.padEnd(9)} ${entry.verdict.padEnd(14)}`
          + ` best-labelled=${entry.best_labelled ? entry.best_labelled.holdings : '-'}`
          + ` (rank ${entry.best_labelled ? entry.best_labelled.rank : '-'}/${entry.scored_frames})`
          + `  zero-outranks=${entry.zero_outranks}/${entry.holding_frames}`
          + `  spearman=${entry.spearman_rank_holdings === null ? '-' : entry.spearman_rank_holdings.toFixed(3)}`
        );
      }
    }
  }
}

function labelsForVideo(date, videoPath) {
  if (!date || !videoPath) return [];
  const target = path.normalize(videoPath).toLowerCase();
  return (date.alignedLabels || []).filter((label) => {
    return label.video && path.normalize(label.video).toLowerCase() === target;
  });
}

async function runSweep(argv) {
  const args = parseArgs(argv);

  const labelDates = collect({
    roots: require('./extractPrefilterLabels').DEFAULT_ROOTS,
    era: args.era,
    date: null,
    sources: args.sources
  });
  const wanted = args.dates ? new Set(args.dates) : null;

  const measurable = [];
  for (const date of labelDates) {
    if (wanted && !wanted.has(date.date)) continue;
    if (args.era && date.era !== args.era) continue;
    if (!date.videos.length) continue;
    const videoPath = date.videos[0];
    const measurementLabels = labelsForVideo(date, videoPath);
    if (measurementLabels.length < args.minLabels) continue;
    measurable.push({ ...date, measurementLabels });
  }

  console.log('=== the prefilter-resolution sweep ===\n');
  console.log(`  dates with labels and media: ${measurable.length}`);
  console.log(`  resolutions: ${args.resolutions.map((r) => `${r.width}x${r.height}`).join(', ')}`);
  console.log(`  stride: ${args.stride}   fps: ${args.fps}   sample width: ${args.width}`);
  console.log(`  label sources: ${args.sources.join(',') || '(none)'}`);
  console.log(`  output: ${path.relative(ROOT, args.out)}`);

  if (!measurable.length) {
    console.log('\n  nothing measurable — no date has both grid-aligned labels and media on disk.');
    return;
  }

  const dates = [];
  let index = 0;
  for (const date of measurable) {
    if (args.limit && index >= args.limit) break;
    index += 1;
    const videoPath = date.videos[0];
    const labels = date.measurementLabels;
    const labelDate = { ...date, alignedLabels: labels };
    console.log(`\n[${index}/${measurable.length}] ${date.date} (${date.era}-era) ${path.basename(videoPath)}`);
    console.log(`    labels: ${labelsString(labelDate, { allowMisaligned: false })}`);
    const started = Date.now();
    try {
      const measured = await measureVideo({
        dateKey: date.date,
        videoPath,
        labels,
        args
      });
      measured.elapsed_seconds = Math.round((Date.now() - started) / 1000);
      dates.push(measured);
      const verdicts = Object.values(measured.results || {})
        .filter((entry) => entry.decay_name === 'production');
      console.log(`    measured in ${measured.elapsed_seconds}s`);
      for (const entry of verdicts) {
        console.log(
          `      ${entry.resolution.padEnd(8)} ${entry.region.padEnd(9)} ${entry.verdict}`
        );
      }
    } catch (error) {
      console.log(`    FAILED: ${error && error.message ? error.message : error}`);
      dates.push({
        date: date.date,
        era: date.era,
        video: path.relative(ROOT, videoPath).split(path.sep).join('/'),
        error: String(error && error.message ? error.message : error),
        results: {}
      });
    }

    // Written after EVERY date, so a long sweep that dies keeps what it
    // measured. A sweep whose results exist only at the end is a sweep whose
    // results are lost when the machine is rebooted.
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(
      args.out,
      JSON.stringify({
        sample_fps: args.fps,
        sample_width: args.width,
        stride: args.stride,
        top_k: args.topK,
        sources: args.sources,
        resolutions: args.resolutions.map((r) => `${r.width}x${r.height}`),
        summary: summarize(dates),
        dates
      }, null, 2)
    );
  }

  const summary = summarize(dates);
  printSummary(dates, summary, args);
  console.log(`\n  written: ${path.relative(ROOT, args.out)}`);
}

if (require.main === module) {
  runSweep(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildRegions,
  evaluateRanking,
  productionTemporalDecay,
  runSweep,
  spearman,
  summarize
};
