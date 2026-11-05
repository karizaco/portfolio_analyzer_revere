'use strict';

// Walk-forward split helpers for claim-level evaluation.
// Pure functions: no I/O.

/**
 * Build contiguous month buckets from claims that have event_date.
 * @param {Array<object>} claims
 * @returns {Array<{month:string, rows:object[]}>}
 */
function bucketByMonth(claims) {
  const map = new Map();
  for (const row of claims || []) {
    const d = String(row.event_date || row.executable_date || row.claim_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const month = d.slice(0, 7);
    if (!map.has(month)) map.set(month, []);
    map.get(month).push(row);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, rows]) => ({ month, rows }));
}

/**
 * Rolling walk-forward folds: train on `trainMonths` then test next month.
 * @param {Array<object>} claims
 * @param {object} [opts]
 * @param {number} [opts.trainMonths]
 * @returns {Array<object>}
 */
function buildWalkForwardFolds(claims, opts = {}) {
  const trainMonths = Number(opts.trainMonths) || 3;
  const buckets = bucketByMonth(claims);
  const folds = [];
  for (let i = trainMonths; i < buckets.length; i += 1) {
    const train = buckets.slice(i - trainMonths, i).flatMap((b) => b.rows);
    const test = buckets[i].rows;
    folds.push({
      fold: folds.length + 1,
      train_months: buckets.slice(i - trainMonths, i).map((b) => b.month),
      test_month: buckets[i].month,
      train_n: train.length,
      test_n: test.length,
      train,
      test,
    });
  }
  return folds;
}

/**
 * Simple summary of a claim set using hit_1w / r_multiple when present.
 * @param {Array<object>} rows
 * @returns {object}
 */
function summarizeFoldRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const scored = list.filter((r) => r.hit_1w === true || r.hit_1w === false);
  const hits = scored.filter((r) => r.hit_1w === true).length;
  const rRows = list.filter((r) => Number.isFinite(Number(r.r_multiple)));
  const avgR = rRows.length
    ? rRows.reduce((a, b) => a + Number(b.r_multiple), 0) / rRows.length
    : null;
  return {
    n: list.length,
    scored_1w: scored.length,
    hit_rate_1w: scored.length ? hits / scored.length : null,
    avg_r: avgR,
  };
}

/**
 * Evaluate walk-forward folds with a frozen metric (no fitting yet).
 * @param {Array<object>} claims
 * @param {object} [opts]
 * @returns {object}
 */
function evaluateWalkForward(claims, opts = {}) {
  const folds = buildWalkForwardFolds(claims, opts);
  const foldSummaries = folds.map((fold) => ({
    fold: fold.fold,
    train_months: fold.train_months,
    test_month: fold.test_month,
    train: summarizeFoldRows(fold.train),
    test: summarizeFoldRows(fold.test),
  }));
  const testHit = foldSummaries
    .map((f) => f.test)
    .filter((s) => s.scored_1w > 0);
  const avgTestHit = testHit.length
    ? testHit.reduce((a, b) => a + b.hit_rate_1w, 0) / testHit.length
    : null;
  return {
    train_months: Number(opts.trainMonths) || 3,
    fold_count: foldSummaries.length,
    avg_test_hit_rate_1w: avgTestHit,
    folds: foldSummaries,
    note: foldSummaries.length
      ? 'Walk-forward folds are descriptive under frozen rules; no parameter fitting yet.'
      : 'Not enough distinct months for walk-forward folds.',
  };
}

module.exports = {
  bucketByMonth,
  buildWalkForwardFolds,
  evaluateWalkForward,
  summarizeFoldRows,
};
