'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseDashboardLeft } = require('../src/discord/clement/parseDashboardLeft');
const { splitDashboard } = require('../src/discord/clement/dashboardSplit');

const ROOT = path.resolve(__dirname, '..');
const LEFT_A = path.join(
  ROOT,
  'data/discord_pipeline/media/clement/ocr_split_probe',
  '20260109_1459019777577058314_1459019777337987132_LEFT.txt',
);
const LEFT_B = path.join(
  ROOT,
  'data/discord_pipeline/media/clement/ocr_split_probe',
  '20251204_1445979039138578522_1445979038886789200_LEFT.txt',
);
const IMG_A = path.join(
  ROOT,
  'data/discord_pipeline/media/clement',
  '20260109_1459019777577058314_1459019777337987132.png',
);

test('parseDashboardLeft: 2026-01-09 all five YES + metal miners theme', function () {
  if (!fs.existsSync(LEFT_A)) {
    this.skip('split OCR probe not on disk');
    return;
  }
  const parsed = parseDashboardLeft(fs.readFileSync(LEFT_A, 'utf8'));
  assert.equal(parsed.as_of_date, '2026-01-09');
  assert.equal(parsed.signal_yes_count, 5);
  assert.equal(parsed.signals.daily_buy_signal, true);
  assert.equal(parsed.signals.weekly_buy_signal, true);
  assert.equal(parsed.signals.above_rising_5dma, true);
  assert.equal(parsed.signals.traction_last_5, true);
  assert.equal(parsed.signals.net_52w_hl_positive, true);
  assert.match(parsed.focus_themes, /Metal Miners/i);
  assert.match(parsed.technical_theme, /Pop and drops/i);
});

test('parseDashboardLeft: 2025-12-04 Focus List long tickers', function () {
  if (!fs.existsSync(LEFT_B)) {
    this.skip('split OCR probe not on disk');
    return;
  }
  const parsed = parseDashboardLeft(fs.readFileSync(LEFT_B, 'utf8'));
  assert.equal(parsed.as_of_date, '2025-12-04');
  assert.equal(parsed.signal_yes_count, 5);
  const tickers = parsed.ideas.map((i) => i.ticker);
  for (const t of ['FROG', 'FSLY', 'LMND', 'SANM']) {
    assert.ok(tickers.includes(t), `missing ${t} in ${tickers}`);
  }
  const longs = parsed.ideas.filter((i) => i.role === 'long_idea');
  assert.ok(longs.length >= 4);
});

test('splitDashboard finds ~42% white gutter on sample plan', async function () {
  if (!fs.existsSync(IMG_A)) {
    this.skip('dashboard png not on disk');
    return;
  }
  const result = await splitDashboard(IMG_A);
  assert.equal(result.method, 'white_gutter');
  assert.ok(result.split_frac > 0.40 && result.split_frac < 0.45, String(result.split_frac));
  assert.ok(result.white_at_split > 0.8);
  assert.ok(result.left.length > 1000);
  assert.ok(result.right.length > 1000);
});
