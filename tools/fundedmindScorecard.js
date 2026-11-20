'use strict';

// FundedMind quality scorecard from derived.fundedmind_setups and trade_signals.
//
// Usage:
//   node tools/fundedmindScorecard.js
//   node tools/fundedmindScorecard.js --parser fundedmind-10 --days 180 --json

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUT_DIR = path.join(ROOT, 'data');

const argv = process.argv.slice(2);
function readFlag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return '';
  return argv[i + 1] || '';
}

const options = {
  parser: readFlag('--parser') || 'fundedmind-10',
  days: Number(readFlag('--days')) || 0,
  json: argv.includes('--json'),
};

function ymdToIso(ymd) {
  const s = String(ymd || '');
  if (!/^\d{8}$/.test(s)) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function shiftYmd(ymd, deltaDays) {
  const iso = ymdToIso(ymd);
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function pct(n, d) {
  if (!d) return null;
  return Number((100 * n / d).toFixed(1));
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  attachDerived(db);

  const maxRow = db.prepare(
    "SELECT max(session_date) max_d FROM fundedmind_setups WHERE parser_version = ?",
  ).get(options.parser);
  const maxSessionDate = maxRow && maxRow.max_d ? String(maxRow.max_d) : '';
  const minSessionDate = options.days && maxSessionDate
    ? shiftYmd(maxSessionDate, -(options.days - 1))
    : '';

  const where = ["parser_version = ?"];
  const params = [options.parser];
  if (minSessionDate) {
    where.push("session_date >= ?");
    params.push(minSessionDate);
  }
  const whereSql = where.join(' AND ');

  const totals = db.prepare(
    `SELECT
      count(*) setups,
      count(DISTINCT video_id) videos,
      count(DISTINCT session_date) days,
      sum(CASE WHEN score >= 2 THEN 1 ELSE 0 END) actionable,
      sum(CASE WHEN recap_verdict != '' THEN 1 ELSE 0 END) recap_applied,
      sum(CASE WHEN side != '' THEN 1 ELSE 0 END) side_tagged,
      sum(CASE WHEN ticker_from != '' THEN 1 ELSE 0 END) ticker_from_tagged,
      sum(CASE WHEN stop_price IS NOT NULL THEN 1 ELSE 0 END) has_stop,
      sum(CASE WHEN entry_price IS NOT NULL THEN 1 ELSE 0 END) has_entry,
      sum(CASE WHEN status IN ('closed','stopped') THEN 1 ELSE 0 END) closed_or_stopped
    FROM fundedmind_setups
    WHERE ${whereSql}`,
  ).get(...params);

  const statusRows = db.prepare(
    `SELECT status, count(*) c
      FROM fundedmind_setups
      WHERE ${whereSql}
      GROUP BY status
      ORDER BY c DESC`,
  ).all(...params);

  const recapRows = db.prepare(
    `SELECT CASE WHEN recap_verdict = '' THEN '(none)' ELSE recap_verdict END recap_verdict, count(*) c
      FROM fundedmind_setups
      WHERE ${whereSql}
      GROUP BY 1
      ORDER BY c DESC`,
  ).all(...params);

  const hostRows = db.prepare(
    `SELECT host, count(*) setups,
         sum(CASE WHEN score >= 2 THEN 1 ELSE 0 END) actionable,
         sum(CASE WHEN recap_verdict != '' THEN 1 ELSE 0 END) recap_applied
      FROM fundedmind_setups
      WHERE ${whereSql}
      GROUP BY host
      ORDER BY setups DESC`,
  ).all(...params).map((r) => ({
    ...r,
    actionable_pct: pct(r.actionable, r.setups),
    recap_applied_pct: pct(r.recap_applied, r.setups),
  }));

  const tickerRows = db.prepare(
    `SELECT ticker, count(*) setups,
         sum(CASE WHEN score >= 2 THEN 1 ELSE 0 END) actionable,
         sum(CASE WHEN recap_verdict != '' THEN 1 ELSE 0 END) recap_applied,
         sum(CASE WHEN status IN ('closed','stopped') THEN 1 ELSE 0 END) closed_or_stopped
      FROM fundedmind_setups
      WHERE ${whereSql}
      GROUP BY ticker
      ORDER BY setups DESC`,
  ).all(...params).map((r) => ({
    ...r,
    actionable_pct: pct(r.actionable, r.setups),
    recap_applied_pct: pct(r.recap_applied, r.setups),
    closed_or_stopped_pct: pct(r.closed_or_stopped, r.setups),
  }));

  const signalWhere = ["s.parser_version = ?", "v.channel = 'fundedmind'"];
  const signalParams = [options.parser];
  if (minSessionDate) {
    signalWhere.push("(v.upload_date >= ? OR v.upload_date = '')");
    signalParams.push(minSessionDate);
  }
  const signalWhereSql = signalWhere.join(' AND ');

  const signalTotals = db.prepare(
    `SELECT
      count(*) signals,
      count(DISTINCT s.video_id) signal_videos,
      sum(CASE WHEN s.claim_kind = 'forward' THEN 1 ELSE 0 END) forward_signals,
      sum(CASE WHEN s.claim_kind = 'plan' THEN 1 ELSE 0 END) plan_signals,
      sum(CASE WHEN s.claim_kind = 'retrospective' THEN 1 ELSE 0 END) retrospective_signals
    FROM trade_signals s
    JOIN videos v ON v.video_id = s.video_id
    WHERE ${signalWhereSql}`,
  ).get(...signalParams);

  const signalKinds = db.prepare(
    `SELECT s.claim_kind, count(*) c
      FROM trade_signals s
      JOIN videos v ON v.video_id = s.video_id
      WHERE ${signalWhereSql}
      GROUP BY s.claim_kind
      ORDER BY c DESC`,
  ).all(...signalParams);

  const recapVideos = db.prepare(
    `SELECT count(DISTINCT s.video_id) c
      FROM trade_signals s
      JOIN videos v ON v.video_id = s.video_id
      WHERE ${signalWhereSql} AND s.claim_kind = 'retrospective'`,
  ).get(...signalParams);

  const coverage = {
    parser_version: options.parser,
    session_window: {
      min_session_date: minSessionDate || null,
      max_session_date: maxSessionDate || null,
      days_requested: options.days || null,
    },
    setups: {
      total: totals.setups || 0,
      videos: totals.videos || 0,
      days: totals.days || 0,
      actionable: totals.actionable || 0,
      actionable_pct: pct(totals.actionable || 0, totals.setups || 0),
      recap_applied: totals.recap_applied || 0,
      recap_applied_pct: pct(totals.recap_applied || 0, totals.setups || 0),
      side_tagged_pct: pct(totals.side_tagged || 0, totals.setups || 0),
      ticker_from_tagged_pct: pct(totals.ticker_from_tagged || 0, totals.setups || 0),
      has_stop_pct: pct(totals.has_stop || 0, totals.setups || 0),
      has_entry_pct: pct(totals.has_entry || 0, totals.setups || 0),
      closed_or_stopped_pct: pct(totals.closed_or_stopped || 0, totals.setups || 0),
    },
    signals: {
      total: signalTotals.signals || 0,
      videos: signalTotals.signal_videos || 0,
      by_claim_kind: signalKinds,
      retrospective_videos: (recapVideos && recapVideos.c) || 0,
    },
    by_status: statusRows,
    by_recap_verdict: recapRows,
    hosts: hostRows,
    tickers: tickerRows,
    generated_at: new Date().toISOString(),
  };

  db.close();

  const jsonPath = path.join(OUT_DIR, 'fundedmind_quality_scorecard.json');
  fs.writeFileSync(jsonPath, JSON.stringify(coverage, null, 2));

  await Promise.all([
    writeCsv(
      path.join(OUT_DIR, 'fundedmind_quality_hosts.csv'),
      ['host', 'setups', 'actionable', 'actionable_pct', 'recap_applied', 'recap_applied_pct'],
      hostRows,
    ),
    writeCsv(
      path.join(OUT_DIR, 'fundedmind_quality_tickers.csv'),
      ['ticker', 'setups', 'actionable', 'actionable_pct', 'recap_applied', 'recap_applied_pct', 'closed_or_stopped', 'closed_or_stopped_pct'],
      tickerRows,
    ),
  ]);

  if (options.json) {
    console.log(JSON.stringify(coverage, null, 2));
  } else {
    console.log(
      '[fundedmind-scorecard]',
      `setups=${coverage.setups.total}`,
      `actionable=${coverage.setups.actionable}`,
      `actionable_pct=${coverage.setups.actionable_pct}`,
      `recap_applied_pct=${coverage.setups.recap_applied_pct}`,
      `signals=${coverage.signals.total}`,
      `retro_videos=${coverage.signals.retrospective_videos}`,
    );
    console.log(`[fundedmind-scorecard] wrote ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
