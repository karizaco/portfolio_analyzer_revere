'use strict';

/**
 * The O'Connell dashboard.
 *
 * A self-contained HTML page: no CDN, no fonts, no scripts fetched from
 * the network. A report that needs a network to render is a report that
 * renders blank on a plane.
 *
 * The page chrome -- the header, the coverage funnel and the CSS -- is
 * the shared shell (`src/report/sourceDashboardShell.js`), so this
 * source looks like the others; the tables and the evidence detail are
 * this source's own, because what it has to show is a SETUP and its
 * thesis beside a POSITION and its stop, and no other source has that
 * pair.
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

function num(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return escapeHtml(value);
  return parsed.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function pct(value) {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return escapeHtml(value);
  return `${parsed.toFixed(2)}%`;
}

function signPill(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '<span class="pill">—</span>';
  if (parsed > 0) return `<span class="pill pill-up">+${num(parsed)}%</span>`;
  if (parsed < 0) return `<span class="pill pill-down">${num(parsed)}%</span>`;
  return '<span class="pill">0.00%</span>';
}

function directionPill(direction) {
  if (!direction) return '<span class="pill">direction not stated</span>';
  if (direction === 'long') return '<span class="pill pill-up">long</span>';
  if (direction === 'short') return '<span class="pill pill-down">short</span>';
  return `<span class="pill">${escapeHtml(direction)}</span>`;
}

function kindPill(kind) {
  if (!kind) return '<span class="pill">unclassified</span>';
  return `<span class="pill pill-kind">${escapeHtml(kind.replace(/_/g, ' '))}</span>`;
}

function stars(count) {
  const total = Number(count) || 0;
  if (!total) return '—';
  return '★'.repeat(Math.min(3, total));
}

const EXTRA_CSS = `
  .source-nav { display:flex; gap:1.2rem; border-bottom:1px solid var(--rule); margin:1.2rem 0 2rem; }
  .source-nav a { padding:.7rem .1rem; color:var(--muted); text-decoration:none; font:700 .78rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.08em; border-bottom:2px solid transparent; }
  .source-nav a:hover,.source-nav a:focus { color:var(--ink); border-color:var(--source-accent,#2f6b5f); }
  .source-section { padding:1rem 0 2rem; border-bottom:1px solid var(--rule); scroll-margin-top:1rem; }
  .source-section h2 { font-size:1.35rem; letter-spacing:-.02em; }
  .section-heading { margin:0 0 1rem; }
  .overview-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(10rem,1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); margin:0 0 1.4rem; }
  .overview-card { background:var(--panel); padding:1rem; }
  .overview-card span { display:block; color:var(--muted); font:700 .66rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.08em; }
  .overview-card strong { display:block; margin-top:.35rem; font-size:1.7rem; font-variant-numeric:tabular-nums; letter-spacing:-.03em; }
  .pill { display:inline-block; padding:.1rem .4rem; border:1px solid var(--rule); font:700 .66rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.04em; white-space:nowrap; }
  .pill-up { background:#e4efe6; border-color:#b6cdb9; color:#24503a; }
  .pill-down { background:#f6e2e0; border-color:#dcb4ae; color:#7d2f26; }
  .pill-kind { background:#e7e6f0; border-color:#c3c0d8; color:#3a3760; }
  table.data { width:100%; border-collapse:collapse; font-size:.86rem; }
  table.data th { text-align:left; padding:.55rem .5rem; border-bottom:2px solid var(--rule); color:var(--muted); font:700 .66rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.06em; }
  table.data td { padding:.5rem; border-bottom:1px solid var(--rule); vertical-align:top; }
  table.data td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .thesis { margin:.3rem 0 0; color:var(--muted); font-size:.84rem; line-height:1.45; max-width:52rem; }
  .setup-cell { display:flex; gap:.4rem; align-items:baseline; flex-wrap:wrap; }
  .setup-ticker { font-weight:700; }
  .setup-label { color:var(--ink); }
  .table-scroll { overflow-x:auto; }
  .empty { color:var(--muted); font-style:italic; }
  .legend { color:var(--muted); font: .74rem/1.5 ui-monospace,Consolas,monospace; margin:.6rem 0 0; }
  .source-footer { padding:1.4rem 0 0; color:var(--muted); font: .74rem/1.6 ui-monospace,Consolas,monospace; }
`;

function renderOverview(payload) {
  const counts = payload.counts || {};
  const cards = [
    { label: 'Documents', value: num(counts.documents, 0) },
    { label: 'Setups', value: num(counts.setups, 0) },
    { label: 'Setups with prose', value: num(counts.setupsWithProse, 0) },
    { label: 'Position lots', value: num(counts.positions, 0) },
    { label: 'Distinct tickers', value: num((payload.tickers || []).length, 0) },
    { label: 'Issues with a log', value: num(counts.withPositionLog, 0) },
  ];
  return `<div class="overview-cards">${cards.map((card) => `<div class="overview-card">
    <span>${escapeHtml(card.label)}</span><strong>${card.value}</strong></div>`).join('')}</div>`;
}

function renderSetups(payload) {
  const setups = payload.setups || [];
  if (!setups.length) {
    return '<p class="empty">No setups have been extracted.</p>';
  }
  const rows = setups.map((setup) => `<tr>
    <td class="num">${escapeHtml(setup.source_date || '')}</td>
    <td><span class="setup-ticker">${escapeHtml(setup.ticker)}</span></td>
    <td><div class="setup-cell"><span class="setup-label">${escapeHtml(setup.setup_label || '')}</span>
      ${kindPill(setup.setup_kind)}${directionPill(setup.direction)}</div>
      ${setup.thesis ? `<p class="thesis">${escapeHtml(setup.thesis)}</p>` : '<p class="thesis">heading only — the prose could not be read</p>'}</td>
    <td>${escapeHtml(setup.section || '')}</td>
    <td class="num">${setup.evidence_page ? escapeHtml(setup.evidence_page) : '—'}</td>
  </tr>`).join('');

  return `<div class="table-scroll"><table class="data">
    <thead><tr><th>Date</th><th>Ticker</th><th>Setup</th><th>Section</th><th>Page</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="legend">A setup is what he said he was watching. It is not a position, and it may never have been traded.</p>`;
}

function renderPositions(payload) {
  const positions = payload.positions || [];
  if (!positions.length) {
    return '<p class="empty">No positions have been extracted.</p>';
  }
  const rows = positions.map((position) => `<tr>
    <td class="num">${escapeHtml(position.source_date || '')}</td>
    <td>${escapeHtml(position.instrument === 'option' ? 'option' : 'equity')}</td>
    <td><span class="setup-ticker">${escapeHtml(position.ticker)}</span></td>
    <td>${escapeHtml(position.contract || '')}</td>
    <td class="num">${escapeHtml(position.entry_date || '—')}</td>
    <td class="num">${num(position.cost_basis)}</td>
    <td class="num">${num(position.price)}</td>
    <td class="num">${signPill(position.gain_loss_pct)}</td>
    <td class="num">${stars(position.size_stars)}</td>
    <td class="num">${num(position.stop_price)}</td>
    <td class="num">${pct(position.risk_pct)}</td>
    <td class="num">${num(position.r2_price)}</td>
    <td>${escapeHtml(position.setup_label || '')}</td>
  </tr>`).join('');

  return `<div class="table-scroll"><table class="data">
    <thead><tr><th>Date</th><th>Kind</th><th>Ticker</th><th>Contract</th><th>Entry</th>
      <th>Cost</th><th>Price</th><th>G/L</th><th>Size</th><th>Stop</th><th>Risk</th>
      <th>R2</th><th>Setup</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p class="legend">A row is a LOT, not a ticker: the same ticker is on several rows when it was bought several times.</p>`;
}

function renderSnapshots(payload) {
  const snapshots = payload.snapshots || [];
  if (!snapshots.length) return '<p class="empty">No daily snapshot has been read.</p>';
  const rows = snapshots.map((snapshot) => `<tr>
    <td>${escapeHtml(snapshot.doc_id)}</td>
    <td class="num">${num(snapshot.equity_count, 0)}</td>
    <td class="num">${num(snapshot.option_count, 0)}</td>
    <td class="num">${pct(snapshot.cash_pct)}</td>
    <td class="num">${pct(snapshot.invested_pct)}</td>
    <td class="num">${snapshot.trend_model === null ? '—' : escapeHtml(snapshot.trend_model)}</td>
    <td class="num">${pct(snapshot.win_rate_stock_pct)}</td>
    <td class="num">${pct(snapshot.win_rate_options_pct)}</td>
  </tr>`).join('');
  return `<div class="table-scroll"><table class="data">
    <thead><tr><th>Issue</th><th>Equities</th><th>Options</th><th>Cash</th><th>Invested</th>
      <th>Trend model</th><th>Win % (stock)</th><th>Win % (options)</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderTickers(payload) {
  const tickers = payload.tickers || [];
  if (!tickers.length) return '<p class="empty">No tickers have been extracted.</p>';
  const rows = tickers.slice(0, 120).map((row) => `<tr>
    <td><span class="setup-ticker">${escapeHtml(row.ticker)}</span></td>
    <td class="num">${num(row.setups, 0)}</td>
    <td class="num">${num(row.position_rows, 0)}</td>
    <td class="num">${num(row.equity_lots, 0)}</td>
    <td class="num">${num(row.option_lots, 0)}</td>
    <td class="num">${pct(row.average_gain_loss_pct)}</td>
    <td class="num">${escapeHtml(row.first_seen || '—')}</td>
    <td class="num">${escapeHtml(row.last_seen || '—')}</td>
  </tr>`).join('');
  return `<div class="table-scroll"><table class="data">
    <thead><tr><th>Ticker</th><th>Setups</th><th>Positions</th><th>Equity lots</th>
      <th>Option lots</th><th>Avg G/L</th><th>First seen</th><th>Last seen</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    ${tickers.length > 120 ? '<p class="legend">The 120 most-mentioned tickers are shown.</p>' : ''}`;
}

function renderOutcomes(payload) {
  const outcomes = payload.outcomes || [];
  if (!outcomes.length) {
    return '<p class="empty">No setup has been scored against a price yet.</p>';
  }
  const summary = payload.outcome_summary || {};
  const cards = Object.entries(summary)
    .filter(([, value]) => typeof value === 'number')
    .map(([key, value]) => `<div class="overview-card"><span>${escapeHtml(key.replace(/_/g, ' '))}</span>
      <strong>${num(value, 2)}</strong></div>`).join('');

  const rows = outcomes.slice(0, 200).map((outcome) => `<tr>
    <td class="num">${escapeHtml(outcome.source_date || '')}</td>
    <td><span class="setup-ticker">${escapeHtml(outcome.ticker)}</span></td>
    <td>${escapeHtml(outcome.setup_label || '')}</td>
    <td>${directionPill(outcome.direction)}</td>
    <td class="num">${escapeHtml(outcome.horizon || '')}</td>
    <td class="num">${pct(outcome.return_pct)}</td>
    <td class="num">${outcome.hit === null || outcome.hit === undefined ? '—' : (outcome.hit ? 'hit' : 'miss')}</td>
    <td class="num">${pct(outcome.baseline_pct)}</td>
  </tr>`).join('');

  return `<div class="overview-cards">${cards}</div>
    <div class="table-scroll"><table class="data">
    <thead><tr><th>Date</th><th>Ticker</th><th>Setup</th><th>Direction</th><th>Horizon</th>
      <th>Return</th><th>Result</th><th>Baseline</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderConversion(payload) {
  const conversion = payload.conversion;
  if (!conversion || !conversion.eligible) {
    return '<p class="empty">No setup can be matched against a position yet.</p>';
  }
  const rate = conversion.rate === null || conversion.rate === undefined
    ? '—'
    : `${(conversion.rate * 100).toFixed(1)}%`;
  const rows = conversion.rows
    .filter((row) => row.converted)
    .slice(0, 60)
    .map((row) => `<tr>
      <td class="num">${escapeHtml(row.source_date || '')}</td>
      <td><span class="setup-ticker">${escapeHtml(row.ticker)}</span></td>
      <td>${escapeHtml(row.setup_label || '')}</td>
      <td class="num">${escapeHtml(row.first_position_date || '')}</td>
      <td class="num">${row.days_to_position === null ? '—' : escapeHtml(row.days_to_position)}</td>
    </tr>`).join('');

  return `<div class="overview-cards">
    <div class="overview-card"><span>Setups</span><strong>${num(conversion.eligible, 0)}</strong></div>
    <div class="overview-card"><span>Became a position</span><strong>${num(conversion.converted, 0)}</strong></div>
    <div class="overview-card"><span>Conversion rate</span><strong>${rate}</strong></div>
    <div class="overview-card"><span>Horizon</span><strong>${num(conversion.horizon_days, 0)}d</strong></div>
  </div>
  <div class="table-scroll"><table class="data">
    <thead><tr><th>Setup date</th><th>Ticker</th><th>Setup</th><th>Held from</th><th>Days</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="empty">No setup became a position.</td></tr>'}</tbody></table></div>
  <p class="legend">A setup is what he said he was watching; a position is what he held. This is the distance between the two.</p>`;
}

/**
 * The whole report.
 *
 * @param {object} payload
 * @returns {string} the HTML
 */
