'use strict';

// The browser backfill's retry rule after a transient stop. Measured on
// 2026-11-23: the computer hibernated three times mid-crawl, the first page
// after every wake failed, and counting those failures escalated the wait to
// 90 minutes after a one-hour hibernation.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  transientPlan, WAKE_WAIT_MS, MAX_TRANSIENT_IN_A_ROW,
} = require('../tools/x_pipeline/runBrowserBackfill.js');

const MIN = 60 * 1000;

test('a stop after the computer slept waits for the network and is not counted', () => {
  const plan = transientPlan({ attempt: 2, reason: 'no_graphql', slept: true, progressed: false });
  assert.deepEqual(plan, { attempt: 2, waitMs: WAKE_WAIT_MS, counted: false });
  assert.equal(WAKE_WAIT_MS, 5 * MIN);
});

test('a session that completed a window restarts the count', () => {
  const plan = transientPlan({ attempt: 3, reason: 'x_error_page', slept: false, progressed: true });
  assert.deepEqual(plan, { attempt: 1, waitMs: 30 * MIN, counted: true });
});

test("X's error page escalates 30, 60, 90 minutes and stays at 90", () => {
  let attempt = 0;
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    const plan = transientPlan({ attempt, reason: 'x_error_page', slept: false, progressed: false });
    attempt = plan.attempt;
    waits.push(plan.waitMs / MIN);
  }
  assert.deepEqual(waits, [30, 60, 90, 90]);
  assert.equal(attempt, 4);
});

test('a lost connection waits 10, 20, 30 minutes -- the reason reaches the wait', () => {
  let attempt = 0;
  const waits = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = transientPlan({ attempt, reason: 'network_error', slept: false, progressed: false });
    attempt = plan.attempt;
    waits.push(plan.waitMs / MIN);
  }
  assert.deepEqual(waits, [10, 20, 30]);
});

test('the budget is still finite for failures that are neither sleep nor progress', () => {
  let attempt = 0;
  let plan;
  for (let i = 0; i <= MAX_TRANSIENT_IN_A_ROW; i += 1) {
    plan = transientPlan({ attempt, reason: 'no_graphql', slept: false, progressed: false });
    attempt = plan.attempt;
  }
  assert.ok(plan.counted && attempt > MAX_TRANSIENT_IN_A_ROW);
});
