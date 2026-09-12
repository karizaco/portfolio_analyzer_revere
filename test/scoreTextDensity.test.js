'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreTextDensity } = require('../src/video/ocrScanLogic');

test('scoreTextDensity returns 0 for missing OCR result', () => {
  assert.equal(scoreTextDensity(null), 0);
  assert.equal(scoreTextDensity(undefined), 0);
});

test('scoreTextDensity returns 0 for empty OCR result', () => {
  assert.equal(scoreTextDensity({ text: '', lines: [] }), 0);
});

test('scoreTextDensity awards positive score for short text-heavy OCR output', () => {
  const score = scoreTextDensity({
    text: 'INDEXES FALL\nSPX -0.48\nQQQ -0.29\nGRO -0.46\nTURBO -0.53',
    lines: ['INDEXES FALL', 'SPX -0.48', 'QQQ -0.29', 'GRO -0.46', 'TURBO -0.53']
  });

  // 5 lines * 1.5 + ~44 chars / 50 + 0 keyword hits ≈ 7.5 + 0.88 = 8.38 → 8.38
  assert.ok(score >= 7, `expected score >= 7, got ${score}`);
  assert.ok(score <= 10, `expected score <= 10, got ${score}`);
});

test('scoreTextDensity awards large score for DMI-like 20-line output', () => {
  const dmiLines = [
    'DAILY MARKET INSIGHT',
    'MARKET STATE: UPTREND',
    'WHAT HAPPENED TODAY?',
    'INDEXES FALL ON MID EAST TENSIONS AS MKT AWAITS CPI PPI SPCX AMD I',
    '21/21 +0.05%   T-12 -1.24%   MAG7 +0.36%   RG8 -1.21%',
    'RAI100 -0.24%   SPX -0.48%   RSP -0.96%   QQQ -0.29%',
    'QQQE -0.82%   DJIA -0.75%   MID -1.06%   R2K -1.37%',
    '60/40 -0.49%   GRO -0.46%   TURBO -0.53%',
    'PROTECT   NEUTRAL   GROW',
    'CONTACT YOUR ADVISOR',
    'BOTTOM LINE HEALTHY',
    'LEADERS INTACT',
    'ADD TO LEADERS',
    'TRIM SMALL CAPS',
    'CASH POSITION STABLE',
    '21/21 ABOVE 200 DAY',
    'T-12 BELOW 200 DAY',
    'RG8 SELLING',
    'MAG7 GREEN',
    'NO MARKET STRESS'
  ];
  const dmiText = dmiLines.join('\n');

  const score = scoreTextDensity({ text: dmiText, lines: dmiLines });

  // 20 lines * 1.5 + ~470 chars / 50 + 5+ keyword hits * 4 ≈ 30 + 9.4 + 20 = 59.4
  assert.ok(score >= 50, `expected score >= 50, got ${score}`);
});

test('scoreTextDensity boosts score when text-heavy output contains keyword hits', () => {
  const keywordScore = scoreTextDensity({
    text: 'DAILY MARKET INSIGHT\nMARKET STATE: UPTREND\nGRO -0.46\nTURBO -0.53\nBOTTOM LINE HEALTHY',
    lines: ['DAILY MARKET INSIGHT', 'MARKET STATE: UPTREND', 'GRO -0.46', 'TURBO -0.53', 'BOTTOM LINE HEALTHY']
  });

  const noKeywordScore = scoreTextDensity({
    text: 'SOMETHING ELSE\nINDICATOR X\nVALUE A\nVALUE B\nVALUE C',
    lines: ['SOMETHING ELSE', 'INDICATOR X', 'VALUE A', 'VALUE B', 'VALUE C']
  });

  assert.ok(keywordScore > noKeywordScore * 2, `keyword score ${keywordScore} should be > 2x no-keyword ${noKeywordScore}`);
});

test('scoreTextDensity awards small score for chart-like 4-line output', () => {
  const chartLikeText = 'SPX\n$485.34\n+0.5%\nVol 2.1B';
  const chartLines = chartLikeText.split('\n');

  const score = scoreTextDensity({ text: chartLikeText, lines: chartLines });

  // 4 lines * 1.5 + ~22 chars / 50 + 0 keyword hits ≈ 6 + 0.44 = 6.44
  assert.ok(score >= 4, `expected score >= 4, got ${score}`);
  assert.ok(score <= 8, `expected score <= 8, got ${score}`);
});

test('scoreTextDensity discriminates DMI from chart-like output by > 30 points', () => {
  const dmiLines = [
    'DAILY MARKET INSIGHT', 'MARKET STATE: UPTREND', 'WHAT HAPPENED TODAY?',
    'INDEXES FALL ON TENSIONS', 'SPX -0.48 RSP -0.96', 'QQQ -0.29 DJIA -0.75',
    'MAG7 +0.36 RAI100 -0.24', 'GRO -0.46 TURBO -0.53', '21/21 T-12 RG8',
    'BOTTOM LINE HEALTHY', 'LEADERS INTACT', 'TRIM SMALL CAPS'
  ];

  const chartLines = [
    'SPX $485.34', '+0.5%', 'Vol 2.1B', 'Composite Rating A'
  ];

  const dmiScore = scoreTextDensity({ text: dmiLines.join('\n'), lines: dmiLines });
  const chartScore = scoreTextDensity({ text: chartLines.join('\n'), lines: chartLines });

  assert.ok(dmiScore > chartScore + 30, `DMI score ${dmiScore} should exceed chart score ${chartScore} by > 30`);
});

test('scoreTextDensity produces a 2-decimal-rounded result', () => {
  const score = scoreTextDensity({
    text: 'A B C D E F',
    lines: ['A B C D E F']
  });

  // 1 line * 1.5 + 6 compact chars / 50 + 0 keywords = 1.62 → rounded to 1.62
  assert.equal(score, 1.62);
});
