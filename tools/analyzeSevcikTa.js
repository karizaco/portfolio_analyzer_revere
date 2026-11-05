'use strict';

// Technical-analysis evaluation of Sevcik signals & setups.
//
// Builds:
//   - event alignment (claim_date -> next session executable_date)
//   - indicator snapshot / regimes / MTF score
//   - gap + archetype labels (real-gap gate)
//   - R-multiple path simulation (floor/cap + clipped stats)
//   - dual scorecards + claim dedupe
//   - conditional edge matrix + walk-forward policy check
//
// Writes:
//   data/sevcik_ta_features.json
//   data/sevcik_ta_features.csv
//   data/sevcik_ta_summary.json
//   sevcik_ta_features table in state.sqlite
//   refreshes data/sevcik_report.html with a TA section when possible
//
// Usage:
//   node tools/analyzeSevcikTa.js
//   node tools/analyzeSevcikTa.js --limit 40
//   node tools/analyzeSevcikTa.js --json

const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const { evaluateClaimsWithTa } = require('../src/sevcik/taEvaluation');
const { ensureTaFeatureSchema, replaceTaFeatures } = require('../src/sevcik/taFeatureStore');
const { isScorableSetup, shiftIsoDate, toIsoDate } = require('../src/sevcik/outcomeAnalysis');
const { sevcikVideoQuarantine } = require('../src/sevcik/contentFilter');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const INPUT_JSON = path.join(ROOT, 'data', 'sevcik_signals.json');
const OUTPUT_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

const FEATURE_COLUMNS = [
  'source', 'video_id', 'upload_date', 'ticker', 'yahoo_symbol', 'bias', 'claim_kind',
  'claim_date', 'executable_date', 'venue', 'alignment_confidence', 'asof_date',
  'trend_regime', 'vol_regime', 'mtf_label', 'mtf_score', 'archetype', 'confidence_band',
  'gap_talk', 'linguistic_gap_setup', 'market_gap_observed', 'real_gap', 'has_gap', 'gap_pct', 'gap_filled_5d',
  'rsi14', 'macd_hist', 'sma50', 'sma200', 'atr_pct', 'bb_bandwidth', 'volume_z20', 'adx14',
  'entry_price', 'return_1w', 'return_1m', 'aligned_return_1w', 'hit_1w', 'hit_1m',
  'r_multiple', 'r_multiple_clipped', 'mfe_r', 'mae_r', 'exit_reason', 'stop_mode', 'price_status',
];

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  json: argv.includes('--json'),
  ticker: readFlag(argv, '--ticker') || '',
  includeQuarantine: argv.includes('--include-quarantine'),
  signalsOnly: argv.includes('--signals-only'),
  setupsOnly: argv.includes('--setups-only'),
};

