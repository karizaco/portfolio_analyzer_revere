'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  alignClaimEvent,
  isSessionDay,
  nextSessionAfter,
  resolveVenue,
} = require('../src/sevcik/eventAlignment');
const {
  detectGap,
  evaluateGapAroundDate,
  gapFillOutcome,
  looksLikeGapTalk,
  REAL_GAP_PCT,
} = require('../src/sevcik/gapEvaluator');
const { classifySetupArchetype } = require('../src/sevcik/setupArchetypes');
const {
  MIN_STOP_PCT,
  simulateRTrade,
  summarizeRStats,
} = require('../src/sevcik/rMultipleSim');
const {
  bucketByMonth,
  evaluateWalkForward,
} = require('../src/sevcik/walkForward');
const {
  buildEdgeMatrix,
  wilsonInterval,
} = require('../src/sevcik/edgeMatrix');
const {
  confidenceBand,
  dedupePrimaryClaims,
  evaluateClaimsWithTa,
  summarizeTaRows,
} = require('../src/sevcik/taEvaluation');
const {
  ensureTaFeatureSchema,
  replaceTaFeatures,
} = require('../src/sevcik/taFeatureStore');
const { buildSevcikReportHtml } = require('../src/report/sevcikReport');

function makeBars(n, start = 100, step = 0.5) {
  const out = [];
  let px = start;
  const base = new Date('2024-01-02T00:00:00Z');
  for (let i = 0; i < n; i += 1) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    // skip weekends in synthetic series
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      i -= 1;
      base.setUTCDate(base.getUTCDate() + 1);
      continue;
    }
    const open = px;
    const close = px + step;
    out.push({
      date: d.toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + 0.4,
      low: Math.min(open, close) - 0.4,
      close,
      volume: 1000 + i,
    });
    px = close;
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return out;
}

test('looksLikeGapTalk catches czech gap/gab forms', () => {
  assert.equal(looksLikeGapTalk('dneska byly gapy na openu'), true);
  assert.equal(looksLikeGapTalk('ASR napsalo gab nahoru'), true);
  assert.equal(looksLikeGapTalk('bez mezery v textu'), false);
});

test('tiny market open is observed but not a real gap', () => {
  const gap = detectGap({ close: 100 }, { open: 100.8 });
  assert.equal(gap.market_gap_observed, true);
  assert.equal(gap.real_gap, false);
  assert.equal(gap.has_gap, false);
  assert.equal(gap.kind, 'tiny');
  assert.ok(Math.abs(gap.gap_pct) < REAL_GAP_PCT);
});

