'use strict';

// A MANUAL measurement: does the prefilter rank position-list frames better at
// a HIGHER working resolution?
//
// The prefilter scores each sampled frame on a 160x90 down-sample of the
// whole frame, and the region it measures is the ticker rectangle the OCR
// engine will read. That resolution is the scale every tuned constant in
// `scoreFramePrefilter` was fitted at, so raising it is not a free change —
// but the 2023-era sidebar's signals are measurably degenerate at 160x90 (the
// ticker rectangle is 29x29 pixels, so the mid-tone ratio's denominator is 7
// or 17), and the ranking is measurably INVERTED there.
//
// This harness answers one question, with no OCR:
//
//   at each resolution, where does the frame that reads the MOST holdings
//   rank, and where does the frame that reads NONE rank?
//
// A resolution that fixes the ranking is one where the high-holding frame
// ranks ABOVE the zero-holding frame.
//
// It is deliberately not part of `npm test`: it needs a real video (the media
// is not in git), and it re-extracts every sampled frame.
//
// Run it:
//
//   node --test test/manual/prefilterResolutionScan.test.js
//
// Configuration comes from `test/manual/prefilterResolutionScan.config.json`
// when that file exists, and from the environment otherwise (the environment
// wins):
//
//   video        the video to measure (default: the 20230609 control)
//   date         the upload date (default 20230609)
//   labels       "ts:count,..." (default the six 2026-11-02 scan candidates)
//   resolutions  "w x h,..." (default 160x90,320x180,640x360)
//   stride       analyse every n-th frame (default 8)
//
// The assertions are STRUCTURAL: the tool ran, and every labelled frame was
// found and reported. The RANKINGS are reported, not asserted — a resolution
// that does not help is a finding, not a failure.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VIDEO_DIR_1080 = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p');

const DEFAULT_DATE = '20230609';
const DEFAULT_LABELS = '1944:13,972:12,3888:12,2916:12,0:7,3100:0';
const DEFAULT_RESOLUTIONS = '160x90,320x180,640x360';
const DEFAULT_STRIDE = 8;

function readConfig() {
  const configPath = path.join(__dirname, 'prefilterResolutionScan.config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.log(`  ignoring the unreadable config file: ${error.message}`);
    return {};
  }
}

const CONFIG = readConfig();

const DATE = String(process.env.PREFILTER_DATE || CONFIG.date || DEFAULT_DATE).trim();
const LABELS = String(process.env.PREFILTER_LABELS || CONFIG.labels || DEFAULT_LABELS).trim();
const RESOLUTIONS = String(
  process.env.PREFILTER_RESOLUTIONS || CONFIG.resolutions || DEFAULT_RESOLUTIONS
).trim();
const STRIDE = Number(process.env.PREFILTER_STRIDE || CONFIG.stride || DEFAULT_STRIDE) || DEFAULT_STRIDE;

function findVideo(dateKey) {
  if (!fs.existsSync(VIDEO_DIR_1080)) return null;
  return fs
    .readdirSync(VIDEO_DIR_1080)
    .find((name) => name.startsWith(`${dateKey}_`) && name.endsWith('.mp4')) || null;
}