async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`No ${INPUT_JSON}. Run npm run sevcik:aggregate first.`);
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
  const videoTitleById = new Map((payload.daily || []).map((row) => [row.video_id, row.title || '']));

  let signals = (payload.signals || []).filter((signal) => {
    const bias = String(signal.bias || '');
    if (bias !== 'bullish' && bias !== 'bearish') return false;
    if (String(signal.claim_kind || 'forward') === 'retrospective') return false;
    if (!options.includeQuarantine) {
      const title = videoTitleById.get(signal.video_id) || signal.title || '';
      if (sevcikVideoQuarantine({ title }).quarantined) return false;
    }
    return true;
  }).map((row) => ({ ...row, source: 'signal' }));

  let setups = (payload.setups || []).filter((setup) => {
    if (!isScorableSetup(setup)) return false;
    if (!options.includeQuarantine) {
      const title = videoTitleById.get(setup.video_id) || setup.title || '';
      if (sevcikVideoQuarantine({ title }).quarantined) return false;
    }
    return true;
  }).map((row) => ({ ...row, source: 'setup' }));

  if (options.signalsOnly) setups = [];
  if (options.setupsOnly) signals = [];
  if (options.ticker) {
    const wanted = options.ticker.toUpperCase();
    signals = signals.filter((s) => String(s.ticker || '').toUpperCase() === wanted);
    setups = setups.filter((s) => String(s.ticker || '').toUpperCase() === wanted);
  }

  let claims = [...signals, ...setups];
  if (options.limit) claims = claims.slice(0, options.limit);

  const dates = claims.map((c) => toIsoDate(c.upload_date)).filter(Boolean).sort();
  const fromDate = dates[0] ? shiftIsoDate(dates[0], -420) : '';
  const toDate = dates.length ? shiftIsoDate(dates[dates.length - 1], 40) : '';
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: fromDate,
    defaultToDate: toDate || new Date().toISOString().slice(0, 10),
    prefetchConcurrency: 4,
  });

  console.log(`[sevcik-ta] claims=${claims.length} signals=${signals.length} setups=${setups.length}`);
  const { summary, rows } = await evaluateClaimsWithTa(claims, provider, {
    asOfDate: new Date().toISOString().slice(0, 10),
  });

  const featuresPath = path.join(OUTPUT_DIR, 'sevcik_ta_features.json');
  const summaryPath = path.join(OUTPUT_DIR, 'sevcik_ta_summary.json');
  fs.writeFileSync(featuresPath, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeCsv(
    path.join(OUTPUT_DIR, 'sevcik_ta_features.csv'),
    FEATURE_COLUMNS,
    rows.map(serializeFeatureRow),
  );

  if (fs.existsSync(DB_PATH)) {
    const db = new DatabaseSync(DB_PATH);
    if (fs.existsSync(SCHEMA_PATH)) {
      try { db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8')); } catch (_) {}
    }
    ensureTaFeatureSchema(db);
    replaceTaFeatures(db, rows, summary.feature_version);
    db.close();
  }

  try {
    const mainPayload = JSON.parse(fs.readFileSync(INPUT_JSON, 'utf8'));
    mainPayload.ta_summary = summary;
    mainPayload.ta_features = rows;
    fs.writeFileSync(INPUT_JSON, JSON.stringify(mainPayload, null, 2), 'utf8');
    const { buildSevcikReportHtml } = require('../src/report/sevcikReport');
    fs.writeFileSync(path.join(OUTPUT_DIR, 'sevcik_report.html'), buildSevcikReportHtml(mainPayload), 'utf8');
  } catch (error) {
    console.error(`[sevcik-ta] dashboard refresh skipped: ${error.message}`);
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    const sc = summary.scorecards || {};
    console.log(`[sevcik-ta] claims=${summary.claim_count} scored_1w=${summary.scored_1w}`
      + ` hit_1w=${summary.hit_rate_1w}`
      + ` median_r=${summary.median_r} avg_r_clip=${summary.avg_r_clipped} avg_r=${summary.avg_r}`
      + ` gap_real=${summary.gap_real_n} gap_ling=${summary.gap_linguistic_n}`
      + ` deduped=${summary.dedupe && summary.dedupe.primary_n}`
      + ` edge_allow=${summary.edge_matrix && summary.edge_matrix.allow_count}`
      + ` walk_folds=${summary.walk_forward && summary.walk_forward.fold_count}`);
    if (sc.signals_only) {
      console.log(`[sevcik-ta] signals hit_1w=${sc.signals_only.hit_rate_1w} median_r=${sc.signals_only.median_r}`
        + ` | setups hit_1w=${sc.setups_only && sc.setups_only.hit_rate_1w} median_r=${sc.setups_only && sc.setups_only.median_r}`
        + ` | primary hit_1w=${sc.deduped_primary && sc.deduped_primary.hit_rate_1w}`);
    }
    console.log('[sevcik-ta] wrote data/sevcik_ta_features.json, data/sevcik_ta_features.csv,'
      + ' data/sevcik_ta_summary.json and refreshed report/sqlite feature store');
  }
}

function serializeFeatureRow(row) {
  return {
    source: row.source || '',
    video_id: row.video_id || '',
    upload_date: row.upload_date || '',
    ticker: row.ticker || '',
    yahoo_symbol: row.yahoo_symbol || '',
    bias: row.bias || '',
    claim_kind: row.claim_kind || '',
    claim_date: row.claim_date || '',
    executable_date: row.executable_date || '',
    venue: row.venue || '',
    alignment_confidence: row.alignment_confidence || '',
    asof_date: row.asof_date || '',
    trend_regime: row.trend_regime || '',
    vol_regime: row.vol_regime || '',
    mtf_label: row.mtf_label || '',
    mtf_score: row.mtf_score == null ? '' : row.mtf_score,
    archetype: row.archetype || '',
    confidence_band: row.confidence_band || '',
    gap_talk: row.gap_talk ? 1 : 0,
    linguistic_gap_setup: row.linguistic_gap_setup === true ? 1 : row.linguistic_gap_setup === false ? 0 : '',
    market_gap_observed: row.market_gap_observed === true ? 1 : row.market_gap_observed === false ? 0 : '',
    real_gap: row.real_gap === true ? 1 : row.real_gap === false ? 0 : '',
    has_gap: row.has_gap === true ? 1 : row.has_gap === false ? 0 : '',
    gap_pct: row.gap_pct == null ? '' : row.gap_pct,
    gap_filled_5d: row.gap_filled_5d === true ? 1 : row.gap_filled_5d === false ? 0 : '',
    rsi14: row.rsi14 == null ? '' : row.rsi14,
    macd_hist: row.macd_hist == null ? '' : row.macd_hist,
    sma50: row.sma50 == null ? '' : row.sma50,
    sma200: row.sma200 == null ? '' : row.sma200,
    atr_pct: row.atr_pct == null ? '' : row.atr_pct,
    bb_bandwidth: row.bb_bandwidth == null ? '' : row.bb_bandwidth,
    volume_z20: row.volume_z20 == null ? '' : row.volume_z20,
    adx14: row.adx14 == null ? '' : row.adx14,
    entry_price: row.entry_price == null ? '' : row.entry_price,
    return_1w: row.return_1w == null ? '' : row.return_1w,
    return_1m: row.return_1m == null ? '' : row.return_1m,
    aligned_return_1w: row.aligned_return_1w == null ? '' : row.aligned_return_1w,
    hit_1w: row.hit_1w === true ? 1 : row.hit_1w === false ? 0 : '',
    hit_1m: row.hit_1m === true ? 1 : row.hit_1m === false ? 0 : '',
    r_multiple: row.r_multiple == null ? '' : row.r_multiple,
    r_multiple_clipped: row.r_multiple_clipped == null ? '' : row.r_multiple_clipped,
    mfe_r: row.mfe_r == null ? '' : row.mfe_r,
    mae_r: row.mae_r == null ? '' : row.mae_r,
    exit_reason: row.exit_reason || '',
    stop_mode: row.stop_mode || '',
    price_status: row.price_status || '',
  };
}

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

main().catch((error) => {
  console.error(`[sevcik-ta] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
