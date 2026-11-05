'use strict';

// Conditional edge matrix over scored TA rows.
// Descriptive only: buckets with min-N and Wilson CI; no in-sample fitting.
// Walk-forward policy uses the same frozen rules on OOS folds.
// Also emits hierarchical 1-D rollups so small samples still surface structure.

const { summarizeRStats } = require('./rMultipleSim');

const DEFAULT_MIN_N = 8;
const DEFAULT_ROLLUP_MIN_N = 5;
const DEFAULT_BASELINE = 0.5;

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} hits
 * @param {number} n
 * @param {number} [z]
 * @returns {{lo:number, hi:number, p:number}|null}
 */
function wilsonInterval(hits, n, z = 1.96) {
  if (!n || n <= 0) return null;
  const phat = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return {
    p: Number(phat.toFixed(4)),
    lo: Number(Math.max(0, (centre - margin) / denom).toFixed(4)),
    hi: Number(Math.min(1, (centre + margin) / denom).toFixed(4)),
  };
}

/**
 * Build a stable bucket key from row fields.
 * @param {object} row
 * @returns {string}
 */
function edgeBucketKey(row) {
  const vol = String(row.vol_regime || 'unknown');
  const mtf = String(row.mtf_label || 'unknown');
  const arch = String(row.archetype || 'unknown');
  const conf = String(row.confidence_band || row.confidence || row.certainty_band || 'unknown');
  return `${vol}|${mtf}|${arch}|${conf}`;
}

/**
 * Score one bucket of rows.
 * @param {string} key
 * @param {Array<object>} rows
 * @param {object} [opts]
 * @returns {object}
 */
function scoreEdgeBucket(key, rows, opts = {}) {
  const minN = Number(opts.minN) || DEFAULT_MIN_N;
  const baseline = Number.isFinite(Number(opts.baseline)) ? Number(opts.baseline) : DEFAULT_BASELINE;
  const list = Array.isArray(rows) ? rows : [];
  const scored = list.filter((r) => r.hit_1w === true || r.hit_1w === false);
  const hits = scored.filter((r) => r.hit_1w === true).length;
  const ci = wilsonInterval(hits, scored.length);
  const rStats = summarizeRStats(list);
  const parts = String(key).split('|');
  let policy = 'thin';
  if (scored.length >= minN && ci) {
    if (ci.lo > baseline) policy = 'allow';
    else if (ci.hi < baseline) policy = 'avoid';
    else policy = 'neutral';
  }
  return {
    key,
    vol_regime: parts[0] || '',
    mtf_label: parts[1] || '',
    archetype: parts[2] || '',
    confidence_band: parts[3] || '',
    n: list.length,
    scored_1w: scored.length,
    hits_1w: hits,
    hit_rate_1w: ci ? ci.p : null,
    wilson_lo: ci ? ci.lo : null,
    wilson_hi: ci ? ci.hi : null,
    baseline,
    min_n: minN,
    policy,
    avg_r: rStats.avg_r,
    median_r: rStats.median_r,
    avg_r_clipped: rStats.avg_r_clipped,
  };
}

/**
 * Group rows by a single field and score.
 * @param {Array<object>} rows
 * @param {string} field
 * @param {object} [opts]
 * @returns {Array<object>}
 */
function rollupByField(rows, field, opts = {}) {
  const minN = Number(opts.rollupMinN) || DEFAULT_ROLLUP_MIN_N;
  const baseline = Number.isFinite(Number(opts.baseline)) ? Number(opts.baseline) : DEFAULT_BASELINE;
  const map = new Map();
  for (const row of rows || []) {
    const key = String(row[field] || 'unknown');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()]
    .map(([key, group]) => {
      const scored = scoreEdgeBucket(key, group, { minN, baseline });
      return {
        ...scored,
        field,
        key,
      };
    })
    .sort((a, b) => b.scored_1w - a.scored_1w || b.n - a.n);
}

/**
 * Conditional edge matrix across vol × mtf × archetype × confidence.
 * @param {Array<object>} rows
 * @param {object} [opts]
 * @returns {object}
 */
