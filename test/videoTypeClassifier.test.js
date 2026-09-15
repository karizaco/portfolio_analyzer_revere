'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyVideoType,
  isWeekendUpload,
  TYPE_BADGE_LABEL
} = require('../src/normalize/videoTypeClassifier');

test('classifyVideoType flags weekend reviews by title regex', () => {
  assert.equal(classifyVideoType({ title: 'WEEKEND REVIEW $DELL is BACK', uploadDate: '20260822' }), 'weekend_review');
  assert.equal(classifyVideoType({ title: 'WEEKEND WRAP UP', uploadDate: '20260822' }), 'weekend_review');
  assert.equal(classifyVideoType({ title: 'WEEKEND WALKTHRU', uploadDate: '20260823' }), 'weekend_review');
  assert.equal(classifyVideoType({ title: 'WEEKEND RECAP — broad market update', uploadDate: '20260823' }), 'weekend_review');
});

test('classifyVideoType uses upload_date day-of-week as a backstop for weekend uploads', () => {
  // 20260822 = Saturday, 20260823 = Sunday
  assert.equal(classifyVideoType({ title: 'Some market update', uploadDate: '20260822' }), 'weekend_review');
  assert.equal(classifyVideoType({ title: 'Some Sunday market talk', uploadDate: '20260823' }), 'weekend_review');
  // but LIVE hints win over day-of-week fallback
  assert.equal(classifyVideoType({ title: 'LIVE market update', uploadDate: '20260822' }), 'live_update');
});

test('classifyVideoType flags weekday non-DMI features', () => {
  assert.equal(classifyVideoType({ title: 'AI STOCKS ARE BACK!', uploadDate: '20260819' }), 'feature');
  assert.equal(classifyVideoType({ title: 'BULLS SHOW UP AS INDEXES RALLY', uploadDate: '20260819' }), 'feature');
  assert.equal(classifyVideoType({ title: '30-YEAR YIELDS MAKING NEW HIGHS', uploadDate: '20260820' }), 'feature');
  assert.equal(classifyVideoType({ title: 'CHINA TARIFFS HIT — WHAT NOW?', uploadDate: '20260821' }), 'feature');
  assert.equal(classifyVideoType({ title: 'FOMC DECISION DAY — RATE PATH', uploadDate: '20260819' }), 'feature');
});

test('classifyVideoType flags daily DMI episodes', () => {
  assert.equal(classifyVideoType({ title: 'TUES, 11/15/22 - DMI recap', uploadDate: '20260818' }), 'daily');
  assert.equal(classifyVideoType({ title: '11/15/22 TUES', uploadDate: '20260818' }), 'daily');
  assert.equal(classifyVideoType({ title: 'NOV 15 DMI recap', uploadDate: '20260818' }), 'daily');
  assert.equal(classifyVideoType({ title: 'THE REVERE ROUNDUP WED 11/16', uploadDate: '20260817' }), 'daily');
  assert.equal(classifyVideoType({ title: 'TALE OF THE TAPE TUES 11/15', uploadDate: '20260818' }), 'daily');
});

test('classifyVideoType flags live updates by title hints', () => {
  assert.equal(classifyVideoType({ title: 'LIVE — Midday market move', uploadDate: '20260818' }), 'live_update');
  assert.equal(classifyVideoType({ title: 'PRE-MARKET NOTE', uploadDate: '20260818' }), 'live_update');
  assert.equal(classifyVideoType({ title: 'MARKET OPEN', uploadDate: '20260818' }), 'live_update');
});

test('classifyVideoType defaults to daily for unknown/empty titles', () => {
  assert.equal(classifyVideoType({ title: '', uploadDate: '20260818' }), 'daily');
  assert.equal(classifyVideoType({ uploadDate: '20260818' }), 'daily');
  assert.equal(classifyVideoType({ title: 'Some generic recap' }), 'daily'); // no upload_date and no feature match
});

test('isWeekendUpload helper', () => {
  assert.equal(isWeekendUpload('20260822'), true);  // Sat
  assert.equal(isWeekendUpload('20260823'), true);  // Sun
  assert.equal(isWeekendUpload('20260818'), false); // Tue
  assert.equal(isWeekendUpload('20260821'), false); // Fri
  assert.equal(isWeekendUpload(''), false);
  assert.equal(isWeekendUpload(null), false);
});

test('TYPE_BADGE_LABEL exposes a label for every kind', () => {
  assert.equal(TYPE_BADGE_LABEL.daily, 'Daily');
  assert.equal(TYPE_BADGE_LABEL.weekend_review, 'Weekend');
  assert.equal(TYPE_BADGE_LABEL.feature, 'Feature');
  assert.equal(TYPE_BADGE_LABEL.live_update, 'Live');
});
