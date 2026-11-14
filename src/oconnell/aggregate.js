'use strict';

/**
 * The O'Connell aggregate: the corpus, its coverage, and what it says.
 *
 * WHAT THIS SOURCE CONTAINS, AND WHY IT IS NOT LIKE THE OTHERS
 *
 * The other sources in this project read a VIDEO. This one reads a
 * paid newsletter, and the difference shows in the data:
 *
 *   - a SETUP is what he SAID he was watching: a ticker, a kind of
 *     setup, a direction where he states one, and a thesis. It may
 *     never have been traded.
 *   - a POSITION is what he HELD: a lot with an entry date, a size, a
 *     stop, a risk, and an R-multiple target. The same ticker is
 *     several lots when it was bought several times.
 *
 * Those are different record types and they are kept apart, the way
 * `docs/source-dashboard-pattern.md` requires: "Keep distinct record
 * types; do not turn every reading into a ticker signal."
 *
 * THE COVERAGE FUNNEL IS THE POINT
 *
 * The corpus is not homogeneous. 302 documents, of which 211 are the
 * trading-day newsletter, 56 the weekend one, and the rest are notes,
 * guides and one-off specials. And a document without a position log is
 * ABSENCE, not zero -- the coverage funnel says "how many documents of
 * this kind were there" against "how many carried a position log", so
 * a missing log is never read as an empty portfolio.
 */

const {
  OCONNELL_DAILY_COLUMNS,
  OCONNELL_POSITION_COLUMNS,
  OCONNELL_SETUP_COLUMNS,
  OCONNELL_TICKER_COLUMNS,
} = require('../config/schema');

/**
 * The setups CSV columns.
 */
const SETUP_COLUMNS = OCONNELL_SETUP_COLUMNS;

/**
 * The positions CSV columns.
 */
const POSITION_COLUMNS = OCONNELL_POSITION_COLUMNS;

/**
 * The daily summary CSV columns.
 */
const DAILY_COLUMNS = OCONNELL_DAILY_COLUMNS;

/**
 * The ticker summary CSV columns.
 */
const TICKER_COLUMNS = OCONNELL_TICKER_COLUMNS;

/**
 * The coverage funnel.
 *
 * Every stage names what it is counting and what it is counting OUT
 * OF, so a reader can tell a missing stage from an empty one.
 *
 * @param {object} counts
 * @returns {Array<object>} the stages
 */
function buildCoverage(counts) {
  return [
    {
      count: counts.documents,
      denominator: null,
      reason: 'every document in the corpus',
      stage: 'Documents catalogued',
      status: 'complete',
    },
    {
      count: counts.tradingDay,
      denominator: counts.documents,
      reason: 'the trading-day newsletter; the rest are weekend, notes and specials',
      stage: 'Trading-day issues',
      status: 'complete',
    },
    {
      count: counts.withPositionLog,
      denominator: counts.tradingDay,
      reason: counts.withPositionLog < counts.tradingDay
        ? 'an issue without a position log carries no positions — that is absence, not an empty portfolio'
        : '',
      stage: 'Issues with a position log',
      status: counts.withPositionLog ? 'complete' : 'not_started',
    },
    {
      count: counts.positions,
      denominator: counts.withPositionLog,
      reason: 'lots, not tickers: one ticker can be several lots',
      stage: 'Positions read',
      status: counts.positions ? 'complete' : 'not_started',
    },
    {
      count: counts.setups,
      denominator: counts.documents,
      reason: 'a setup is what he said he was watching, not what he held',
      stage: 'Setups found',
      status: 'complete',
    },
    {
      count: counts.setupsWithProse,
      denominator: counts.setups,
      reason: counts.setupsWithProse < counts.setups
        ? 'the rest have the heading but no readable prose — the heading is the claim, the prose is the evidence'
        : '',
      stage: 'Setups with readable prose',
      status: counts.setups ? 'partial' : 'not_started',
    },
    {
      count: counts.outcomesScored,
      denominator: counts.setups,
      reason: counts.outcomesScored ? '' : 'no outcome has been scored yet',
      stage: 'Setups scored against prices',
      status: counts.outcomesScored ? 'complete' : 'not_started',
    },
  ];
}

/**
 * The daily summary: one row per document.
 *
 * @param {object[]} issues
 * @param {object[]} setups
 * @param {object[]} positions
 * @param {object[]} snapshots
 * @returns {object[]}
 */
