'use strict';

// SQLite feature store for Sevcik TA evaluation rows.

const FEATURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sevcik_ta_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_row_id INTEGER,
  video_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  yahoo_symbol TEXT NOT NULL DEFAULT '',
  bias TEXT NOT NULL DEFAULT '',
  claim_kind TEXT NOT NULL DEFAULT '',
  claim_date TEXT NOT NULL DEFAULT '',
  executable_date TEXT NOT NULL DEFAULT '',
  alignment_confidence TEXT NOT NULL DEFAULT '',
  alignment_rule TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  asof_date TEXT NOT NULL DEFAULT '',
  close REAL,
  rsi14 REAL,
  macd REAL,
  macd_signal REAL,
  macd_hist REAL,
  sma20 REAL,
  sma50 REAL,
  sma200 REAL,
  ema21 REAL,
  atr14 REAL,
  atr_pct REAL,
  bb_mid REAL,
  bb_upper REAL,
  bb_lower REAL,
  bb_bandwidth REAL,
  volume_z20 REAL,
  adx14 REAL,
  bar_count INTEGER NOT NULL DEFAULT 0,
  trend_regime TEXT NOT NULL DEFAULT '',
  vol_regime TEXT NOT NULL DEFAULT '',
  mtf_score REAL,
  mtf_label TEXT NOT NULL DEFAULT '',
  archetype TEXT NOT NULL DEFAULT '',
  gap_talk INTEGER NOT NULL DEFAULT 0,
  linguistic_gap_setup INTEGER,
  market_gap_observed INTEGER,
  real_gap INTEGER,
  has_gap INTEGER,
  gap_pct REAL,
  gap_direction TEXT NOT NULL DEFAULT '',
  gap_filled_5d INTEGER,
  r_multiple REAL,
  r_multiple_clipped REAL,
  mfe_r REAL,
  mae_r REAL,
  exit_reason TEXT NOT NULL DEFAULT '',
  stop_mode TEXT NOT NULL DEFAULT '',
  confidence_band TEXT NOT NULL DEFAULT '',
  hit_1w INTEGER,
  hit_1m INTEGER,
  return_1w REAL,
  return_1m REAL,
  aligned_return_1w REAL,
  aligned_return_1m REAL,
  feature_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, video_id, ticker, claim_date, executable_date, bias, source_row_id)
);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_ticker ON sevcik_ta_features(ticker);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_exec ON sevcik_ta_features(executable_date);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_arch ON sevcik_ta_features(archetype);
CREATE INDEX IF NOT EXISTS idx_sevcik_ta_features_trend ON sevcik_ta_features(trend_regime);
`;

const ALTER_COLUMNS = [
  ['venue', "TEXT NOT NULL DEFAULT ''"],
  ['linguistic_gap_setup', 'INTEGER'],
  ['market_gap_observed', 'INTEGER'],
  ['real_gap', 'INTEGER'],
  ['r_multiple_clipped', 'REAL'],
  ['stop_mode', "TEXT NOT NULL DEFAULT ''"],
  ['confidence_band', "TEXT NOT NULL DEFAULT ''"],
];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function ensureTaFeatureSchema(db) {
  db.exec(FEATURE_TABLE_SQL);
  for (const [name, type] of ALTER_COLUMNS) {
    try {
      db.exec(`ALTER TABLE sevcik_ta_features ADD COLUMN ${name} ${type}`);
    } catch (_) {
      // column already exists
    }
  }
}

/**
 * Replace all feature rows for a run payload.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<object>} rows
 * @param {string} featureVersion
 */
function replaceTaFeatures(db, rows, featureVersion) {
  ensureTaFeatureSchema(db);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sevcik_ta_features').run();
    const insert = db.prepare(
      `INSERT INTO sevcik_ta_features (
        source, source_row_id, video_id, ticker, yahoo_symbol, bias, claim_kind,
        claim_date, executable_date, alignment_confidence, alignment_rule, venue, asof_date,
        close, rsi14, macd, macd_signal, macd_hist, sma20, sma50, sma200, ema21,
        atr14, atr_pct, bb_mid, bb_upper, bb_lower, bb_bandwidth, volume_z20, adx14,
        bar_count, trend_regime, vol_regime, mtf_score, mtf_label, archetype,
        gap_talk, linguistic_gap_setup, market_gap_observed, real_gap, has_gap, gap_pct, gap_direction, gap_filled_5d,
        r_multiple, r_multiple_clipped, mfe_r, mae_r, exit_reason, stop_mode, confidence_band,
        hit_1w, hit_1m, return_1w, return_1m, aligned_return_1w, aligned_return_1m,
        feature_version
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,
        ?,?,?,?,?,?,
        ?
      )`,
    );
    for (const row of rows) {
      insert.run(
        row.source || '',
        row.source_row_id == null ? null : Number(row.source_row_id),
        row.video_id || '',
        row.ticker || '',
        row.yahoo_symbol || '',
        row.bias || '',
        row.claim_kind || '',
        row.claim_date || '',
        row.executable_date || '',
        row.alignment_confidence || '',
        row.alignment_rule || '',
        row.venue || '',
        row.asof_date || '',
        numOrNull(row.close),
        numOrNull(row.rsi14),
        numOrNull(row.macd),
        numOrNull(row.macd_signal),
        numOrNull(row.macd_hist),
        numOrNull(row.sma20),
        numOrNull(row.sma50),
        numOrNull(row.sma200),
        numOrNull(row.ema21),
        numOrNull(row.atr14),
        numOrNull(row.atr_pct),
        numOrNull(row.bb_mid),
        numOrNull(row.bb_upper),
        numOrNull(row.bb_lower),
        numOrNull(row.bb_bandwidth),
        numOrNull(row.volume_z20),
        numOrNull(row.adx14),
        Number(row.bar_count) || 0,
        row.trend_regime || '',
        row.vol_regime || '',
        numOrNull(row.mtf_score),
        row.mtf_label || '',
        row.archetype || '',
        row.gap_talk ? 1 : 0,
        boolToInt(row.linguistic_gap_setup),
        boolToInt(row.market_gap_observed),
        boolToInt(row.real_gap),
        boolToInt(row.has_gap),
        numOrNull(row.gap_pct),
        row.gap_direction || '',
        boolToInt(row.gap_filled_5d),
        numOrNull(row.r_multiple),
        numOrNull(row.r_multiple_clipped),
        numOrNull(row.mfe_r),
        numOrNull(row.mae_r),
        row.exit_reason || '',
        row.stop_mode || '',
        row.confidence_band || '',
        boolToInt(row.hit_1w),
        boolToInt(row.hit_1m),
        numOrNull(row.return_1w),
        numOrNull(row.return_1m),
        numOrNull(row.aligned_return_1w),
        numOrNull(row.aligned_return_1m),
        featureVersion || '',
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolToInt(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

module.exports = {
  FEATURE_TABLE_SQL,
  ensureTaFeatureSchema,
  replaceTaFeatures,
};
