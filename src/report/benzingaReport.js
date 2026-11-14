'use strict';

// The Benzinga dashboard.
//
// One self-contained HTML file, no CDN and no fetched script, for the same
// reason the Sevcik and T3Live reports are: a dashboard that needs a
// network renders blank offline, and the point of one is that it can be
// opened.
//
// It answers the questions THIS source raises, which the other reports do
// not:
//
//   which SHOW the call came from   the daily PreMarket Playbook, the
//                                   weekly The Drift, a setup clip and a
//                                   long-form commentary are different
//                                   things with different calendars
//   which PARTNER was on             "PreMarket Playbook + T3 Live" is not
//                                   independent of the t3live corpus
//   WHAT KIND of claim it is         a forward call, a report of somebody
//                                   else's opinion, a recap of yesterday,
//                                   a sponsor's segment
//   what the show said about the     the market and sector readings, which
//   MARKET and the SECTORS           are not calls on any ticker
//   whether the calls beat the index the outcome verdict
//   the evidence                     every signal expands to its words
//
// The HTML is generated from the same payload the JSON carries, so the two
// cannot disagree. The outcome summary is OPTIONAL: a dashboard built
// before the outcomes have been scored says so, rather than showing zeros.

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A rate as a percentage, or an em dash when there is none.
 *
 * @param {unknown} value
 * @returns {string}
 */
function pct(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return `${(parsed * 100).toFixed(1)}%`;
}

/**
 * A signed return as a percentage.
 *
 * @param {unknown} value
 * @returns {string}
 */
function signedPct(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  const sign = parsed > 0 ? '+' : '';
  return `${sign}${(parsed * 100).toFixed(2)}%`;
}

/**
 * @param {string} bias
 * @returns {string}
 */
function biasPill(bias) {
  const label = escapeHtml(bias || 'neutral');
  return `<span class="pill pill-${label}">${label}</span>`;
}

const SHOW_LABELS = {
  premarket_playbook: 'PreMarket Playbook',
  the_drift: 'The Drift',
  stock_in_play: 'Setup clip',
  explainer: 'Explainer',
  market_update: 'Market update',
  earnings_call: 'Earnings call',
  fed_presser: 'Fed presser',
  interview: 'Interview',
  partner_content: 'Partner content',
  education: 'Education',
  product_tutorial: 'Product tutorial',
  short_clip: 'Short clip',
  upcoming: 'Not streamed yet',
  other: 'other',
};

/** The shows that carry calls. The rest are quarantined. */
const SIGNAL_SHOWS = [
  'premarket_playbook',
  'the_drift',
  'stock_in_play',
  'explainer',
];

const { SOURCE_SHELL_CSS, renderCoverage, renderSourceHeader } = require('./sourceDashboardShell');

/**
 * @param {string} show
 * @returns {string}
 */
function showLabel(show) {
  return SHOW_LABELS[show] || show || 'other';
}

/**
 * The headline cards.
 *
 * @param {object} payload
 * @returns {string}
 */
function renderHeadline(payload) {
  const signals = payload.signals || [];
  const bullish = signals.filter((signal) => signal.bias === 'bullish').length;
  const bearish = signals.filter((signal) => signal.bias === 'bearish').length;
  const reported = signals.filter((signal) => signal.claim_kind === 'reported').length;
  const forward = signals.filter((signal) => signal.claim_kind === 'forward').length;
  const byShow = payload.by_show || {};

  return `
    <div class="cards">
      <div class="card"><div class="card-value">${payload.signal_count || 0}</div><div class="card-label">signals</div></div>
      <div class="card"><div class="card-value">${forward}</div><div class="card-label">forward calls</div></div>
      <div class="card"><div class="card-value">${reported}</div><div class="card-label">reported opinions</div></div>
      <div class="card"><div class="card-value">${payload.unique_tickers || 0}</div><div class="card-label">tickers</div></div>
      <div class="card"><div class="card-value">${bullish}</div><div class="card-label">bullish</div></div>
      <div class="card"><div class="card-value">${bearish}</div><div class="card-label">bearish</div></div>
      <div class="card"><div class="card-value">${payload.reading_count || 0}</div><div class="card-label">market readings</div></div>
      ${SIGNAL_SHOWS.map((show) => `<div class="card"><div class="card-value">${byShow[show] || 0}</div><div class="card-label">${escapeHtml(showLabel(show))}</div></div>`).join('')}
    </div>
    <p class="note">Generated ${escapeHtml(payload.generated_at || '')}.</p>`;
}

/**
 * One outcome row.
 *
 * @param {string} label
 * @param {object} summary
 * @returns {string}
 */