function buildDaily(issues, setups, positions, snapshots) {
  const snapshotByDoc = new Map(snapshots.map((snapshot) => [snapshot.doc_id, snapshot]));
  return issues.map((issue) => {
    const daySetups = setups.filter((setup) => setup.doc_id === issue.doc_id);
    const dayPositions = positions.filter((position) => position.doc_id === issue.doc_id);
    const snapshot = snapshotByDoc.get(issue.doc_id) || {};
    const gains = dayPositions
      .map((position) => position.gain_loss_pct)
      .filter((value) => typeof value === 'number');
    return {
      cash_pct: snapshot.cash_pct ?? null,
      distinct_tickers: new Set(dayPositions.map((position) => position.ticker)).size,
      equity_positions: dayPositions.filter((position) => position.instrument === 'equity').length,
      invested_pct: snapshot.invested_pct ?? null,
      option_positions: dayPositions.filter((position) => position.instrument === 'option').length,
      setups: daySetups.length,
      source_date: issue.source_date,
      trend_model: snapshot.trend_model ?? null,
      win_rate_options_pct: snapshot.win_rate_options_pct ?? null,
      win_rate_stock_pct: snapshot.win_rate_stock_pct ?? null,
      average_gain_loss_pct: gains.length
        ? gains.reduce((sum, value) => sum + value, 0) / gains.length
        : null,
    };
  });
}

/**
 * The ticker summary: one row per ticker.
 *
 * @param {object[]} issues
 * @param {object[]} setups
 * @param {object[]} positions
 * @returns {object[]}
 */
function buildTickers(issues, setups, positions) {
  const dateByDoc = new Map(issues.map((issue) => [issue.doc_id, issue.source_date]));
  const tickers = new Set([
    ...setups.map((setup) => setup.ticker),
    ...positions.map((position) => position.ticker),
  ]);

  const rows = [];
  for (const ticker of tickers) {
    const tickerSetups = setups.filter((setup) => setup.ticker === ticker);
    const tickerPositions = positions.filter((position) => position.ticker === ticker);
    const dates = [
      ...tickerSetups.map((setup) => dateByDoc.get(setup.doc_id)),
      ...tickerPositions.map((position) => dateByDoc.get(position.doc_id)),
    ].filter(Boolean).sort();
    const gains = tickerPositions
      .map((position) => position.gain_loss_pct)
      .filter((value) => typeof value === 'number');
    const risks = tickerPositions
      .map((position) => position.risk_pct)
      .filter((value) => typeof value === 'number');
    rows.push({
      average_gain_loss_pct: gains.length
        ? gains.reduce((sum, value) => sum + value, 0) / gains.length
        : null,
      average_risk_pct: risks.length
        ? risks.reduce((sum, value) => sum + value, 0) / risks.length
        : null,
      equity_lots: tickerPositions.filter((position) => position.instrument === 'equity').length,
      first_seen: dates.length ? dates[0] : '',
      last_seen: dates.length ? dates[dates.length - 1] : '',
      long_setups: tickerSetups.filter((setup) => setup.direction === 'long').length,
      option_lots: tickerPositions.filter((position) => position.instrument === 'option').length,
      position_rows: tickerPositions.length,
      setups: tickerSetups.length,
      short_setups: tickerSetups.filter((setup) => setup.direction === 'short').length,
      ticker,
    });
  }
  rows.sort((a, b) => b.setups - a.setups || b.position_rows - a.position_rows
    || a.ticker.localeCompare(b.ticker));
  return rows;
}

/**
 * Whether a setup became a position.
 *
 * This is the question only THIS source can answer, and it is the
 * interesting one: a setup is what he said he was watching, and a
 * position is what he held. The distance between the two is the whole
 * point of reading both.
 *
 * A setup counts as CONVERTED when the ticker he named appears in a
 * position log within the horizon. The horizon is 30 calendar days,
 * which is longer than the setup usually takes to become a trade and
 * short enough that a name he did not act on for a quarter is not
 * counted as a conversion.
 *
 * @param {object[]} setups
 * @param {object[]} positions
 * @param {object[]} issues
 * @param {number} [horizonDays=30]
 * @returns {{converted: number, eligible: number, rate: number|null, rows: object[]}}
 */
function buildConversion(setups, positions, issues, horizonDays = 30) {
  const dateByDoc = new Map(issues.map((issue) => [issue.doc_id, issue.source_date]));
  const positionsByTicker = new Map();
  for (const position of positions) {
    const list = positionsByTicker.get(position.ticker) || [];
    list.push(dateByDoc.get(position.doc_id) || '');
    positionsByTicker.set(position.ticker, list);
  }

  const rows = [];
  for (const setup of setups) {
    const sourceDate = setup.source_date || dateByDoc.get(setup.doc_id) || '';
    const held = (positionsByTicker.get(setup.ticker) || [])
      .filter((entryDate) => entryDate && entryDate >= sourceDate)
      .sort();
    const first = held[0] || '';
    const within = first
      ? daysBetween(sourceDate, first) <= horizonDays
      : false;
    rows.push({
      converted: within,
      days_to_position: first ? daysBetween(sourceDate, first) : null,
      first_position_date: first,
      setup_kind: setup.setup_kind || '',
      setup_label: setup.setup_label || '',
      source_date: sourceDate,
      ticker: setup.ticker,
    });
  }

  const eligible = rows.length;
  const converted = rows.filter((row) => row.converted).length;
  return {
    converted,
    eligible,
    horizon_days: horizonDays,
    rate: eligible ? converted / eligible : null,
    rows,
  };
}