function renderOconnellReport(payload = {}) {
  const source = payload.source || {};
  const nav = [
    ['#activity', 'Activity'],
    ['#setups', 'Setups'],
    ['#positions', 'Positions'],
    ['#conversion', 'Conversion'],
    ['#tickers', 'Tickers'],
    ['#outcomes', 'Outcomes'],
    ['#coverage', 'Coverage'],
  ].map(([href, label]) => `<a href="${href}">${label}</a>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(source.label || "O'Connell")} — source report</title>
<style>${SOURCE_SHELL_CSS}${EXTRA_CSS}</style>
</head>
<body>
${renderSourceHeader(source)}
<nav class="source-nav">${nav}</nav>

<section id="activity" class="source-section" aria-labelledby="activity-heading">
  <div class="section-heading"><p class="source-kicker">OVERVIEW</p><h2 id="activity-heading">What the corpus says</h2></div>
  ${renderOverview(payload)}
  <p class="legend">Generated ${escapeHtml(payload.generated_at || '')}. The corpus is a paid newsletter read from documents; nothing here is fetched from the web.</p>
</section>

<section id="setups" class="source-section" aria-labelledby="setups-heading">
  <div class="section-heading"><p class="source-kicker">SETUPS</p><h2 id="setups-heading">What he said he was watching</h2></div>
  ${renderSetups(payload)}
</section>

<section id="positions" class="source-section" aria-labelledby="positions-heading">
  <div class="section-heading"><p class="source-kicker">POSITIONS</p><h2 id="positions-heading">What he held</h2></div>
  ${renderPositions(payload)}
</section>

<section id="conversion" class="source-section" aria-labelledby="conversion-heading">
  <div class="section-heading"><p class="source-kicker">CONVERSION</p><h2 id="conversion-heading">When a setup became a position</h2></div>
  ${renderConversion(payload)}
</section>

<section id="tickers" class="source-section" aria-labelledby="tickers-heading">
  <div class="section-heading"><p class="source-kicker">TICKERS</p><h2 id="tickers-heading">The most-mentioned names</h2></div>
  ${renderTickers(payload)}
</section>

<section id="outcomes" class="source-section" aria-labelledby="outcomes-heading">
  <div class="section-heading"><p class="source-kicker">OUTCOMES</p><h2 id="outcomes-heading">Scored against prices</h2></div>
  ${renderOutcomes(payload)}
</section>

${renderCoverage(payload.coverage || [])}

<footer class="source-footer">
  Source: ${escapeHtml(source.label || '')} · generated ${escapeHtml(payload.generated_at || '')} ·
  documents ${num((payload.counts || {}).documents, 0)} ·
  setups ${num((payload.counts || {}).setups, 0)} ·
  position lots ${num((payload.counts || {}).positions, 0)}
</footer>
</body>
</html>`;
}

module.exports = { renderOconnellReport };