test('real gap >= 1.5% and fill scoring', () => {
  const prev = { close: 100 };
  const bar = { open: 103, high: 104, low: 102, close: 103.5 };
  const gap = detectGap(prev, bar);
  assert.equal(gap.has_gap, true);
  assert.equal(gap.real_gap, true);
  assert.equal(gap.direction, 'up');
  const fill = gapFillOutcome(gap, 100, [{ date: '2024-01-03', high: 101, low: 99.5, close: 100 }], 5);
  assert.equal(fill.filled, true);
  const ev = evaluateGapAroundDate([
    { date: '2024-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { date: '2024-01-02', open: 103, high: 104, low: 102, close: 103, volume: 1 },
    { date: '2024-01-03', open: 102, high: 102.5, low: 99.8, close: 100.5, volume: 1 },
  ], '2024-01-02', { gapTalk: true });
  assert.equal(ev.has_gap, true);
  assert.equal(ev.linguistic_gap_setup, true);
  assert.equal(ev.filled_5d, true);
});

test('archetype gap requires language + real gap; tiny gap does not win', () => {
  const br = classifySetupArchetype({ evidence_text: 'cisty breakout nad rezistenci' });
  assert.equal(br.archetype, 'breakout');

  const tiny = classifySetupArchetype(
    { evidence_text: 'sleduju gapy na openu' },
    { gap: { gap_talk: true, has_gap: false, real_gap: false, gap_pct: 0.006 } },
  );
  assert.notEqual(tiny.archetype, 'gap');
  assert.equal(tiny.gap_qualified, false);

  const real = classifySetupArchetype(
    { evidence_text: 'sleduju gapy na openu' },
    { gap: { gap_talk: true, has_gap: true, real_gap: true, gap_pct: 0.03 } },
  );
  assert.equal(real.archetype, 'gap');
  assert.equal(real.gap_qualified, true);
});

test('R-multiple floor blocks absurd tiny-ATR blowups and summarizeRStats clips', () => {
  const bars = makeBars(30, 100, 0.2);
  const entryDate = bars[5].date;
  const sim = simulateRTrade({
    bars,
    entryDate,
    bias: 'bullish',
    atr: 0.01, // tiny ATR would previously create huge R magnitudes
    atrMult: 1.5,
    targetR: 2,
    maxBars: 10,
    useStructureStop: false,
  });
  assert.equal(sim.status, 'ok');
  assert.ok(sim.stop_dist >= bars[5].open * MIN_STOP_PCT - 1e-9);
  assert.ok(String(sim.stop_mode).includes('floor'));
  assert.ok(Math.abs(sim.r_multiple) <= 50);

  const stats = summarizeRStats([
    { r_multiple: 12, mfe_r: 2, mae_r: 1, exit_reason: 'target' },
    { r_multiple: -20, mfe_r: 0.2, mae_r: 3, exit_reason: 'stop' },
    { r_multiple: 1, mfe_r: 1.1, mae_r: 0.4, exit_reason: 'time' },
  ]);
  assert.equal(stats.avg_r_clipped, Number(((-5 + 5 + 1) / 3).toFixed(4)) || stats.avg_r_clipped);
  assert.ok(stats.median_r != null);
  assert.equal(stats.exit_mix.stop, 1);
  assert.equal(stats.exit_mix.target, 1);
  assert.equal(stats.exit_mix.time, 1);
  assert.ok(Math.abs(stats.avg_r_clipped) <= 5 + 1e-9);
});

test('session calendar skips weekend after Friday stream', () => {
  // 2024-01-19 is Friday
  const a = alignClaimEvent({
    upload_date: '20240119',
    ticker: 'AAPL',
    event_time_sec: 3600,
  });
  assert.equal(a.claim_date, '2024-01-19');
  assert.equal(a.executable_date, '2024-01-22');
  assert.equal(a.venue, 'US');
  assert.equal(a.alignment_confidence, 'high');
  assert.equal(isSessionDay('2024-01-20', 'US'), false);
  assert.equal(nextSessionAfter('2024-01-19', 'US'), '2024-01-22');
});

test('resolveVenue maps PR and DE suffixes', () => {
  assert.equal(resolveVenue('CEZ').venue, 'PR');
  assert.equal(resolveVenue('RHM').venue, 'DE');
  assert.equal(resolveVenue('AAPL').venue, 'US');
});

test('dedupe prefers signal over setup on same video/ticker/date', () => {
  const { primary, dropped } = dedupePrimaryClaims([
    {
      source: 'setup', video_id: 'v1', ticker: 'AAPL', executable_date: '2024-01-22',
      confidence: 0.9, source_row_id: 1,
    },
    {
      source: 'signal', video_id: 'v1', ticker: 'AAPL', executable_date: '2024-01-22',
      confidence: 0.4, source_row_id: 2,
    },
  ]);
  assert.equal(primary.length, 1);
  assert.equal(primary[0].source, 'signal');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].source, 'setup');
});

test('dual scorecards and edge matrix shape', () => {
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      source: i < 8 ? 'signal' : 'setup',
      video_id: `v${i % 6}`,
      ticker: 'AAA',
      executable_date: '2024-02-01',
      confidence: 0.8,
      hit_1w: i % 3 !== 0,
      r_multiple: i % 2 === 0 ? 1 : -1,
      mfe_r: 1,
      mae_r: 0.5,
      exit_reason: i % 2 === 0 ? 'target' : 'stop',
      vol_regime: 'normal',
      mtf_label: 'strong',
      archetype: 'breakout',
      confidence_band: 'high',
      real_gap: false,
      gap_talk: false,
      linguistic_gap_setup: false,
      market_gap_observed: false,
      has_gap: false,
    });
  }
  // Force a second bucket with avoid-like hits
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      source: 'signal',
      video_id: `w${i}`,
      ticker: 'BBB',
      executable_date: `2024-03-${String((i % 20) + 1).padStart(2, '0')}`,
      confidence: 0.2,
      hit_1w: false,
      r_multiple: -1,
      mfe_r: 0.2,
      mae_r: 1,
      exit_reason: 'stop',
      vol_regime: 'high',
      mtf_label: 'contrary',
      archetype: 'mean_reversion',
      confidence_band: 'low',
      real_gap: false,
      gap_talk: false,
      linguistic_gap_setup: false,
      market_gap_observed: false,
      has_gap: false,
    });
  }
  const summary = summarizeTaRows(rows, { edgeMinN: 8 });
  assert.ok(summary.scorecards);
  assert.equal(summary.scorecards.signals_only.claim_count, 20);
  assert.equal(summary.scorecards.setups_only.claim_count, 4);
  assert.ok(summary.dedupe.primary_n <= rows.length);
  assert.ok(summary.edge_matrix);
  assert.ok(summary.edge_matrix.bucket_count >= 2);
  assert.ok(Array.isArray(summary.edge_matrix.buckets));
  const ci = wilsonInterval(10, 12);
  assert.ok(ci.lo < ci.p && ci.p < ci.hi);

  const matrix = buildEdgeMatrix(rows, { minN: 8 });
  assert.ok(matrix.allow_count + matrix.avoid_count + matrix.neutral_count + matrix.thin_count === matrix.bucket_count);
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