/**
 * The calendar days between two YYYYMMDD dates.
 *
 * @param {string} from
 * @param {string} to
 * @returns {number|null}
 */
function daysBetween(from, to) {
  const start = Date.parse(`${String(from).slice(0, 4)}-${String(from).slice(4, 6)}-${String(from).slice(6, 8)}T00:00:00Z`);
  const end = Date.parse(`${String(to).slice(0, 4)}-${String(to).slice(4, 6)}-${String(to).slice(6, 8)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

/**
 * The whole payload.
 *
 * @param {object} db
 * @param {object} [options]
 * @returns {object} the payload the dashboard renders
 */
function buildOconnellPayload(db, options = {}) {
  const issues = db.prepare(`
    SELECT doc_id, source_date, publish_date, publish_time, title, series, kind,
           access, page_count, source_url, positions_path, positions_checksum
    FROM oconnell_issues
    ORDER BY source_date ASC
  `).all();
  const setups = db.prepare(`
    SELECT doc_id, ticker, company_name, setup_label, setup_kind, direction, thesis,
           evidence_text, evidence_page, evidence_quality, section, horizon_text,
           claim_kind, parser_version
    FROM oconnell_setups
    ORDER BY doc_id ASC
  `).all();
  const positions = db.prepare(`
    SELECT doc_id, instrument, ticker, contract, setup_label, entry_date,
           trade_length_days, cost_basis, price, gain_loss_pct, size_stars,
           stop_price, risk_pct, r2_price, sma20, sma50, beta, delta,
           change_pct, underlying_change_pct, option_change_pct, exits, exit_price
    FROM oconnell_positions
    ORDER BY doc_id ASC
  `).all();
  const snapshots = db.prepare(`
    SELECT doc_id, equity_count, option_count, cash_pct, invested_pct, trend_model,
           max_loss_stock_pct, max_loss_options_pct, win_rate_stock_pct,
           win_rate_options_pct
    FROM oconnell_snapshots
  `).all();

  const dateByDoc = new Map(issues.map((issue) => [issue.doc_id, issue.source_date]));
  const tradingDay = issues.filter((issue) => issue.kind === 'market_analysis_watchlist').length;
  const withPositionLog = issues.filter((issue) => issue.positions_path).length;

  const counts = {
    documents: issues.length,
    outcomesScored: 0,
    positions: positions.length,
    setups: setups.length,
    setupsWithProse: setups.filter((setup) => setup.evidence_quality === 'prose').length,
    tradingDay,
    withPositionLog,
  };

  if (options.outcomes && options.outcomes.rows) {
    counts.outcomesScored = options.outcomes.rows.length;
  }

  const setupsWithDate = setups.map((setup) => ({
    ...setup,
    source_date: dateByDoc.get(setup.doc_id) || '',
  }));
  const positionsWithDate = positions.map((position) => ({
    ...position,
    source_date: dateByDoc.get(position.doc_id) || '',
  }));

  return {
    coverage: buildCoverage(counts),
    counts,
    conversion: buildConversion(setupsWithDate, positionsWithDate, issues),
    daily: buildDaily(issues, setupsWithDate, positionsWithDate, snapshots),
    generated_at: new Date().toISOString(),
    items: issues.map((issue) => ({
      access: issue.access,
      contentType: issue.kind,
      eventDate: issue.source_date,
      id: issue.doc_id,
      publishedAt: issue.publish_date ? `${issue.publish_date} ${issue.publish_time}`.trim() : '',
      title: issue.title,
      url: issue.source_url,
    })),
    outcomes: options.outcomes ? options.outcomes.rows : [],
    outcome_summary: options.outcomes ? options.outcomes.summary : null,
    positions: positionsWithDate,
    setups: setupsWithDate,
    snapshots,
    source: {
      accent: '#2f6b5f',
      capabilities: ['setups', 'positions', 'options', 'thesis prose', 'daily snapshot'],
      description:
        "Andrew O'Connell's paid newsletter, read as documents. What he said he was "
        + 'watching (setups, with his thesis) and what he actually held (lots, with '
        + 'their entry dates, sizes, stops and R-multiple targets).',
      id: 'oconnell',
      label: "O'Connell (Pristine Capital)",
      updatedAt: issues.length ? issues[issues.length - 1].source_date : 'unknown',
    },
    tickers: buildTickers(issues, setupsWithDate, positionsWithDate),
  };
}

module.exports = {
  DAILY_COLUMNS,
  POSITION_COLUMNS,
  SETUP_COLUMNS,
  TICKER_COLUMNS,
  buildCoverage,
  buildDaily,
  buildOconnellPayload,
  buildTickers,
};