test('the prefilter ranking at three working resolutions', async (t) => {
  const video = findVideo(DATE);
  if (!video) {
    t.skip('no pipeline media on this machine (the media is not tracked in git)');
    return;
  }

  const scriptPath = path.join(ROOT, 'tools', 'measurePrefilterRegion.js');
  const args = [
    scriptPath,
    '--video', path.join(VIDEO_DIR_1080, video),
    '--date', DATE,
    '--labels', LABELS,
    '--resolutions', RESOLUTIONS,
    '--stride', String(STRIDE),
    '--top', '6'
  ];

  console.log(`\n=== tools/measurePrefilterRegion.js --resolutions ${RESOLUTIONS} --stride ${STRIDE}`);
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, `the measurement tool exited ${result.code}: ${result.stderr}`);

  // Every resolution must have reported a ranking, and every labelled frame
  // must appear in each of them.
  const resolutions = RESOLUTIONS.split(',').map((r) => r.trim()).filter(Boolean);
  for (const resolution of resolutions) {
    assert.ok(
      result.stdout.includes(`=== prefilter resolution ${resolution}`),
      `no ranking was printed for ${resolution}`
    );
  }

  const labelledCount = LABELS.split(',').filter(Boolean).length;
  const found = result.stdout.split('\n').filter((line) => /holdings=\s*\d+/.test(line));
  assert.ok(
    found.length >= labelledCount * resolutions.length * 2,
    `expected every labelled frame to be reported at every resolution ` +
    `(found ${found.length} report lines for ${labelledCount} labels x ${resolutions.length} resolutions)`
  );

  // The summary the measurement exists to produce: for each resolution AND
  // each region, the rank of the frame holding the MOST and the frame holding
  // NONE.
  //
  // The verdict is per REGION, and it must be. A resolution block holds two
  // rankings -- the legacy fallback rectangle and the era rectangle -- and
  // comparing one region's most-holding frame against the other region's
  // zero-holding frame would report a verdict for a comparison that was never
  // made.
  console.log('\n=== the summary (per resolution, per region) ===');
  const blocks = result.stdout.split(/=== prefilter resolution /).slice(1);
  for (const block of blocks) {
    const tag = block.split('\n')[0].trim();
    const regionBlocks = block.split(/--- region "/).slice(1);
    for (const regionBlock of regionBlocks) {
      const regionName = regionBlock.split('"')[0];
      const rows = [];
      for (const line of regionBlock.split('\n')) {
        const match = /ts=\s*(\d+)\s+holdings=\s*(\d+)\s+rank=\s*(\d+)\/(\d+)/.exec(line);
        if (match) {
          rows.push({ ts: Number(match[1]), holdings: Number(match[2]), rank: Number(match[3]), of: Number(match[4]) });
        }
      }
      if (!rows.length) continue;
      const withHoldings = rows.filter((r) => r.holdings > 0);
      const none = rows.filter((r) => r.holdings === 0);
      const best = withHoldings.reduce((a, b) => (b.holdings > a.holdings ? b : a), withHoldings[0]);
      const worst = none[0] || null;
      // How many holding-bearing frames does the zero-holding frame outrank?
      // That is the honest measure of the inversion: one inverted pair is a
      // different defect from a frame that outranks every holding frame.
      const beaten = worst ? withHoldings.filter((r) => r.rank > worst.rank) : [];
      // What the TOP-scoring labelled frame actually reads. The binary
      // comparison above can fail for a reason that is not a defect — the
      // frame holding the most is not necessarily the frame the score should
      // pick. This number is the decision-relevant one: if the prefilter's
      // best pick reads zero holdings, the prefilter is picking the wrong
      // frame.
      const topMatch = /the best-scoring labelled frame holds (\d+) holding\(s\)/.exec(regionBlock);
      const topHolds = topMatch ? Number(topMatch[1]) : null;
      const verdict = !worst
        ? 'no zero-holding frame is labelled'
        : (best.rank < worst.rank
          ? 'OK — the most-holding frame ranks ABOVE the zero-holding frame'
          : `INVERTED — the zero-holding frame outranks ${beaten.length} of ${withHoldings.length} holding frame(s)`);
      console.log(
        `  ${tag.padEnd(9)} ${regionName.padEnd(9)}`
        + `  top pick reads ${topHolds === null ? '?' : String(topHolds).padStart(2)} holding(s)`
        + `  most-holding ts=${String(best.ts).padStart(5)} (${best.holdings})`
        + ` rank ${String(best.rank).padStart(4)}/${best.of}`
        + (worst ? `   zero-holding ts=${String(worst.ts).padStart(5)} rank ${String(worst.rank).padStart(4)}/${worst.of}` : '')
        + `   ${verdict}`
      );
    }
  }
});