function outcomeRow(label, summary) {
  if (!summary) return '';
  const excess = Number(summary.same_call_excess_1w);
  const ci = summary.same_call_excess_1w_ci || {};
  const significant = Number.isFinite(excess) && ((ci.low > 0) || (ci.high < 0));
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td class="num">${summary.claim_count || summary.signal_count || 0}</td>
    <td class="num">${pct(summary.hit_rate_1w)}</td>
    <td class="num">${pct(summary.same_call_hit_rate_1w)}</td>
    <td class="num ${excess > 0 ? 'up' : 'down'}">${signedPct(excess)}</td>
    <td class="num">${Number.isFinite(Number(ci.low)) ? `${signedPct(ci.low)} … ${signedPct(ci.high)}` : '—'}</td>
    <td>${significant ? 'yes' : 'no'}</td>
  </tr>`;
}

/**
 * The outcome verdict.
 *
 * @param {object|null} outcomes
 * @returns {string}
 */
function renderOutcomes(outcomes) {
  if (!outcomes || !outcomes.overall) {
    return '<p class="note">Not scored yet. Run <code>node tools/analyzeBenzingaOutcomes.js</code>.</p>';
  }
  const rows = [
    outcomeRow('overall', outcomes.overall),
    ...Object.entries(outcomes.by_show || {}).map(([show, summary]) => outcomeRow(showLabel(show), summary)),
    ...Object.entries(outcomes.by_partner || {}).map(([partner, summary]) => outcomeRow(partner, summary)),
    ...Object.entries(outcomes.by_bias || {}).map(([bias, summary]) => outcomeRow(bias, summary)),
  ].join('');

  return `
    <p class="note">${escapeHtml(outcomes.entry_rule || '')}. A claim is one ticker per video;
      a video that was bullish and bearish on the same name is excluded
      (${outcomes.conflicting_claims || 0} such). "Same call on SPY" is the hit rate SPY
      itself would have scored on the identical dates and directions, so a show that only
      calls what the market did does not look like it has an edge. The excess is the stock's
      return minus SPY's, signed by the call's direction; it is real only when its 95%
      interval excludes zero. Only FORWARD claims are scored: a reported opinion, a recap
      and a sponsor's segment are not predictions.</p>
    <table>
      <thead><tr><th></th><th class="num">claims</th><th class="num">hit 1w</th>
        <th class="num">same call on SPY</th><th class="num">excess 1w</th>
        <th class="num">95% interval</th><th>significant</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * The per-ticker table.
 *
 * @param {Array<object>} tickers
 * @returns {string}
 */
function renderTickers(tickers) {
  const rows = (tickers || []).slice(0, 40).map((ticker) => `<tr>
    <td>${escapeHtml(ticker.ticker)}</td>
    <td class="num">${ticker.signal_count || 0}</td>
    <td class="num">${ticker.forward_count || 0}</td>
    <td class="num">${ticker.bullish_count || 0}</td>
    <td class="num">${ticker.bearish_count || 0}</td>
    <td class="num">${ticker.video_count || 0}</td>
  </tr>`).join('');

  return `<table>
    <thead><tr><th>ticker</th><th class="num">signals</th><th class="num">forward</th>
      <th class="num">bullish</th><th class="num">bearish</th><th class="num">videos</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">The 40 most-mentioned names. "forward" is the number of claims that
    were predictions; the rest are reported opinions, recaps and sponsor segments.</p>`;
}

/**
 * The market and sector readings.
 *
 * @param {Array<object>} readings
 * @returns {string}
 */
function renderReadings(readings) {
  if (!readings || !readings.length) {
    return '<p class="note">No readings yet.</p>';
  }
  const rows = readings.slice(0, 200).map((reading) => `<tr>
    <td>${escapeHtml(reading.upload_date || '')}</td>
    <td>${escapeHtml(showLabel(reading.show))}</td>
    <td>${escapeHtml(reading.scope)}</td>
    <td>${escapeHtml(reading.subject)}</td>
    <td>${escapeHtml(reading.proxy_ticker)}</td>
    <td>${biasPill(reading.stance)}</td>
    <td><details><summary>evidence</summary><p>${escapeHtml(reading.evidence_text || '')}</p></details></td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>date</th><th>show</th><th>scope</th><th>subject</th><th>proxy</th>
      <th>stance</th><th>evidence</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Every signal, filterable by show and by claim kind.
 *
 * @param {Array<object>} signals
 * @returns {string}
 */
function renderSignals(signals) {
  const rows = (signals || []).map((signal) => `<tr data-show="${escapeHtml(signal.show || 'other')}"
      data-kind="${escapeHtml(signal.claim_kind || 'forward')}">
    <td>${escapeHtml(signal.upload_date || '')}</td>
    <td>${escapeHtml(showLabel(signal.show))}</td>
    <td>${escapeHtml(signal.partner || '')}</td>
    <td>${escapeHtml(signal.ticker)}</td>
    <td>${biasPill(signal.bias)}</td>
    <td>${escapeHtml(signal.claim_kind || '')}</td>
    <td>${escapeHtml(signal.action || '')}</td>
    <td class="num">${signal.entry_price === '' || signal.entry_price === null ? '—' : escapeHtml(signal.entry_price)}</td>
    <td class="num">${signal.stop_price === '' || signal.stop_price === null ? '—' : escapeHtml(signal.stop_price)}</td>
    <td><details><summary>evidence</summary><p>${escapeHtml(signal.evidence_text || '')}</p></details></td>
  </tr>`).join('');

  return `<div class="filters">
      <button data-filter="all" class="active">all</button>
      ${SIGNAL_SHOWS.map((show) => `<button data-filter="${escapeHtml(show)}">${escapeHtml(showLabel(show))}</button>`).join('')}
    </div>
    <div class="filters">
      <button data-kind="all" class="active">every claim</button>
      <button data-kind="forward">forward calls</button>
      <button data-kind="reported">reported</button>
      <button data-kind="retrospective">recaps</button>
    </div>
    <table id="signals">
      <thead><tr><th>date</th><th>show</th><th>partner</th><th>ticker</th><th>bias</th>
        <th>kind</th><th>action</th><th class="num">trigger</th><th class="num">stop</th>
        <th>evidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

const CSS = `
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 0.6rem 1rem; min-width: 7rem; }
  .card-value { font-size: 1.4rem; font-weight: 600; }
  .card-label { font-size: 0.8rem; color: #666; }
  .note { color: #666; font-size: 0.85rem; max-width: 60rem; }
  table { border-collapse: collapse; margin-top: 0.5rem; }
  th, td { border-bottom: 1px solid #eee; padding: 0.3rem 0.7rem; text-align: left; vertical-align: top; }
  th { font-size: 0.8rem; color: #666; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .up { color: #0a7d32; } .down { color: #b42318; }
  .pill { border-radius: 10px; padding: 0.05rem 0.5rem; font-size: 0.8rem; }
  .pill-bullish { background: #e5f6eb; color: #0a7d32; }
  .pill-bearish { background: #fde8e6; color: #b42318; }
  .pill-neutral, .pill-mixed, .pill-watch { background: #f0f0f0; color: #555; }
  details summary { cursor: pointer; color: #555; }
  details p { max-width: 46rem; white-space: pre-wrap; font-size: 0.85rem; }
  .filters button { margin-right: 0.4rem; padding: 0.25rem 0.7rem; cursor: pointer; }
  .filters button.active { font-weight: 600; }
`;

const FILTER_SCRIPT = `
  document.querySelectorAll('.filters button[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filters button[data-filter]').forEach((other) => other.classList.remove('active'));
      button.classList.add('active');
      const filter = button.dataset.filter;
      document.querySelectorAll('#signals tbody tr').forEach((row) => {
        row.hidden = filter !== 'all' && row.dataset.show !== filter;
      });
    });
  });
  document.querySelectorAll('.filters button[data-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filters button[data-kind]').forEach((other) => other.classList.remove('active'));
      button.classList.add('active');
      const kind = button.dataset.kind;
      document.querySelectorAll('#signals tbody tr').forEach((row) => {
        if (kind === 'all') { row.hidden = false; return; }
        row.hidden = row.dataset.kind !== kind;
      });
    });
  });
`;

/**
 * The dashboard.
 *
 * @param {object} payload - the aggregate payload
 * @param {object|null} [outcomes] - the outcome summary, when it has been scored
 * @returns {string}
 */
function renderBenzingaReport(payload, outcomes = null) {
  const source = payload.source || {
    id: 'benzinga', label: 'Benzinga', updatedAt: payload.generated_at,
    description: 'Video coverage, spoken market commentary, ticker calls, and source evidence.',
    capabilities: ['video', 'captions', 'transcripts', 'signals', 'market readings'],
    accent: '#a6492d',
  };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Benzinga signals</title>
<style>${CSS}\n${SOURCE_SHELL_CSS}</style></head><body style="--source-accent:#a6492d">
${renderSourceHeader(source)}
<nav class="source-nav" aria-label="Source dashboard views"><a href="#activity">Activity</a><a href="#signals">Signals</a><a href="#readings">Readings</a><a href="#coverage">Coverage</a></nav>
<div id="activity" class="source-section">
${renderHeadline(payload)}
<h2>Do the calls beat the index?</h2>
${renderOutcomes(outcomes)}
<h2>Most-mentioned names</h2>
${renderTickers(payload.tickers)}
<h2 id="readings">What the shows said about the market and the sectors</h2>
${renderReadings(payload.readings)}
<h2 id="signals">Every signal</h2>
${renderSignals(payload.signals)}
${renderCoverage(payload.coverage || [])}
</div>
<script>${FILTER_SCRIPT}</script>
</body></html>`;
}

module.exports = {
  SHOW_LABELS,
  SIGNAL_SHOWS,
  renderBenzingaReport,
  showLabel,
};
