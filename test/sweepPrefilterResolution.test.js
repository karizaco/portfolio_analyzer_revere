'use strict';

// The prefilter-resolution SWEEP: `tools/sweepPrefilterResolution.js`.
//
// This is the wide measurement CLAUDE.md requires before the prefilter's
// working resolution can be changed. The corpus it measures is untracked, so
// the real numbers cannot be asserted here — what CAN be asserted is the
// tool's own judgement logic, because that is what turns a ranking into a
// verdict.
//
// The verdict is the whole point of the tool, so it gets the most attention:
//
//   OK              no zero-holding frame outranks a holding frame
//   PARTIAL         a zero-holding frame outranks SOME of them
//   INVERTED        the best zero-holding frame outranks EVERY one of them
//   NO_ZERO_FRAME   the date cannot answer the question
//
// The 2026-11-02 measurement found the ranking INVERTED on 20230609 at the
// pipeline's own 160x90: the highest-scoring frame read ZERO holdings while
// the frame that read the date exactly ranked near the bottom.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRegions,
  evaluateRanking,
  productionTemporalDecay,
  spearman,
  summarize
} = require('../tools/sweepPrefilterResolution');

const { chartStreamPrefilterRegionForDate } = require('../src/video/chartStreamCrop');

/**
 * A ranking of frames, best first.
 *
 * `frames` is [{frameIndex, score}], and `labels` is [{ts, holdings}]. The
 * timestamp→frame mapping is `Math.round(ts * fps)`, which is what the
 * measurement tool uses to address a frame by the timestamp the probe log
 * recorded.
 */
function ranking(frames, labels, options = {}) {
  const fps = options.fps || 0.25;
  const rows = frames.map((frame) => ({
    frameIndex: frame.frameIndex,
    timestamp: Number((frame.frameIndex / fps).toFixed(3)),
    score: frame.score,
    stats: frame.stats || {
      midToneRatioTicker: 0,
      midToneRatioTickerRegion: 0,
      rowDensity: 0,
      multiColStripeCount: 0,
      meanLuma: 0
    },
    components: frame.components || {}
  }));
  return evaluateRanking(rows, labels, { fps, topK: options.topK || 12 });
}

// Four labelled frames, four seconds apart: two that hold something, one
// that holds nothing, one that holds nothing.
const LABELS = [
  { ts: 0, holdings: 12 },
  { ts: 4, holdings: 12 },
  { ts: 8, holdings: 0 },
  { ts: 12, holdings: 0 }
];

test('a ranking that puts the empty frames last is OK', () => {
  const judged = ranking(
    [
      { frameIndex: 0, score: 30 },
      { frameIndex: 1, score: 28 },
      { frameIndex: 2, score: 5 },
      { frameIndex: 3, score: 4 }
    ],
    LABELS
  );
  assert.equal(judged.verdict, 'OK');
  assert.equal(judged.zero_outranks, 0);
  assert.equal(judged.holding_frames, 2);
  assert.equal(judged.zero_frames, 2);
});

test('a ranking that puts an empty frame above every holding frame is INVERTED', () => {
  const judged = ranking(
    [
      { frameIndex: 2, score: 30 },
      { frameIndex: 3, score: 28 },
      { frameIndex: 0, score: 5 },
      { frameIndex: 1, score: 4 }
    ],
    LABELS
  );
  assert.equal(judged.verdict, 'INVERTED');
  assert.equal(judged.zero_outranks, 2);
  assert.equal(judged.holding_frames, 2);
  // The best EMPTY frame is the one that outranks them — the tool names it,
  // because it is the frame the prefilter would have picked.
  assert.equal(judged.best_zero.holdings, 0);
  assert.equal(judged.best_zero.rank, 1);
});

test('a ranking that puts an empty frame above SOME holding frames is PARTIAL', () => {
  const judged = ranking(
    [
      { frameIndex: 0, score: 30 },
      { frameIndex: 2, score: 28 },
      { frameIndex: 1, score: 5 },
      { frameIndex: 3, score: 4 }
    ],
    LABELS
  );
  assert.equal(judged.verdict, 'PARTIAL');
  assert.equal(judged.zero_outranks, 1);
});

test('a date with no empty frame cannot answer the question', () => {
  const judged = ranking(
    [
      { frameIndex: 0, score: 30 },
      { frameIndex: 1, score: 28 },
      { frameIndex: 2, score: 5 }
    ],
    [
      { ts: 0, holdings: 12 },
      { ts: 4, holdings: 11 },
      { ts: 8, holdings: 3 }
    ]
  );
  assert.equal(judged.verdict, 'NO_ZERO_FRAME');
  assert.equal(judged.zero_outranks, null);
});

test('the verdict counts only the HOLDING frames, not every frame', () => {
  // Five labelled frames: two holding, three empty. The best empty frame
  // outranks one holding frame and one empty frame — the verdict must count
  // one, not two.
  const judged = ranking(
    [
      { frameIndex: 0, score: 30 },
      { frameIndex: 2, score: 20 },
      { frameIndex: 3, score: 15 },
      { frameIndex: 4, score: 10 },
      { frameIndex: 1, score: 1 }
    ],
    [
      { ts: 0, holdings: 12 },
      { ts: 4, holdings: 11 },
      { ts: 8, holdings: 0 },
      { ts: 12, holdings: 0 },
      { ts: 16, holdings: 0 }
    ]
  );
  assert.equal(judged.verdict, 'PARTIAL');
  assert.equal(judged.holding_frames, 2);
  assert.equal(judged.zero_frames, 3);
  assert.equal(judged.zero_outranks, 1);
});