function buildEdgeMatrix(rows, opts = {}) {
  const minN = Number(opts.minN) || DEFAULT_MIN_N;
  const rollupMinN = Number(opts.rollupMinN) || DEFAULT_ROLLUP_MIN_N;
  const baseline = Number.isFinite(Number(opts.baseline)) ? Number(opts.baseline) : DEFAULT_BASELINE;
  const map = new Map();
  for (const row of rows || []) {
    const key = edgeBucketKey(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const buckets = [...map.entries()]
    .map(([key, group]) => scoreEdgeBucket(key, group, { minN, baseline }))
    .sort((a, b) => b.scored_1w - a.scored_1w || b.n - a.n);

  const allow = buckets.filter((b) => b.policy === 'allow');
  const avoid = buckets.filter((b) => b.policy === 'avoid');
  const neutral = buckets.filter((b) => b.policy === 'neutral');
  const thin = buckets.filter((b) => b.policy === 'thin');

  const rollups = {
    by_archetype: rollupByField(rows, 'archetype', { rollupMinN, baseline }),
    by_mtf_label: rollupByField(rows, 'mtf_label', { rollupMinN, baseline }),
    by_vol_regime: rollupByField(rows, 'vol_regime', { rollupMinN, baseline }),
    by_confidence_band: rollupByField(rows, 'confidence_band', { rollupMinN, baseline }),
    by_source: rollupByField(rows, 'source', { rollupMinN, baseline }),
  };

  return {
    min_n: minN,
    rollup_min_n: rollupMinN,
    baseline,
    bucket_count: buckets.length,
    allow_count: allow.length,
    avoid_count: avoid.length,
    neutral_count: neutral.length,
    thin_count: thin.length,
    allow: allow.slice(0, 25),
    avoid: avoid.slice(0, 25),
    neutral: neutral.slice(0, 25),
    thin: thin.slice(0, 15),
    buckets,
    rollups,
    note: 'Full matrix is vol|mtf|archetype|confidence with Wilson CI. Hierarchical rollups expose 1-D structure at lower min-N. Policy is frozen; validate only out-of-sample via walk-forward.',
  };
}

/**
 * Apply a frozen edge policy to rows (for walk-forward OOS checks).
 * Uses full-matrix allow buckets only (not 1-D rollups).
 * @param {Array<object>} trainRows used only to build the policy table
 * @param {Array<object>} testRows
 * @param {object} [opts]
 * @returns {object}
 */
function applyEdgePolicyWalkForward(trainRows, testRows, opts = {}) {
  const matrix = buildEdgeMatrix(trainRows, opts);
  const policyByKey = new Map(matrix.buckets.map((b) => [b.key, b.policy]));
  const test = Array.isArray(testRows) ? testRows : [];
  const selected = test.filter((row) => {
    const policy = policyByKey.get(edgeBucketKey(row)) || 'thin';
    return policy === 'allow';
  });
  const avoided = test.filter((row) => policyByKey.get(edgeBucketKey(row)) === 'avoid');

  function hitRate(list) {
    const scored = list.filter((r) => r.hit_1w === true || r.hit_1w === false);
    if (!scored.length) return null;
    return Number((scored.filter((r) => r.hit_1w === true).length / scored.length).toFixed(4));
  }

  return {
    train_bucket_count: matrix.bucket_count,
    train_allow_count: matrix.allow_count,
    test_n: test.length,
    selected_n: selected.length,
    avoided_n: avoided.length,
    selected_hit_rate_1w: hitRate(selected),
    avoided_hit_rate_1w: hitRate(avoided),
    all_test_hit_rate_1w: hitRate(test),
  };
}

module.exports = {
  DEFAULT_BASELINE,
  DEFAULT_MIN_N,
  DEFAULT_ROLLUP_MIN_N,
  applyEdgePolicyWalkForward,
  buildEdgeMatrix,
  edgeBucketKey,
  rollupByField,
  scoreEdgeBucket,
  wilsonInterval,
};
