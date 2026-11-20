'use strict';

// Score FundedMind day-level setups against subsequent market prices.
//
// Usage:
//   node tools/analyzeFundedmindOutcomes.js
//   node tools/analyzeFundedmindOutcomes.js --parser fundedmind-10 --days 180 --json
//   node tools/analyzeFundedmindOutcomes.js --ticker XAUUSD

const fs = require('node:fs');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const { fundedmindPriceSymbolFor } = require('../src/fundedmind/priceSymbols');
const {
  buildSpyBaseline,
  scoreSignalOutcome,
  shiftIsoDate,
  summarizeOutcomes,
  toIsoDate,
} = require('../src/sevcik/outcomeAnalysis');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

const argv = process.argv.slice(2);
function readFlag(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return '';
  return argv[i + 1] || '';
}

const options = {
  parser: readFlag('--parser') || 'fundedmind-10',
  days: Number(readFlag('--days')) || 0,
  ticker: (readFlag('--ticker') || '').toUpperCase(),
  host: readFlag('--host') || '',
  json: argv.includes('--json'),
};

const OUTCOME_COLUMNS = [
  'video_id', 'session_date', 'event_date', 'host', 'kind', 'ticker', 'yahoo_symbol',
  'side', 'bias', 'status', 'score', 'recap_verdict',
  'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];

function finitePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ymdToIso(ymd) {
  const s = String(ymd || '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

function shiftYmd(ymd, deltaDays) {
  const iso = ymdToIso(ymd);
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function sideToBias(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'long') return 'bullish';
  if (s === 'short') return 'bearish';
  return '';
}

function scoreLabel(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '(none)';
  if (n >= 4) return '4+';
  if (n >= 3) return '3';
  if (n >= 2) return '2';
  if (n >= 1) return '1';
  return '0';
}

function pct(n, d) {
  if (!d) return null;
  return Number((100 * n / d).toFixed(1));
}

function boolCell(v) {
  return v === null ? '' : (v ? 1 : 0);
}

function serializeOutcome(row) {
  return {
    ...row,
    score: row.score == null ? '' : row.score,
    entry_price: row.entry_price == null ? '' : row.entry_price,
    price_1w: row.price_1w == null ? '' : row.price_1w,
    price_1m: row.price_1m == null ? '' : row.price_1m,
    return_1w: row.return_1w == null ? '' : row.return_1w,
    return_1m: row.return_1m == null ? '' : row.return_1m,
    aligned_return_1w: row.aligned_return_1w == null ? '' : row.aligned_return_1w,
    aligned_return_1m: row.aligned_return_1m == null ? '' : row.aligned_return_1m,
    hit_1w: boolCell(row.hit_1w),
    hit_1m: boolCell(row.hit_1m),
  };
}

function summarizeGroup(outcomes, keyFn, baseline, sortFn) {
  const map = new Map();
  for (const row of outcomes) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  const rows = [];
  for (const [key, list] of map.entries()) {
    const summary = summarizeOutcomes(list, { baseline });
    rows.push({
      key,
      setups: list.length,
      scored_1w: summary.scored_1w,
      hit_rate_1w: summary.hit_rate_1w,
      avg_aligned_return_1w: summary.avg_aligned_return_1w,
      scored_1m: summary.scored_1m,
      hit_rate_1m: summary.hit_rate_1m,
      avg_aligned_return_1m: summary.avg_aligned_return_1m,
    });
  }
  return rows.sort(sortFn || ((a, b) => (b.setups - a.setups)));
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
  if (options.ticker) {
    where.push("ticker = ?");
    params.push(options.ticker);
  }
  if (options.host) {
    where.push("host = ?");
    params.push(options.host);
  }

  const rows = db.prepare(
    `SELECT video_id, session_date, host, kind, ticker, side, status, score, recap_verdict,
            entry_price, stop_price, evidence_json
      FROM fundedmind_setups
      WHERE ${where.join(' AND ')}
      ORDER BY session_date DESC, video_id`,
  ).all(...params);

  db.close();

  const directional = rows
    .map((row) => {
      const eventDate = toIsoDate(row.session_date);
      const bias = sideToBias(row.side);
      if (!eventDate || !bias) return null;
      let evidence = '';
      try {
        const arr = JSON.parse(row.evidence_json || '[]');
        if (Array.isArray(arr)) evidence = String(arr[0] || '');
      } catch {
        evidence = '';
      }
      return {
        source: 'fundedmind_setup',
        video_id: row.video_id,
        session_date: row.session_date,
        upload_date: row.session_date,
        event_date: eventDate,
        host: row.host || '',
        kind: row.kind || '',
        ticker: row.ticker,
        side: row.side || '',
        bias,
        status: row.status || '',
        score: Number(row.score || 0),
        recap_verdict: row.recap_verdict || '',
        evidence_text: evidence,
        entry_price_stated: finitePrice(row.entry_price),
      };
    })
    .filter(Boolean);

  if (!directional.length) {
    const empty = {
      parser_version: options.parser,
      filters: {
        days: options.days || null,
        min_session_date: minSessionDate || null,
        ticker: options.ticker || null,
        host: options.host || null,
      },
      setup_count_total: rows.length,
      setup_count_directional: 0,
      note: 'No directional fundedmind_setups in the selected slice.',
      generated_at: new Date().toISOString(),
    };
    const out = path.join(OUTPUT_DIR, 'fundedmind_outcome_summary.json');
    fs.writeFileSync(out, JSON.stringify(empty, null, 2));
    console.log('[fundedmind-outcomes] no directional setups in scope');
    if (options.json) console.log(JSON.stringify(empty, null, 2));
    return;
  }

  const dates = directional.map((row) => row.event_date).sort();
  const fromDate = dates[0] ? shiftIsoDate(dates[0], -5) : '';
  const toDate = dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : '';
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: fromDate,
    defaultToDate: toDate || new Date().toISOString().slice(0, 10),
    prefetchConcurrency: 4,
  });

  const symbols = [...new Set([
    ...directional.map((row) => fundedmindPriceSymbolFor(row.ticker)),
    'SPY',
  ].filter(Boolean))];

  console.log(
    '[fundedmind-outcomes]',
    `setups_total=${rows.length}`,
    `directional=${directional.length}`,
    `symbols=${symbols.length}`,
  );

  await provider.prefetchTickers(symbols);

  const asOfDate = new Date().toISOString().slice(0, 10);
  const outcomes = [];
  for (const claim of directional) {
    const symbol = fundedmindPriceSymbolFor(claim.ticker);
    const weekDate = shiftIsoDate(claim.event_date, HORIZON_1W_DAYS);
    const monthDate = shiftIsoDate(claim.event_date, HORIZON_1M_DAYS);

    const entry = await provider.getPricePoint(symbol, claim.event_date);
    const week = weekDate <= asOfDate
      ? await provider.getPricePoint(symbol, weekDate)
      : { price: '', priceStatus: 'horizon_not_elapsed' };
    const month = monthDate <= asOfDate
      ? await provider.getPricePoint(symbol, monthDate)
      : { price: '', priceStatus: 'horizon_not_elapsed' };

    const status = [entry.priceStatus, week.priceStatus, month.priceStatus]
      .filter((v) => v && !String(v).startsWith('ok'))
      .join('|') || 'ok';

    const scored = scoreSignalOutcome(claim, {
      entry: finitePrice(entry.price),
      week: finitePrice(week.price),
      month: finitePrice(month.price),
      meta: { status },
    });

    outcomes.push({
      ...scored,
      session_date: claim.session_date,
      host: claim.host,
      kind: claim.kind,
      side: claim.side,
      status: claim.status,
      score: claim.score,
      recap_verdict: claim.recap_verdict,
    });
  }

  const baseline = await buildSpyBaseline(
    outcomes.filter((row) => row.event_date),
    provider,
    { weekDays: HORIZON_1W_DAYS, monthDays: HORIZON_1M_DAYS, asOfDate },
  );

  const summary = summarizeOutcomes(outcomes, { baseline });
  const byHost = summarizeGroup(outcomes, (r) => r.host || '(unknown)', baseline);
  const byTicker = summarizeGroup(outcomes, (r) => r.ticker, baseline);
  const byScore = summarizeGroup(outcomes, (r) => scoreLabel(r.score), baseline, (a, b) => {
    const rank = { '4+': 5, '3': 4, '2': 3, '1': 2, '0': 1, '(none)': 0 };
    return (rank[b.key] || 0) - (rank[a.key] || 0);
  });
  const byRecap = summarizeGroup(outcomes, (r) => r.recap_verdict || '(none)', baseline);

  const payload = {
    parser_version: options.parser,
    filters: {
      days: options.days || null,
      min_session_date: minSessionDate || null,
      max_session_date: maxSessionDate || null,
      ticker: options.ticker || null,
      host: options.host || null,
    },
    setup_count_total: rows.length,
    setup_count_directional: directional.length,
    baseline,
    overall: summary,
    by_host: byHost,
    by_ticker: byTicker,
    by_score: byScore,
    by_recap_verdict: byRecap,
    generated_at: new Date().toISOString(),
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
  };

  await writeCsv(
    path.join(OUTPUT_DIR, 'fundedmind_outcomes.csv'),
    OUTCOME_COLUMNS,
    outcomes.map(serializeOutcome),
  );

  await writeCsv(
    path.join(OUTPUT_DIR, 'fundedmind_outcome_host_summary.csv'),
    ['key', 'setups', 'scored_1w', 'hit_rate_1w', 'avg_aligned_return_1w', 'scored_1m', 'hit_rate_1m', 'avg_aligned_return_1m'],
    byHost,
  );

  await writeCsv(
    path.join(OUTPUT_DIR, 'fundedmind_outcome_ticker_summary.csv'),
    ['key', 'setups', 'scored_1w', 'hit_rate_1w', 'avg_aligned_return_1w', 'scored_1m', 'hit_rate_1m', 'avg_aligned_return_1m'],
    byTicker,
  );

  const summaryPath = path.join(OUTPUT_DIR, 'fundedmind_outcome_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2));

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(
      '[fundedmind-outcomes]',
      `directional=${directional.length}`,
      `scored_1w=${summary.scored_1w}`,
      `hit_1w=${summary.hit_rate_1w}`,
      `scored_1m=${summary.scored_1m}`,
      `hit_1m=${summary.hit_rate_1m}`,
      `edge_1w=${summary.edge_vs_baseline_1w}`,
      `edge_1m=${summary.edge_vs_baseline_1m}`,
    );
    console.log(
      '[fundedmind-outcomes] wrote',
      'data/fundedmind_outcomes.csv,',
      'data/fundedmind_outcome_host_summary.csv,',
      'data/fundedmind_outcome_ticker_summary.csv,',
      'data/fundedmind_outcome_summary.json',
    );
  }
}

main().catch((error) => {
  console.error('[fundedmind-outcomes] failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