test('evaluateClaimsWithTa integrates provider series and new fields', async () => {
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
      upload_date: '20240119', // Friday
      ticker: 'AAPL',
      bias: 'bullish',
      claim_kind: 'forward',
      evidence_text: 'long breakout na AAPL',
      event_time_sec: 100,
      confidence: 0.8,
    },
    {
      source: 'setup',
      video_id: 'v1',
      upload_date: '20240119',
      ticker: 'AAPL',
      bias: 'bullish',
      claim_kind: 'forward',
      evidence_text: 'setup long breakout',
      event_time_sec: 100,
      confidence: 0.9,
    },
  ], provider, { asOfDate: '2024-12-31', edgeMinN: 1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].executable_date, '2024-01-22');
  assert.equal(rows[0].venue, 'US');
  assert.ok(rows[0].trend_regime);
  assert.ok(rows[0].archetype);
  assert.ok('real_gap' in rows[0]);
  assert.ok('r_multiple_clipped' in rows[0] || rows[0].r_multiple == null || Number.isFinite(rows[0].r_multiple_clipped));
  assert.equal(summary.claim_count, 2);
  assert.ok(summary.scorecards.deduped_primary.claim_count === 1);
  assert.ok(summary.edge_matrix);
  assert.equal(summary.feature_version, 'sevcik-ta-3');
  const s2 = summarizeTaRows(rows);
  assert.equal(s2.claim_count, 2);
});

