'use strict';

// The AsymTrading dashboard.
//
// One self-contained HTML file, no CDN and no fetched script, for the same
// reason the Sevcik and T3Live reports are: a dashboard that needs a
// network renders blank offline, and the point of one is that it can be
// opened.
//
// WHAT THIS SOURCE SHOWS THAT THE OTHERS DO NOT
//
// Every other source in this project is spoken. This one is mostly
// WRITTEN: a free post is a Market Pulse -- a market recap, a sector
// analysis and a plan for the week ahead -- with a video attached that
// says much of the same thing out loud.
//
// So the dashboard leads with the written readings, because they are the
// reason to read this source at all:
//
//   COVERAGE      how much of the publication the pipeline actually
//                 reached -- 476 posts published, how many were free, how
//                 many carried a video, how many were transcribed.
//   THE READINGS  one row per post: the market backdrop, the index trend,
//                 the breadth and momentum readings, the sectors, and the
//                 Bottom Line in the author's own words.
//   THE OUTCOMES  whether the ticker calls beat the index.
//   THE CALLS     every signal, expandable to the words it came from.
//
// The coverage block is the one that matters most, because the
// publication is mostly PAYWALLED: the corpus is far larger than the
// part the pipeline may read, and a dashboard that showed only the free
// posts without saying so would read as the whole publication.
//
// The HTML is generated from the same payload the JSON carries, so the
// two cannot disagree. The outcome summary is OPTIONAL: a dashboard built
// before the outcomes have been scored says so rather than showing zeros.

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

/**
 * Parse a JSON column, and survive one that is not JSON.
 *
 * The article columns store JSON lists. A row written by an older parser
 * may hold something else, and a report must not die on it.
 *
 * @param {string} value
 * @returns {Array<any>}
 */
