'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { alignClaimEvent } = require('../src/sevcik/eventAlignment');
const {
  computeIndicatorSnapshot,
  rsi,
  sma,
  macd,
  bollinger,
  atr,
} = require('../src/sevcik/taIndicators');
const { classifyTrendRegime, classifyVolRegime, multiTimeframeScore } = require('../src/sevcik/taRegimes');
const { detectGap, evaluateGapAroundDate, looksLikeGapTalk, gapFillOutcome } = require('../src/sevcik/gapEvaluator');
const { classifySetupArchetype } = require('../src/sevcik/setupArchetypes');
const { simulateRTrade } = require('../src/sevcik/rMultipleSim');
const { evaluateWalkForward, bucketByMonth } = require('../src/sevcik/walkForward');
const { evaluateClaimsWithTa, summarizeTaRows } = require('../src/sevcik/taEvaluation');
const { ensureTaFeatureSchema, replaceTaFeatures } = require('../src/sevcik/taFeatureStore');
const { buildSevcikReportHtml } = require('../src/report/sevcikReport');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});
const { DatabaseSync } = require('node:sqlite');

function makeBars(n, start = 100, step = 1) {
  const bars = [];
  let px = start;
  const day0 = Date.parse('2024-01-01T00:00:00Z');
  for (let i = 0; i < n; i += 1) {
    const d = new Date(day0 + i * 86400000).toISOString().slice(0, 10);
    const open = px;
    const close = px + step;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    bars.push({ date: d, open, high, low, close, volume: 1000 + i * 10 });
    px = close;
  }
  return bars;
}

test('event alignment uses next day after stream', () => {
  const a = alignClaimEvent({ upload_date: '20260717', event_time_sec: 3600 });
  assert.equal(a.claim_date, '2026-07-17');
  assert.equal(a.executable_date, '2026-07-18');
  assert.equal(a.alignment_confidence, 'high');
  assert.equal(a.claim_clock, '01:00:00');
});

test('event alignment without segment time is medium confidence', () => {
  const a = alignClaimEvent({ upload_date: '20260717' });
  assert.equal(a.alignment_confidence, 'medium');
  assert.equal(a.executable_date, '2026-07-18');
});

test('indicators produce finite snapshots on a long series', () => {
  const bars = makeBars(260, 100, 0.2);
  const snap = computeIndicatorSnapshot(bars);
  assert.ok(Number.isFinite(snap.close));
  assert.ok(Number.isFinite(snap.sma20));
  assert.ok(Number.isFinite(snap.sma50));
  assert.ok(Number.isFinite(snap.sma200));
  assert.ok(Number.isFinite(snap.rsi14));
  assert.ok(Number.isFinite(snap.ema21));
  assert.ok(Number.isFinite(snap.atr14));
  assert.ok(Number.isFinite(snap.bb_bandwidth));
  assert.equal(snap.bar_count, 260);
  assert.ok(sma([1, 2, 3], 3) === 2);
  assert.ok(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 14) > 50);
  assert.ok(macd(makeBars(80).map((b) => b.close)).macd != null);
  assert.ok(bollinger(makeBars(30).map((b) => b.close)).mid != null);
  assert.ok(atr(makeBars(30), 14) != null);
});

test('trend and vol regimes classify uptrend / normal-ish series', () => {
  const bars = makeBars(260, 50, 0.5);
  const snap = computeIndicatorSnapshot(bars);
  const trend = classifyTrendRegime(snap);
  const vol = classifyVolRegime(snap);
  assert.equal(trend.label, 'uptrend');
  assert.ok(['low', 'normal', 'high', 'unknown'].includes(vol.label));
});

test('mtf score is higher when indicators agree with bias', () => {
  const bars = makeBars(260, 50, 0.5);
  const snap = computeIndicatorSnapshot(bars);
  const bull = multiTimeframeScore(snap, 'bullish');
  const bear = multiTimeframeScore(snap, 'bearish');
  assert.ok(bull.score > bear.score);
  assert.ok(['strong', 'moderate', 'weak', 'contrary'].includes(bull.label));
});

test('gap talk detection and fill logic', () => {
  assert.equal(looksLikeGapTalk('dnes gapy na NQ'), true);
  assert.equal(looksLikeGapTalk('to byl gab dolu'), true);
  assert.equal(looksLikeGapTalk('plain long setup'), false);
  const prev = { close: 100 };
  const bar = { open: 103, high: 104, low: 102, close: 103.5 };
  const gap = detectGap(prev, bar);
  assert.equal(gap.has_gap, true);
  assert.equal(gap.direction, 'up');
  const fill = gapFillOutcome(gap, 100, [{ date: '2024-01-03', high: 101, low: 99.5, close: 100 }], 5);
  assert.equal(fill.filled, true);
  const ev = evaluateGapAroundDate([
    { date: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: '2024-01-02', open: 103, high: 104, low: 102, close: 103, volume: 1 },
    { date: '2024-01-03', open: 102, high: 102.5, low: 99.8, close: 100.5, volume: 1 },
  ], '2024-01-02', { gapTalk: true });
  assert.equal(ev.has_gap, true);
  assert.equal(ev.filled_5d, true);
});

