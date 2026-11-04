'use strict';

/**
 * Measure the prefilter's frame ranking under different measurement rectangles.
 *
 * The prefilter picks which frames get OCR'd. It measures a rectangle (see
 * `summarizeLumaBuffer` in src/video/ocrScanLogic.js) and scores each sampled
 * frame against it. That rectangle used to be a hard-coded fallback for every
 * chart-stream frame, and the rectangle the OCR engine reads is
 * ERA-CONDITIONAL (src/video/chartStreamCrop.js). When the two disagree, the
 * prefilter ranks frames on pixels the OCR never sees.
 *
 * This tool measures the ranking WITHOUT OCR, which is the point: the whole
 * cost of an EasyOCR pass is the pass, and the ranking can be recomputed in
 * seconds. It extracts the sample frames exactly as the scan tool does
 * (`fps=<fps>,scale=<width>:-2` into `frame_%06d.png`), scores every one of
 * them under each candidate rectangle, and prints the ranking side by side.
 *
 * The frames can be LABELLED with the number of holdings each one actually
 * read (from a previous OCR pass), and the tool then reports how the ranking
 * relates to that label — which is the only way to tell a rectangle that
 * measures the position list from one that measures the chart beside it.
 *
 * Usage:
 *   node tools/measurePrefilterRegion.js --video <path> --date 20230609 \
 *     --labels "1944:13,972:12,3888:12,2916:12,0:7,3100:0"
 *
 * Options:
 *   --video <path>       the video to sample (required)
 *   --date <YYYYMMDD>    the upload date; selects the era rectangle (required)
 *   --labels "<ts:count,...">  holdings each timestamp actually read
 *   --fps <n>            sample rate (default 0.25, the scan tool's default)
 *   --width <n>          sample width (default 640, the scan tool's default)
 *   --resolutions "<w>x<h>,..."  the PREFILTER's working resolutions to score
 *                       at (default "160x90", the pipeline's own). Raising it
 *                       changes the scale of every tuned constant, so it is
 *                       measured here rather than shipped.
 *   --stride <n>         analyse every n-th extracted frame (default 1). The
 *                       frames are still EXTRACTED at the full rate, so the
 *                       labelled timestamps keep addressing the same frames —
 *                       only the scoring is thinned, which is what makes a
 *                       multi-resolution comparison affordable.
 *   --keep-frames <dir>  keep the extracted frames here instead of a temp dir
 *   --top <n>            how many ranked frames to print (default 12)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  analyzeFrameBeforeOcr,
  scoreFramePrefilter,
  spearman
} = require('../src/video/ocrScanLogic');
const { resolveFfmpegBin } = require('../src/video/ffmpegBin');
const { chartStreamPrefilterRegionForDate } = require('../src/video/chartStreamCrop');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    video: null,
    date: null,
    labels: new Map(),
    fps: 0.25,
    width: 640,
    resolutions: ['160x90'],
    stride: 1,
    keepFrames: null,
    top: 12
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--video') args.video = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--width') args.width = Number(argv[++i]);
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--stride') args.stride = Math.max(1, Math.trunc(Number(argv[++i]) || 1));
    else if (a === '--resolutions') {
      const parsed = String(argv[++i] || '')
        .split(',')
        .map((part) => {
          const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(part);
          return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
        })
        .filter(Boolean);
      if (parsed.length) args.resolutions = parsed;
    } else if (a === '--keep-frames') args.keepFrames = argv[++i];
    else if (a === '--labels') {
      for (const pair of String(argv[++i] || '').split(',')) {
        const [ts, count] = pair.split(':');
        if (ts && count !== undefined) args.labels.set(Number(ts), Number(count));
      }
    } else if (a === '--help' || a === '-h') {
      console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return args;
}

function buildScaleFilter(width) {
  return `scale=${Math.max(2, Math.trunc(width))}:-2`;
}

function extractSampleFrames(videoPath, frameDirectory, fps, sampleWidth) {
  const command = [
    resolveFfmpegBin(null),
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${fps},${buildScaleFilter(sampleWidth)}`,
    path.join(frameDirectory, 'frame_%06d.png')
  ];
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'ffmpeg frame extraction failed.');
  }
}

async function listFramePaths(frameDirectory) {
  const entries = await fs.promises.readdir(frameDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => path.join(frameDirectory, entry.name))
    .sort();
}

// The rectangles under test. `fallback` is the hard-coded default that every
// chart-stream frame used until the era rule was threaded through; `era` is
// the rectangle the OCR engine's crop reads.
function buildRegions(dateKey) {
  return [
    { name: 'fallback', region: { left: 0.85, top: 0.55 } },
    { name: 'era', region: chartStreamPrefilterRegionForDate(dateKey) }
  ];
}

function rankOf(rows, frameIndex) {
  const index = rows.findIndex((row) => row.frameIndex === frameIndex);
  return index < 0 ? null : index + 1;
}

// Spearman's rho comes from src/video/ocrScanLogic.js, so this tool and
// tools/sweepPrefilterResolution.js report the SAME number for the same
// ranking. It ranks BOTH series before correlating them: the formula
// `1 - 6·Σd²/(n(n²-1))` is a statement about ranks, so a raw holding count
// has to be ranked first.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.video || !args.date) {
    console.error('Usage: node tools/measurePrefilterRegion.js --video <path> --date <YYYYMMDD> [--labels "ts:count,..."]');
    process.exit(1);
  }
  if (!fs.existsSync(args.video)) {
    console.error(`No such video: ${args.video}`);
    process.exit(1);
  }

  const tempRoot = args.keepFrames
    ? path.resolve(ROOT, args.keepFrames)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'prefilter-region-'));
  const frameDirectory = path.join(tempRoot, 'frames');
  fs.mkdirSync(frameDirectory, { recursive: true });

  console.log(`video      : ${args.video}`);
  console.log(`date       : ${args.date}`);
  console.log(`fps/width  : ${args.fps} / ${args.width}`);
  console.log(`stride     : ${args.stride}`);
  console.log(`frames dir : ${frameDirectory}`);
  console.log(`extracting sample frames…`);
  extractSampleFrames(args.video, frameDirectory, args.fps, args.width);
  const framePaths = await listFramePaths(frameDirectory);
  console.log(`extracted ${framePaths.length} frame(s)\n`);

  const regions = buildRegions(args.date);
  const results = new Map();

  // The frame index of a timestamp, in the extracted sequence.
  const indexOfTimestamp = (ts) => Math.round(ts * args.fps);

  // Which frames get SCORED. The stride thins the set so a multi-resolution
  // comparison is affordable; the labelled frames are always scored whatever
  // the stride, because a comparison that dropped the frame under test would
  // answer a different question than the one asked.
  const labelledIndices = new Set(
    [...args.labels.keys()].map((ts) => indexOfTimestamp(ts)).filter((index) => index >= 0)
  );
  const scoredIndices = [];
  for (let index = 0; index < framePaths.length; index += 1) {
    if (index % args.stride === 0 || labelledIndices.has(index)) scoredIndices.push(index);
  }

  for (const resolution of args.resolutions) {
    const tag = `${resolution.width}x${resolution.height}`;
    console.log(`=== prefilter resolution ${tag}`);

    for (const candidate of regions) {
      const key = `${candidate.name}@${tag}`;
      console.log(`--- region "${candidate.name}" ${JSON.stringify(candidate.region)}`);
      const rows = [];
      for (const index of scoredIndices) {
        const stats = await analyzeFrameBeforeOcr(framePaths[index], candidate.region, resolution);
        const timestamp = Number((index / args.fps).toFixed(3));
        stats.timestamp = timestamp;
        rows.push({
          frameIndex: index,
          timestamp,
          score: scoreFramePrefilter(stats, 'snapshot', 'chart_stream', 0, timestamp),
          stats
        });
      }
      rows.sort((a, b) => b.score - a.score);
      results.set(key, rows);

    // Two more rankings of the SAME frames: by the mid-tone signal the score
    // actually uses, and by the one the signal is NAMED for.
    //
    // `midToneRatioTicker` is not the fraction of the ticker rectangle that is
    // mid-tone — its two counters are nested inside a `value >= 130` branch,
    // so it is "of the bright pixels here, how many are merely bright". The
    // name and the profile's own comment both describe the other quantity,
    // which `midToneRatioTickerRegion` computes.
    //
    // The score's mid-tone term saturates (weight 30, capped at 1.0), so the
    // score's ranking is the sum of the terms; these two rankings isolate the
    // signal and say which frames each one would have picked.
    const byCurrentSignal = [...rows].sort(
      (a, b) => b.stats.midToneRatioTicker - a.stats.midToneRatioTicker
    );
    const byCorrectedSignal = [...rows].sort(
      (a, b) => b.stats.midToneRatioTickerRegion - a.stats.midToneRatioTickerRegion
    );

    console.log(`  top ${Math.min(args.top, rows.length)}:`);
    for (const row of rows.slice(0, args.top)) {
      console.log(
        `    ts=${String(row.timestamp).padStart(8)}  score=${row.score.toFixed(2).padStart(7)}` +
        `  midTone=${row.stats.midToneRatioTicker.toFixed(4)}` +
        `  rowDensity=${row.stats.rowDensity}` +
        `  stripes=${row.stats.multiColStripeCount}` +
        `  luma=${row.stats.meanLuma.toFixed(1)}`
      );
    }

    if (args.labels.size) {
      console.log(`  labelled frames (holdings actually read):`);
      const labelled = [];
      for (const [ts, count] of args.labels) {
        // The pipeline's timestamp for frame i is i / fps, so the frame index
        // of a timestamp is ts * fps.
        const index = indexOfTimestamp(ts);
        const row = rows.find((r) => r.frameIndex === index);
        if (!row) {
          console.log(`    ts=${ts}: not in this sample`);
          continue;
        }
        const rank = rankOf(rows, index);
        const currentSignalRank = rankOf(byCurrentSignal, index);
        const correctedSignalRank = rankOf(byCorrectedSignal, index);
        labelled.push({ ts, count, rank, score: row.score, row });
        console.log(
          `    ts=${String(ts).padStart(8)}  holdings=${String(count).padStart(3)}` +
          `  rank=${String(rank).padStart(5)}/${rows.length}` +
          `  score=${row.score.toFixed(2).padStart(7)}` +
          `  midTone=${row.stats.midToneRatioTicker.toFixed(4)}` +
          `  rowDensity=${row.stats.rowDensity}` +
          `  stripes=${row.stats.multiColStripeCount}`
        );
        console.log(
          `                 mid-tone signal ranks: current=${currentSignalRank}/${rows.length}` +
          `  corrected=${correctedSignalRank}/${rows.length}` +
          `  (corrected ratio ${row.stats.midToneRatioTickerRegion.toFixed(4)}` +
          ` over ${row.stats.tickerRegionPixels} region pixel(s))`
        );
      }
      const withHoldings = labelled.filter((l) => l.count > 0);
      const pairs = withHoldings.map((l) => [l.rank, l.count]);
      console.log(`  spearman(rank, holdings) over the labelled frames: ${spearman(pairs)}`);
      if (labelled.length) {
        const best = labelled.reduce((a, b) => (a.score >= b.score ? a : b));
        console.log(
          `  the best-scoring labelled frame holds ${best.count} holding(s) ` +
          `(ts=${best.ts}); the frame holding the MOST holds ` +
          `${withHoldings.reduce((a, b) => (a.count >= b.count ? a : b)).count}`
        );

        // What each mid-tone signal would have picked on its own.
        const bestBy = (ranking) => {
          let winner = null;
          for (const entry of labelled) {
            const row = ranking.find((r) => r.frameIndex === entry.row.frameIndex);
            if (!row) continue;
            if (!winner || row.stats.midToneRatioTickerRegion > winner.value) {
              winner = { value: row.stats.midToneRatioTickerRegion, ts: entry.ts, count: entry.count };
            }
          }
          return winner;
        };
        const currentWinner = (() => {
          let winner = null;
          for (const entry of labelled) {
            const row = byCurrentSignal.find((r) => r.frameIndex === entry.row.frameIndex);
            if (!row) continue;
            if (!winner || row.stats.midToneRatioTicker > winner.value) {
              winner = { value: row.stats.midToneRatioTicker, ts: entry.ts, count: entry.count };
            }
          }
          return winner;
        })();
        const correctedWinner = bestBy(byCorrectedSignal);
        if (currentWinner) {
          console.log(
            `  the mid-tone signal the score uses would pick ts=${currentWinner.ts} ` +
            `(holds ${currentWinner.count})`
          );
        }
        if (correctedWinner) {
          console.log(
            `  the mid-tone signal it is NAMED for would pick ts=${correctedWinner.ts} ` +
            `(holds ${correctedWinner.count})`
          );
        }
      }
    }
      console.log('');
    }

    // Agreement between the two rankings, at THIS resolution.
    const a = results.get(`fallback@${tag}`);
    const b = results.get(`era@${tag}`);
    const shared = new Map(a.map((row) => [row.frameIndex, row.score]));
    let topOverlap = 0;
    const topN = Math.min(args.top, a.length, b.length);
    for (const row of b.slice(0, topN)) {
      if (a.slice(0, topN).some((other) => other.frameIndex === row.frameIndex)) topOverlap += 1;
    }
    console.log(`--- comparison at ${tag}`);
    console.log(`  the two rankings share ${topOverlap}/${topN} of their top frames`);
    const changed = b
      .map((row, index) => ({ index: index + 1, frameIndex: row.frameIndex, timestamp: row.timestamp, old: shared.get(row.frameIndex), now: row.score }))
      .filter((row) => row.old !== undefined && Math.abs(row.old - row.now) > 0.01);
    console.log(`  ${changed.length}/${b.length} frames changed score`);
    for (const row of changed.slice(0, 12)) {
      console.log(`    ts=${String(row.timestamp).padStart(8)}  ${row.old.toFixed(2).padStart(7)} -> ${row.now.toFixed(2).padStart(7)}  (rank ${row.index})`);
    }
    if (changed.length > 12) console.log(`    … and ${changed.length - 12} more`);
    console.log('');
  }

  if (!args.keepFrames) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    console.log(`\nremoved the temporary frame directory`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
