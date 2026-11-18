'use strict';

/**
 * The Komar dashboard.
 *
 * WHAT IT SHOWS
 *
 * The source's own question -- the CONVERSION FUNNEL:
 *
 *   setups  ->  watchlist  ->  positions  ->  closed trades
 *
 * which only Komar can answer, because it is the only source in the
 * project with all four ends. What is read today is the first and the
 * last: the SETUPS (what he said he was watching, with what the
 * prices did) and the TRADE LOG (what he did). The middle -- the
 * watchlist and the positions, which come from the on-screen panel --
 * is NOT read yet, and the coverage funnel says "unknown" rather
 * than zero.
 *
 * The page is built on the shared source shell
 * (`src/report/sourceDashboardShell.js`), so it carries the same
 * header, coverage funnel and navigation contract as the other
 * sources' dashboards.
 */

const {
  SOURCE_SHELL_CSS,
  renderCoverage,
  renderSourceHeader,
} = require('./sourceDashboardShell');

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function percent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1)} %`;
}

/**
 * The coverage funnel: what was read, and what was not.
 *
 * A stage that was not checked is "unknown", never zero.
 */
function buildCoverage(payload) {
  const summary = payload.summary || {};
  const outcomes = payload.outcomes || [];
  return [
    { stage: 'Videos catalogued', count: payload.videos_total || 0, denominator: null, status: 'complete' },
    { stage: 'Videos transcribed', count: payload.videos_transcribed || 0, denominator: payload.videos_total || 0, status: 'complete' },
    { stage: 'Setups extracted', count: payload.setups_total || 0, denominator: null, status: 'complete' },
    {
      stage: 'Setups with a session date',
      count: outcomes.length,
      denominator: payload.setups_total || 0,
      status: outcomes.length ? 'partial' : 'unknown',
      reason: payload.undated_setups
        ? `${payload.undated_setups} setup(s) come from sessions with no date in the catalog`
        : '',
    },
    { stage: 'Setups scored against prices', count: outcomes.filter((row) => row.hit_1w !== null).length, denominator: outcomes.length, status: 'partial' },
    {
      stage: 'Panel (watchlist and positions)',
      count: null,
      denominator: null,
      status: 'unknown',
      reason: 'the on-screen panel is measured but not yet read',
    },
    { stage: 'Trade log', count: payload.trades_total || 0, denominator: null, status: 'complete' },
    { stage: 'Summary watchlists', count: payload.readings_total || 0, denominator: null, status: 'complete' },
  ];
}

/**
 * The CONVERSION FUNNEL: setups -> watchlist -> positions -> closed
 * trades.
 *
 * It is the question only Komar can answer, because it is the only
 * source with all four ends. The positions rung is NOT read yet (the
 * on-screen panel is measured but its reader is not trustworthy), and
 * an unread rung is **unknown**, never zero.
 */
function renderFunnel(payload) {
  const stages = [
    {
      label: 'Setups said',
      count: payload.setups_total || 0,
      note: 'calls, with their evidence',
    },
    {
      label: 'Dated and scored',
      count: (payload.outcomes || []).length,
      note: 'against the prices, and SPY',
    },
    {
      label: 'On the watchlist',
      count: payload.watchlist_tickers === undefined || payload.watchlist_tickers === null
        ? null
        : payload.watchlist_tickers,
      note: 'tickers named in the summaries and the cards',
    },
    {
      label: 'Held as a position',
      count: null,
      note: 'the on-screen panel is not read yet',
    },
    {
      label: 'Closed as a trade',
      count: payload.trades_total || 0,
      note: 'the trade log, with prices and outcomes',
    },
  ];
  const rows = stages.map((stage) => `<li class="funnel-stage">
    <span class="funnel-label">${escapeHtml(stage.label)}</span>
    <strong>${stage.count === null || stage.count === undefined ? 'Unknown' : Number(stage.count).toLocaleString('en-US')}</strong>
    <small>${escapeHtml(stage.note)}</small>
  </li>`).join('');
  return `<section id="funnel"><div class="section-heading">
    <p class="source-kicker">THE FUNNEL</p><h2>From a call to a closed trade</h2></div>
  <ol class="funnel-stages">${rows}</ol></section>`;
}

/**
 * A table of the scored setups.
 */
function renderSetups(outcomes) {
  if (!outcomes.length) return '<p class="empty">No setup has been scored yet.</p>';
  const rows = outcomes
    .slice()
    .sort((a, b) => (a.hit_1w === b.hit_1w ? 0 : (a.hit_1w === null ? 1 : (b.hit_1w === null ? -1 : (b.hit_1w ? -1 : 1)))))
    .map((row) => `<tr>
      <td class="mono">${escapeHtml(row.ticker)}</td>
      <td>${escapeHtml(row.event_date)}</td>
      <td class="${row.bias === 'bullish' ? 'up' : (row.bias === 'bearish' ? 'down' : '')}">${escapeHtml(row.bias)}</td>
      <td class="mono">${escapeHtml(row.entry_price)}</td>
      <td class="mono">${row.return_1w === null ? '—' : `${(Number(row.return_1w) * 100).toFixed(1)} %`}</td>
      <td class="mono">${row.return_1m === null ? '—' : `${(Number(row.return_1m) * 100).toFixed(1)} %`}</td>
      <td>${row.hit_1w === null ? '—' : (row.hit_1w ? 'hit' : 'miss')}</td>
      <td class="evidence">${escapeHtml(String(row.evidence_text || '').slice(0, 220))}</td>
    </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Ticker</th><th>Date</th><th>Call</th><th>Entry</th><th>1 week</th><th>1 month</th><th>1w</th><th>Evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The trade log: what he actually did.
 */
