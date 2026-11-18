'use strict';

// The Komar REPORT NUMBER as a date.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The report number IS chronological: it is a weekly report, seven
// days a number (43 is 19 November 2022, 50 is 8 January 2023, 70 is
// 29 May 2023, 211 is 25 January 2026, 226 is 9 May 2026). So it
// dates a session whose own name carries no date -- which is 44 of the
// corpus's 116 videos.
//
// The corpus has exactly ONE name that disagrees with the sequence,
// "January 14 2022 Weekend-Report 51", and its YEAR is a typo: 50 is
// 8 January 2023 and 51 is the weekend after it. So a pair whose
// cadence is not a weekly one is REFUSED rather than used -- which is
// what stops the typo from poisoning the sessions around it.

const assert = require('node:assert/strict');
const test = require('node:test');

const { dateFromReportNumber } = require('../src/komar/corpusCatalog');

// The dated anchors the catalog itself recorded (measured 2026-11-17).
const ANCHORS = [
  { number: 43, date: '20221119' },
  { number: 50, date: '20230108' },
  { number: 70, date: '20230529' },
  { number: 211, date: '20260125' },
  { number: 215, date: '20260221' },
  { number: 218, date: '20260314' },
  { number: 222, date: '20260411' },
  { number: 224, date: '20260425' },
  { number: 226, date: '20260509' },
];

test('an anchored report is dated by its own name', () => {
  assert.equal(dateFromReportNumber(43, ANCHORS).date, '20221119');
  assert.equal(dateFromReportNumber(50, ANCHORS).date, '20230108');
  assert.equal(dateFromReportNumber(226, ANCHORS).date, '20260509');
});

test('the number dates the sessions whose own name carries no date', () => {
  // 94 sits between 70 (29 May 2023) and 211 (25 Jan 2026): 141 reports
  // over 972 days, so 6.9 days a report.
  const dated = dateFromReportNumber(94, ANCHORS);
  assert.ok(dated, 'report 94 is dated');
  assert.match(dated.date, /^2023/, 'and it lands in 2023');
  // And 199, the last of the 2025 series, lands in November 2025 --
  // and the FILES' own timestamps put it there independently: they run
  // 188 -> 199 in exact seven-day steps, ending 2 November 2025. The
  // interpolation lands a day later, which is inside the week's slack
  // the dates carry.
  const last = dateFromReportNumber(199, ANCHORS);
  assert.ok(last.date.startsWith('202511'), `lands in November 2025, got ${last.date}`);
});

test('the cadence is seven days a report', () => {
  const dated = dateFromReportNumber(199, ANCHORS);
  assert.ok(Math.abs(dated.days_per_report - 6.9) < 0.2, `measured ${dated.days_per_report}`);
});

test('the one misdated name is not trusted, and it poisons nothing', () => {
  // With the typo in the anchors, the pair around it says 26 days a
  // report -- which is not a weekly report -- so nothing is dated from
  // it.
  const withTypo = [...ANCHORS, { number: 51, date: '20220114' }];
  assert.equal(dateFromReportNumber(51, withTypo), null, 'the typo is refused');
  // And the sessions around it are still dated, from the clean pair.
  const dated = dateFromReportNumber(50, ANCHORS);
  assert.equal(dated.date, '20230108');
});

test('a pair that is not a weekly report dates nothing', () => {
  const odd = [
    { number: 10, date: '20200101' },
    { number: 20, date: '20210101' },
  ];
  assert.equal(dateFromReportNumber(15, odd), null, 'a year a report is not a weekly report');
});

test('nothing is dated without enough anchors', () => {
  assert.equal(dateFromReportNumber(94, []), null);
  assert.equal(dateFromReportNumber(94, [{ number: 70, date: '20230529' }]), null);
  assert.equal(dateFromReportNumber('not a number', ANCHORS), null);
});