test('archetype classifies breakout and gap language', () => {
  const br = classifySetupArchetype({ evidence_text: 'cisty breakout nad rezistenci' });
  assert.equal(br.archetype, 'breakout');
  const gp = classifySetupArchetype({ evidence_text: 'sleduju gapy na openu' }, { gap: { gap_talk: true, has_gap: true } });
  assert.equal(gp.archetype, 'gap');
});

test('R-multiple simulation hits target on strong trend', () => {
  const bars = makeBars(40, 100, 1);
  const sim = simulateRTrade({
    bars,
    entryDate: bars[10].date,
    bias: 'bullish',
    atr: 1,
    atrMult: 1,
    targetR: 2,
    maxBars: 20,
  });
  assert.equal(sim.status, 'ok');
  assert.ok(Number.isFinite(sim.r_multiple));
  assert.ok(sim.mfe_r >= 0);
  assert.ok(sim.mae_r >= 0);
});

test('walk-forward needs multiple months', () => {
  const claims = [];
  for (let m = 1; m <= 6; m += 1) {
    for (let i = 0; i < 3; i += 1) {
      claims.push({
        event_date: `2024-0${m}-0${i + 1}`,
        hit_1w: i % 2 === 0,
        r_multiple: i % 2 === 0 ? 1 : -1,
      });
    }
  }
  assert.equal(bucketByMonth(claims).length, 6);
  const wf = evaluateWalkForward(claims, { trainMonths: 3 });
  assert.equal(wf.fold_count, 3);
  assert.ok(wf.avg_test_hit_rate_1w != null);
});

test('evaluateClaimsWithTa integrates provider series', async () => {
  const bars = makeBars(260, 80, 0.3);
  const provider = {
    async getOhlcvSeries() {
      return { symbol: 'AAPL', status: 'ok', bars };
    },
  };
  const { summary, rows } = await evaluateClaimsWithTa([
    {
      source: 'signal',
      video_id: 'v1',
      upload_date: '20240120',
      ticker: 'AAPL',
      bias: 'bullish',
      claim_kind: 'forward',
      evidence_text: 'long breakout na AAPL',
      event_time_sec: 100,
    },
  ], provider, { asOfDate: '2024-12-31' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executable_date, '2024-01-21');
  assert.ok(rows[0].trend_regime);
  assert.ok(rows[0].archetype);
  assert.equal(summary.claim_count, 1);
  const s2 = summarizeTaRows(rows);
  assert.equal(s2.claim_count, 1);
});

test('feature store writes into sqlite', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sevcik-ta-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  ensureTaFeatureSchema(db);
  replaceTaFeatures(db, [{
    source: 'signal',
    source_row_id: 1,
    video_id: 'v1',
    ticker: 'AAPL',
    yahoo_symbol: 'AAPL',
    bias: 'bullish',
    claim_kind: 'forward',
    claim_date: '2024-01-20',
    executable_date: '2024-01-21',
    alignment_confidence: 'high',
    alignment_rule: 'x',
    asof_date: '2024-01-20',
    close: 100,
    rsi14: 55,
    trend_regime: 'uptrend',
    vol_regime: 'normal',
    mtf_score: 3,
    mtf_label: 'moderate',
    archetype: 'breakout',
    gap_talk: 0,
    hit_1w: true,
    return_1w: 0.02,
    r_multiple: 1.2,
  }], 'sevcik-ta-1');
  const n = db.prepare('SELECT COUNT(*) AS n FROM sevcik_ta_features').get().n;
  assert.equal(n, 1);
  db.close();
});

test('dashboard renders TA section when summary present', () => {
  const html = buildSevcikReportHtml({
    signal_count: 0,
    signals: [],
    daily: [],
    tickers: [],
    ta_summary: {
      claim_count: 12,
      hit_rate_1w: 0.5,
      avg_r: 0.1,
      avg_mfe_r: 1.2,
      avg_mae_r: 0.8,
      gap_talk_n: 2,
      gap_fill_rate_5d: 0.5,
      mtf_monotonic_hit_rate: false,
      by_trend_regime: [{ key: 'uptrend', n: 5, scored_1w: 5, hit_rate_1w: 0.6, avg_r: 0.2, avg_aligned_return_1w: 0.01 }],
      by_vol_regime: [],
      by_archetype: [{ key: 'breakout', n: 4, scored_1w: 4, hit_rate_1w: 0.5, avg_r: 0.1, avg_aligned_return_1w: 0.0 }],
      by_mtf_label: [],
      walk_forward: { fold_count: 2, avg_test_hit_rate_1w: 0.4, note: 'test note' },
    },
  });
  assert.ok(html.includes('Technical analysis check'));
  assert.ok(html.includes('By trend regime'));
  assert.ok(html.includes('Walk-forward'));
});

test('dashboard explains how to run TA when missing', () => {
  const html = buildSevcikReportHtml({ signal_count: 0, signals: [], daily: [], tickers: [] });
  assert.ok(html.includes('sevcik:ta'));
});