function parseJsonColumn(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The headline cards, including the coverage.
 *
 * @param {object} payload
 * @returns {string}
 */
function renderHeadline(payload) {
  const coverage = payload.coverage || {};
  const signals = payload.signals || [];
  const bullish = signals.filter((signal) => signal.bias === 'bullish').length;
  const bearish = signals.filter((signal) => signal.bias === 'bearish').length;

  return `
    <div class="cards">
      <div class="card"><div class="card-value">${coverage.posts || 0}</div><div class="card-label">posts published</div></div>
      <div class="card"><div class="card-value">${coverage.free || 0}</div><div class="card-label">free to read</div></div>
      <div class="card"><div class="card-value">${coverage.paid || 0}</div><div class="card-label">paywalled</div></div>
      <div class="card"><div class="card-value">${coverage.with_media || 0}</div><div class="card-label">with a video</div></div>
      <div class="card"><div class="card-value">${coverage.downloaded || 0}</div><div class="card-label">media downloaded</div></div>
      <div class="card"><div class="card-value">${coverage.transcribed || 0}</div><div class="card-label">transcribed</div></div>
      <div class="card"><div class="card-value">${coverage.frames || 0}</div><div class="card-label">frames</div></div>
      <div class="card"><div class="card-value">${coverage.sectors || 0}</div><div class="card-label">sector rows</div></div>
      <div class="card"><div class="card-value">${coverage.monitor_days || 0}</div><div class="card-label">monitor days</div></div>
      <div class="card"><div class="card-value">${payload.article_count || 0}</div><div class="card-label">readings parsed</div></div>
      <div class="card"><div class="card-value">${payload.signal_count || 0}</div><div class="card-label">signals</div></div>
      <div class="card"><div class="card-value">${bullish}</div><div class="card-label">bullish</div></div>
      <div class="card"><div class="card-value">${bearish}</div><div class="card-label">bearish</div></div>
      <div class="card"><div class="card-value">${payload.unique_tickers || 0}</div><div class="card-label">tickers</div></div>
    </div>
    <p class="note">Generated ${escapeHtml(payload.generated_at || '')}.
      The publication is mostly subscriber-only: ${coverage.free || 0} of
      ${coverage.posts || 0} posts are free to read, and the pipeline reads only
      those. A number below is a number about the FREE part of the source.</p>`;
}

/**
 * The written readings, one row per post.
 *
 * @param {Array<object>} articles
 * @returns {string}
 */
function renderArticles(articles) {
  const rows = (articles || []).map((article) => {
    const sectors = parseJsonColumn(article.sectors)
      .map((entry) => `${entry.sector || ''}${entry.tier ? ` (${entry.tier})` : ''}`)
      .filter(Boolean)
      .join(', ');
    const plan = parseJsonColumn(article.plan_sections)
      .map((entry) => `${entry.number || ''}. ${entry.title || ''}`.trim())
      .filter(Boolean)
      // A literal middot, not the HTML entity: the whole string is
      // escaped below, and an entity would be escaped into visible text.
      .join(' \u00b7 ');

    return `<tr>
      <td>${escapeHtml(article.upload_date || '')}</td>
      <td>${escapeHtml(article.backdrop || '')}</td>
      <td>${escapeHtml(article.trend || '')}</td>
      <td>${escapeHtml(article.breadth || '')}</td>
      <td>${escapeHtml(article.momentum || '')}</td>
      <td>${escapeHtml(sectors)}</td>
      <td>${escapeHtml(plan)}</td>
      <td><details><summary>bottom line</summary><p>${escapeHtml(article.bottom_line || '')}</p></details></td>
    </tr>`;
  }).join('');

  return `<table id="readings">
      <thead><tr><th>date</th><th>backdrop</th><th>trend</th><th>breadth</th>
        <th>momentum</th><th>sectors</th><th>plan</th><th>bottom line</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">The author's own readings, parsed from the written Market Pulse.
      The parser reads the report by its LABELS rather than by a date, because the
      report's format changed three times between 2024 and 2026.</p>`;
}

/**
 * One outcome row: the hit rate, the same call on SPY, and the excess.
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
    return '<p class="note">Not scored yet. Run <code>node tools/analyzeAsymOutcomes.js</code>.</p>';
  }
  const rows = [
    outcomeRow('overall', outcomes.overall),
    ...Object.entries(outcomes.by_bias || {}).map(([bias, summary]) => outcomeRow(bias, summary)),
  ].join('');

  return `
    <p class="note">${escapeHtml(outcomes.entry_rule || '')}. A claim is one ticker per post;
      a post that was bullish and bearish on the same name is excluded
      (${outcomes.conflicting_claims || 0} such). "Same call on SPY" is the hit rate SPY
      itself would have scored on the identical dates and directions, so a post that only
      calls what the market did does not look like it has an edge. The excess is the stock's
      return minus SPY's, signed by the call's direction; it is real only when its 95%
      interval excludes zero.</p>
    <table>
      <thead><tr><th></th><th class="num">claims</th><th class="num">hit 1w</th>
        <th class="num">same call on SPY</th><th class="num">excess 1w</th>
        <th class="num">95% interval</th><th>significant</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * The per-ticker table, the names called most often first.
 *
 * @param {Array<object>} tickers
 * @returns {string}
 */

/**
 * The article-vs-table consistency, and the sector-ETF outcomes.
 *
 * @param {object} payload
 * @param {object|null} sectorOutcomes
 * @returns {string}
 */
function renderSectors(payload, sectorOutcomes) {
  const consistency = payload.sector_consistency || [];
  if (!consistency.length && !(sectorOutcomes && sectorOutcomes.overall)) {
    return '<p class="note">No sector table yet. Run <code>npm run asym:frames</code> then <code>npm run asym:sectors</code>.</p>';
  }

  const byTier = {};
  for (const row of consistency) {
    const tier = row.tier || 'other';
    if (!byTier[tier]) byTier[tier] = { consistent: 0, contradicts: 0, unknown: 0, total: 0 };
    byTier[tier].total += 1;
    const key = row.consistency || row.article_rank_check || 'unknown';
    if (byTier[tier][key] == null) byTier[tier][key] = 0;
    byTier[tier][key] += 1;
  }
  const tierRows = Object.entries(byTier).map(([tier, v]) => {
    const rate = v.total ? (v.consistent || 0) / v.total : null;
    return '<tr>'
      + '<td>' + escapeHtml(tier) + '</td>'
      + '<td class="num">' + v.total + '</td>'
      + '<td class="num">' + (v.consistent || 0) + '</td>'
      + '<td class="num">' + (v.contradicts || 0) + '</td>'
      + '<td class="num">' + pct(rate) + '</td>'
      + '</tr>';
  }).join('');

  const consistencyTable = consistency.length ? (
    '<h3>Does the author pick from the top of the table?</h3>'
    + '<p class="note">For every sector the written report names, this is where that sector '
    + 'RANKED among the eleven by the on-screen 1-month rate of change. A primary pick in the '
    + 'top half is consistent with the table; one in the bottom half is not. An avoid pick is '
    + 'the mirror image.</p>'
    + '<table><thead><tr><th>tier</th><th class="num">named</th><th class="num">consistent</th>'
    + '<th class="num">contradicts</th><th class="num">rate</th></tr></thead><tbody>'
    + tierRows + '</tbody></table>'
  ) : '';

  let outcomeBlock = '';
  if (sectorOutcomes && sectorOutcomes.overall) {
    const rows = [
      outcomeRow('overall', sectorOutcomes.overall),
      ...Object.entries(sectorOutcomes.by_tier || {}).map(([tier, summary]) => outcomeRow(tier, summary)),
    ].join('');
    outcomeBlock = '<h3>Do the sector picks beat the index?</h3>'
      + '<p class="note">A primary/secondary pick is scored as a bullish call on its SPDR sector ETF '
      + '(XLK, XLV, XLE…). An avoid pick is scored as a bearish call. Entry is the close on the post '
      + 'date; horizons are +7 and +30 calendar days. "Same call on SPY" is the fair baseline.</p>'
      + '<table><thead><tr><th></th><th class="num">claims</th><th class="num">hit 1w</th>'
      + '<th class="num">same call on SPY</th><th class="num">excess 1w</th>'
      + '<th class="num">95% interval</th><th>significant</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  } else {
    outcomeBlock = '<p class="note">Sector ETF outcomes not scored yet. Run <code>node tools/analyzeAsymSectorOutcomes.js</code>.</p>';
  }

  // A few concrete recent rows so the numbers are inspectable.
  const sample = consistency.slice(0, 12).map((row) => '<tr>'
    + '<td>' + escapeHtml(row.upload_date || '') + '</td>'
    + '<td>' + escapeHtml(row.article_sector || '') + '</td>'
    + '<td>' + escapeHtml(row.tier || '') + '</td>'
    + '<td class="num">' + escapeHtml(row.rank_by_roc || '') + (row.of_sectors ? '/' + escapeHtml(row.of_sectors) : '') + '</td>'
    + '<td class="num">' + escapeHtml(row.roc_1mo === '' || row.roc_1mo == null ? '—' : row.roc_1mo) + '</td>'
    + '<td class="num">' + escapeHtml(row.pct_change === '' || row.pct_change == null ? '—' : row.pct_change) + '</td>'
    + '<td class="num">' + escapeHtml(row.roc_1yr === '' || row.roc_1yr == null ? '—' : row.roc_1yr) + '</td>'
    + '<td>' + escapeHtml(row.consistency || '') + '</td>'
    + '</tr>').join('');

  const sampleTable = consistency.length ? (
    '<h3>Recent named sectors</h3>'
    + '<table><thead><tr><th>date</th><th>sector</th><th>tier</th><th class="num">rank</th>'
    + '<th class="num">1mo ROC</th><th class="num">% chg</th><th class="num">1yr ROC</th><th>vs table</th></tr></thead><tbody>'
    + sample + '</tbody></table>'
  ) : '';

  return consistencyTable + outcomeBlock + sampleTable;
}

function renderTickers(tickers) {
  const rows = (tickers || []).slice(0, 40).map((ticker) => `<tr>
    <td>${escapeHtml(ticker.ticker)}</td>
    <td class="num">${ticker.signal_count || 0}</td>
    <td class="num">${ticker.bullish_count || 0}</td>
    <td class="num">${ticker.bearish_count || 0}</td>
    <td class="num">${ticker.video_count || 0}</td>
  </tr>`).join('');

  return `<table>
    <thead><tr><th>ticker</th><th class="num">signals</th><th class="num">bullish</th>
      <th class="num">bearish</th><th class="num">posts</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">The 40 most-mentioned names.</p>`;
}

/**
 * Every signal, each expandable to its evidence.
 *
 * @param {Array<object>} signals
 * @returns {string}
 */
function renderSignals(signals) {
  const rows = (signals || []).map((signal) => `<tr>
    <td>${escapeHtml(signal.upload_date || '')}</td>
    <td>${escapeHtml(signal.ticker)}</td>
    <td>${biasPill(signal.bias)}</td>
    <td>${escapeHtml(signal.action || '')}</td>
    <td class="num">${signal.entry_price === '' || signal.entry_price === null ? '—' : escapeHtml(signal.entry_price)}</td>
    <td class="num">${signal.stop_price === '' || signal.stop_price === null ? '—' : escapeHtml(signal.stop_price)}</td>
    <td><details><summary>evidence</summary><p>${escapeHtml(signal.evidence_text || '')}</p></details></td>
  </tr>`).join('');

  return `<table id="signals">
      <thead><tr><th>date</th><th>ticker</th><th>bias</th><th>action</th>
        <th class="num">trigger</th><th class="num">stop</th><th>evidence</th></tr></thead>
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
  .pill-neutral, .pill-mixed { background: #f0f0f0; color: #555; }
  details summary { cursor: pointer; color: #555; }
  details p { max-width: 46rem; white-space: pre-wrap; font-size: 0.85rem; }
`;

/**
 * The dashboard.
 *
 * @param {object} payload - the aggregate payload
 * @param {object|null} [outcomes] - the outcome summary, when it has been scored
 * @returns {string}
 */
function renderAsymReport(payload, outcomes = null, sectorOutcomes = null) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>AsymTrading Market Pulse</title>
<style>${CSS}</style></head><body>
<h1>AsymTrading — the Market Pulse</h1>
${renderHeadline(payload)}
<h2>The written readings</h2>
${renderArticles(payload.articles)}
<h2>The sector table</h2>
${renderSectors(payload, sectorOutcomes)}
<h2>Do the ticker calls beat the index?</h2>
${renderOutcomes(outcomes)}
<h2>Most-mentioned names</h2>
${renderTickers(payload.tickers)}
<h2>Every signal</h2>
${renderSignals(payload.signals)}
</body></html>`;
}

module.exports = {
  renderAsymReport,
};