test('feature store writes into sqlite including new columns', (t) => {
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
    claim_date: '2024-01-19',
    executable_date: '2024-01-22',
    alignment_confidence: 'high',
    alignment_rule: 'x',
    venue: 'US',
    asof_date: '2024-01-19',
    close: 100,
    rsi14: 55,
    trend_regime: 'uptrend',
    vol_regime: 'normal',
    mtf_score: 3,
    mtf_label: 'moderate',
    archetype: 'breakout',
    gap_talk: 0,
    linguistic_gap_setup: false,
    market_gap_observed: false,
    real_gap: false,
    hit_1w: true,
    return_1w: 0.02,
    r_multiple: 1.2,
    r_multiple_clipped: 1.2,
    stop_mode: 'atr|floor',
    confidence_band: 'high',
  }], 'sevcik-ta-3');
  const n = db.prepare('SELECT COUNT(*) AS n FROM sevcik_ta_features').get().n;
  assert.equal(n, 1);
  const row = db.prepare('SELECT venue, real_gap, r_multiple_clipped, confidence_band FROM sevcik_ta_features').get();
  assert.equal(row.venue, 'US');
  assert.equal(row.confidence_band, 'high');
  assert.equal(row.r_multiple_clipped, 1.2);
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
      avg_r_clipped: 0.05,
      median_r: 0.02,
      avg_mfe_r: 1.2,
      avg_mae_r: 0.8,
      gap_talk_n: 2,
      gap_real_n: 1,
      gap_linguistic_n: 1,
      gap_fill_rate_5d: 0.5,
      mtf_monotonic_hit_rate: false,
      exit_mix: { stop: 4, target: 3, time: 5 },
      scorecards: {
        all: { claim_count: 12, scored_1w: 10, hit_rate_1w: 0.5, median_r: 0.02, avg_r_clipped: 0.05, avg_r: 0.1 },
        signals_only: { claim_count: 8, scored_1w: 8, hit_rate_1w: 0.55, median_r: 0.1, avg_r_clipped: 0.1, avg_r: 0.1 },
        setups_only: { claim_count: 4, scored_1w: 2, hit_rate_1w: 0.3, median_r: -0.5, avg_r_clipped: -0.4, avg_r: -1 },
        deduped_primary: { claim_count: 9, scored_1w: 9, hit_rate_1w: 0.52, median_r: 0.05, avg_r_clipped: 0.04, avg_r: 0.08 },
      },
      dedupe: { primary_n: 9, dropped_n: 3 },
      by_trend_regime: [{ key: 'uptrend', n: 5, scored_1w: 5, hit_rate_1w: 0.6, avg_r: 0.2, median_r: 0.1, avg_r_clipped: 0.15, avg_aligned_return_1w: 0.01 }],
      by_vol_regime: [],
      by_archetype: [{ key: 'breakout', n: 4, scored_1w: 4, hit_rate_1w: 0.5, avg_r: 0.1, median_r: 0.05, avg_r_clipped: 0.08, avg_aligned_return_1w: 0.0 }],
      by_mtf_label: [],
      by_source: [],
      edge_matrix: {
        min_n: 8,
        allow_count: 1,
        avoid_count: 0,
        neutral_count: 0,
        thin_count: 2,
        allow: [{ policy: 'allow', key: 'normal|strong|breakout|high', scored_1w: 10, hit_rate_1w: 0.7, wilson_lo: 0.55, wilson_hi: 0.85, median_r: 0.4 }],
        avoid: [],
        note: 'descriptive',
      },
      walk_forward: { fold_count: 2, avg_test_hit_rate_1w: 0.4, note: 'test note', edge_policy: { avg_selected_hit_rate_1w: 0.6 } },
    },
  });
  assert.ok(html.includes('Technical analysis check'));
  assert.ok(html.includes('By trend regime'));
  assert.ok(html.includes('Walk-forward'));
  assert.ok(html.includes('Scorecards'));
  assert.ok(html.includes('Edge matrix'));
});



test('confidence_label maps into confidence_band', () => {
  assert.equal(confidenceBand({ confidence_label: 'high', confidence_score: 0.9 }), 'high');
  assert.equal(confidenceBand({ confidence_label: 'medium', confidence_score: 0.5 }), 'medium');
  assert.equal(confidenceBand({ confidence_label: 'low', confidence_score: 0.2 }), 'low');
  assert.equal(confidenceBand({ confidence_score: 0.8 }), 'high');
  assert.equal(confidenceBand({}), 'unknown');
});

test('zero-close bar must not produce absurd R', () => {
  const bars = makeBars(25, 100, 0.2);
  // Poison a late bar the way Yahoo sometimes does for CEZ.PR stubs.
  bars[20] = { ...bars[20], open: 0, high: 0, low: 0, close: 0, volume: 0 };
  bars[21] = { ...bars[21], open: 0, high: 0, low: 0, close: 0, volume: 0 };
  const sim = simulateRTrade({
    bars,
    entryDate: bars[5].date,
    bias: 'bullish',
    atr: 2,
    atrMult: 1.5,
    targetR: 2,
    maxBars: 20,
    useStructureStop: false,
  });
  assert.equal(sim.status, 'ok');
  assert.ok(sim.exit_price > 0);
  assert.ok(Math.abs(sim.r_multiple) < 20);
  assert.notEqual(sim.exit_price, 0);
});

test('edge matrix exposes hierarchical rollups', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      source: 'signal',
      hit_1w: i % 2 === 0,
      r_multiple: i % 2 === 0 ? 1 : -1,
      exit_reason: 'stop',
      vol_regime: 'normal',
      mtf_label: i < 10 ? 'strong' : 'weak',
      archetype: i < 10 ? 'breakout' : 'pullback',
      confidence_band: 'high',
    });
  }
  const matrix = buildEdgeMatrix(rows, { minN: 8, rollupMinN: 5 });
  assert.ok(matrix.rollups);
  assert.ok(matrix.rollups.by_archetype.length >= 2);
  assert.ok(matrix.rollups.by_mtf_label.length >= 2);
});

test('dashboard explains how to run TA when missing', () => {
  const html = buildSevcikReportHtml({ signal_count: 0, signals: [], daily: [], tickers: [] });
  assert.ok(html.includes('sevcik:ta'));
});