test('the best labelled frame reports the holdings it read', () => {
  // The "top pick reads N holdings" column. The top pick of the WHOLE
  // ranking is almost never a labelled frame in a wide sweep, so the number
  // is stated over the labelled subset.
  const judged = ranking(
    [
      { frameIndex: 5, score: 99 },
      { frameIndex: 0, score: 30 },
      { frameIndex: 2, score: 28 }
    ],
    LABELS
  );
  assert.equal(judged.best_labelled.holdings, 12);
  assert.equal(judged.best_labelled.rank, 2);
  assert.equal(judged.best_labelled.ts, 0);
});

test('a label is addressed by Math.round(ts * fps), the same way the frame is', () => {
  // ts 5.5 at 0.25 fps is frame 1.375 — it rounds to frame 1. The tool has
  // to use the SAME rounding as the extraction, or a label describes the
  // wrong frame.
  const judged = ranking(
    [
      { frameIndex: 1, score: 30 },
      { frameIndex: 2, score: 10 }
    ],
    [{ ts: 5.5, holdings: 7 }],
    { fps: 0.25 }
  );
  assert.equal(judged.labelled_frames, 1);
  assert.equal(judged.labelled[0].holdings, 7);
  assert.equal(judged.labelled[0].rank, 1);
});

test('spearman is NEGATIVE for a ranking that gets it right', () => {
  // A low rank (a good frame) should carry a high holding count.
  const good = spearman([[1, 12], [2, 11], [3, 9]]);
  const bad = spearman([[1, 1], [2, 5], [3, 12]]);
  assert.ok(good < 0, `a correct ranking should correlate negatively, got ${good}`);
  assert.ok(bad > 0, `an inverted ranking should correlate positively, got ${bad}`);
});

test('holding frames inside the top K are counted', () => {
  // Production OCRs `--prefilter-max-frames 12` frames, so the question
  // "would the score alone put a holding frame in the pool" is answerable.
  const judged = ranking(
    [
      { frameIndex: 0, score: 30 },
      { frameIndex: 1, score: 28 },
      { frameIndex: 2, score: 5 },
      { frameIndex: 3, score: 4 }
    ],
    LABELS,
    { topK: 1 }
  );
  assert.equal(judged.top_k, 1);
  assert.equal(judged.holding_frames_in_top_k, 1);
});

test('production temporal decay follows the era', () => {
  // The 2022-era dates get the scan tool's default 1800; the 2023-era
  // sidebar dates get an explicit 0 (tools/runQmgOcrBatch.js).
  assert.equal(productionTemporalDecay('20220421'), 1800);
  assert.equal(productionTemporalDecay('20230609'), 0);
  // An unknown date is the sidebar era — the same asymmetric fallback the
  // crop uses.
  assert.equal(productionTemporalDecay(''), 0);
  assert.equal(productionTemporalDecay('not-a-date'), 0);
});

test('the two rectangles are the legacy fallback and the era rectangle', () => {
  const regions = buildRegions('20230609');
  assert.equal(regions.length, 2);
  const fallback = regions.find((r) => r.name === 'fallback');
  const era = regions.find((r) => r.name === 'era');
  assert.deepEqual(fallback.region, { left: 0.85, top: 0.55 });
  assert.deepEqual(era.region, chartStreamPrefilterRegionForDate('20230609'));

  // The two eras measure DIFFERENT rectangles — the whole reason the
  // rectangle is era-conditional.
  const era2022 = buildRegions('20220421').find((r) => r.name === 'era');
  assert.notDeepEqual(era2022.region, era.region);
});

test('the roll-up counts the two eras separately', () => {
  // The same result key is used by both eras, and the two have to be
  // counted apart: the 2022-era floating panel and the 2023-era right
  // sidebar have different geometry.
  const dates = [
    {
      date: '20220421',
      era: '2022',
      results: { 'era@160x90@production': { verdict: 'OK', spearman_rank_holdings: -0.8, best_labelled: { holdings: 12 } } }
    },
    {
      date: '20230609',
      era: '2023',
      results: { 'era@160x90@production': { verdict: 'INVERTED', spearman_rank_holdings: 0.4, best_labelled: { holdings: 0 } } }
    }
  ];

  const summary = summarize(dates);
  const bucket2022 = summary['2022|era@160x90@production'];
  const bucket2023 = summary['2023|era@160x90@production'];
  assert.ok(bucket2022, 'the 2022-era bucket is missing');
  assert.ok(bucket2023, 'the 2023-era bucket is missing');
  assert.equal(bucket2022.dates, 1);
  assert.equal(bucket2022.verdicts.OK, 1);
  assert.equal(bucket2023.verdicts.INVERTED, 1);
  assert.equal(bucket2023.mean_best_labelled, 0);
});