function renderTrades(trades) {
  if (!trades || !trades.length) return '<p class="empty">The trade log has not been read yet.</p>';
  const rows = trades.map((trade) => `<tr>
    <td class="mono">${escapeHtml(trade.ticker)}</td>
    <td>${escapeHtml(trade.date_opened)}</td>
    <td>${escapeHtml(trade.date_closed)}</td>
    <td>${escapeHtml(trade.entry_type)}</td>
    <td class="mono">${escapeHtml(trade.avg_open_price)}</td>
    <td class="mono">${escapeHtml(trade.avg_close_price)}</td>
    <td class="mono">${escapeHtml(trade.stop_loss_price)}</td>
    <td class="mono">${trade.wl_pct === null ? '—' : `${Number(trade.wl_pct).toFixed(2)} %`}</td>
    <td>${escapeHtml(trade.exit_type)}</td>
    <td>${escapeHtml(trade.review)}</td>
    <td>${escapeHtml(trade.initial_rating)}</td>
  </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Ticker</th><th>Opened</th><th>Closed</th><th>Entry</th><th>Avg open</th><th>Avg close</th><th>Stop</th><th>W/L</th><th>Exit</th><th>Grade</th><th>Stars</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The Summary watchlists: the dated, curated list with his verdict.
 */
function renderReadings(readings) {
  if (!readings || !readings.length) return '<p class="empty">The Summary has not been read yet.</p>';
  const holdings = readings.filter((reading) => reading.kind === 'holding');
  const rows = holdings.map((reading) => `<tr>
    <td>${escapeHtml(reading.doc_date)}</td>
    <td class="mono">${escapeHtml(reading.subject)}</td>
    <td>${escapeHtml(reading.name)}</td>
    <td>${escapeHtml(reading.text)}</td>
    <td>${escapeHtml(reading.verdict)}</td>
    <td class="${reading.stance === 'bullish' ? 'up' : (reading.stance === 'bearish' ? 'down' : '')}">${escapeHtml(reading.stance)}</td>
  </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Report</th><th>Ticker</th><th>Name</th><th>Commentary</th><th>Verdict</th><th>Stance</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The cards: the market read of each session.
 */
function renderCards(cards) {
  if (!cards || !cards.length) return '<p class="empty">No market card has been read yet.</p>';
  const rows = cards.map((card) => `<tr>
    <td>${escapeHtml(card.session_date)}</td>
    <td class="up">${escapeHtml(card.trend_nasdaq_dir)}</td>
    <td class="up">${escapeHtml(card.trend_sp500_dir)}</td>
    <td class="down">${escapeHtml(card.trend_russell2000_dir)}</td>
    <td class="mono">${escapeHtml(card.exposure_pct)}</td>
    <td>${escapeHtml(String(card.market_text || '').slice(0, 160))}</td>
  </tr>`).join('');
  return `<table class="data-table">
    <thead><tr><th>Session</th><th>NASDAQ</th><th>S&amp;P 500</th><th>Russell 2000</th><th>Exposure</th><th>Read</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Build the Komar dashboard.
 *
 * @param {object} payload
 * @returns {string} the page
 */
function buildKomarReportHtml(payload = {}) {
  const summary = payload.summary || {};
  const baseline = payload.baseline || {};
  const source = {
    accent: '#1f7a4d',
    capabilities: ['trade log', 'setups', 'market cards', 'summary watchlists'],
    description: 'A paid membership read from the corpus on disk: what he said he was watching, '
      + 'what he did, and what the prices did.',
    id: 'komar',
    label: 'Komar (MARKET UPDATE Premium)',
    updatedAt: payload.generated_at || 'unknown',
  };

  const cards = [
    ['Setups extracted', payload.setups_total || 0, 'calls with their evidence'],
    ['Setups scored', (payload.outcomes || []).length, 'against the prices'],
    ['Hit rate, 1 week', percent(summary.hit_rate_1w), 'the calls that worked'],
    ['SPY baseline, 1 week', percent(baseline.mean_1w), 'the same window'],
    ['Trades in the log', payload.trades_total || 0, 'what he actually did'],
    ['Watchlist readings', payload.readings_total || 0, 'from the weekend summaries'],
  ].map(([label, value, note]) => `<div class="stat-tile">
    <span class="stat-label">${escapeHtml(label)}</span>
    <strong class="stat-value">${escapeHtml(value)}</strong>
    <span class="stat-note">${escapeHtml(note)}</span>
  </div>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Komar — MARKET UPDATE Premium</title>
<style>${SOURCE_SHELL_CSS}
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:1rem; margin:2rem 0; }
  .stat-tile { background:var(--panel); border:1px solid var(--rule); padding:1rem 1.1rem; display:flex; flex-direction:column; gap:.35rem; }
  .stat-label { font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .stat-value { font-size:1.9rem; line-height:1; }
  .stat-note { font-size:.78rem; color:var(--muted); }
  .data-table { width:100%; border-collapse:collapse; margin:1rem 0 2.5rem; font-size:.88rem; }
  .data-table th { text-align:left; font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--rule); padding:.5rem .6rem; }
  .data-table td { border-bottom:1px solid var(--rule); padding:.45rem .6rem; vertical-align:top; }
  .mono { font-family:ui-monospace,'SFMono-Regular',Menlo,monospace; }
  .up { color:#1f7a4d; } .down { color:#a8322d; }
  .evidence { color:var(--muted); max-width:32rem; }
  .empty { color:var(--muted); font-style:italic; }
  .funnel-stages { list-style:none; display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem; padding:0; margin:1rem 0 2rem; }
  .funnel-stage { background:var(--panel); border:1px solid var(--rule); padding:1rem 1.1rem; display:flex; flex-direction:column; gap:.3rem; }
  .funnel-label { font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
  .funnel-stage strong { font-size:1.7rem; line-height:1; }
  .funnel-stage small { font-size:.78rem; color:var(--muted); }
  .section-heading { margin:2.5rem 0 .5rem; }
  .section-heading h2 { margin:.2rem 0 0; font-size:1.35rem; }
  .source-kicker { margin:0; font-size:.72rem; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); }
</style></head>
<body>
${renderSourceHeader(source)}
<section id="overview"><div class="stat-grid">${cards}</div></section>
${renderFunnel(payload)}
${renderCoverage(buildCoverage(payload))}
<section id="setups"><div class="section-heading"><p class="source-kicker">THE CALLS</p><h2>Setups and what the prices did</h2></div>
${renderSetups(payload.outcomes || [])}</section>
<section id="trades"><div class="section-heading"><p class="source-kicker">WHAT HE DID</p><h2>The trade log</h2></div>
${renderTrades(payload.trades || [])}</section>
<section id="watchlists"><div class="section-heading"><p class="source-kicker">THE WATCHLIST</p><h2>The weekend summaries</h2></div>
${renderReadings(payload.readings || [])}</section>
<section id="cards"><div class="section-heading"><p class="source-kicker">THE MARKET</p><h2>The market cards</h2></div>
${renderCards(payload.cards || [])}</section>
</body></html>`;
}

module.exports = { buildKomarReportHtml };
