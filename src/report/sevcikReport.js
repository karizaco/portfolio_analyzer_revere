'use strict';

// The Sevcik dashboard.
//
// WHY A SELF-CONTAINED HTML FILE
//
// The project's other reports are CSVs, because their consumers are
// spreadsheets and other tools. This one is for a human, and it is one file
// with no external dependencies: no CDN, no fonts, no scripts fetched from
// the network. A report that needs a network to render is a report that
// renders blank on a plane, and the whole point of a dashboard is that it
// can be opened.
//
// WHAT IT SHOWS
//
//   the headline numbers   how many signals, over how many streams
//   the ticker table       what has been said about each name, and how
//                          strongly
//   the bias balance       bullish against bearish, per ticker
//   the daily timeline    what each stream contained
//   the signal list       every signal WITH ITS EVIDENCE
//
// The evidence is not a footnote. Every signal row can be expanded to the
// exact transcript text it was read from, because a signal that cannot be
// checked against its source is a claim, and the dashboard's value is that
// the claims are checkable.
//
// The HTML is generated from the same payload the JSON carries, so the two
// can never disagree.

/**
 * Escape text for HTML.
 *
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
 * A number, or an em dash when there is none.
 *
 * @param {unknown} value
 * @param {number} [digits]
 * @returns {string}
 */
function num(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  return parsed.toFixed(digits).replace(/\.?0+$/, (match) => (match.includes('.') ? '' : match));
}

/**
 * A bias pill.
 *
 * @param {string} bias
 * @returns {string}
 */
function biasPill(bias) {
  const label = escapeHtml(bias || 'neutral');
  return `<span class="pill pill-${label}">${label}</span>`;
}

/**
 * A confidence pill.
 *
 * @param {string} label
 * @returns {string}
 */
function confidencePill(label) {
  const safe = escapeHtml(label || '');
  return `<span class="pill pill-conf-${safe}">${safe}</span>`;
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
  const withPrice = signals.filter((signal) => signal.entry_price !== '' || signal.target_price_low !== '').length;
  const providers = {};
  for (const signal of signals) {
    if (signal.provider) providers[signal.provider] = (providers[signal.provider] || 0) + 1;
  }
  const providerText = Object.entries(providers)
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ') || 'none';

  return `
    <div class="cards">
      <div class="card"><div class="card-value">${payload.signal_count || 0}</div><div class="card-label">signals</div></div>
      <div class="card"><div class="card-value">${payload.video_count || 0}</div><div class="card-label">streams</div></div>
      <div class="card"><div class="card-value">${payload.unique_tickers || 0}</div><div class="card-label">tickers</div></div>
      <div class="card"><div class="card-value">${bullish}</div><div class="card-label">bullish</div></div>
      <div class="card"><div class="card-value">${bearish}</div><div class="card-label">bearish</div></div>
      <div class="card"><div class="card-value">${withPrice}</div><div class="card-label">with a price</div></div>
    </div>
    <p class="note">Transcript providers in use: ${escapeHtml(providerText)}.
      Generated ${escapeHtml(payload.generated_at || '')}.</p>`;
}

/**
 * The per-ticker table.
 *
 * @param {Array<object>} tickers
 * @returns {string}
 */
function renderTickerTable(tickers) {
  if (!tickers.length) {
    return '<p class="note">No signals yet.</p>';
  }
  const rows = tickers.map((row) => {
    const total = Number(row.bullish_count) + Number(row.bearish_count);
    const ratio = total ? Math.round((Number(row.bullish_count) / total) * 100) : null;
    const bar = ratio === null
      ? '<span class="note">—</span>'
      : `<span class="bar"><span class="bar-bull" style="width:${ratio}%"></span>`
        + `<span class="bar-bear" style="width:${100 - ratio}%"></span></span>`
        + `<span class="bar-label">${ratio}% bull</span>`;
    return `<tr>
      <td class="ticker">${escapeHtml(row.ticker)}</td>
      <td>${row.signal_count}</td>
      <td>${row.video_count}</td>
      <td>${bar}</td>
      <td>${num(row.avg_confidence)}</td>
      <td>${row.high_confidence_count}</td>
      <td>${row.signals_with_entry}</td>
      <td>${row.signals_with_target}</td>
      <td>${num(row.avg_entry_price)}</td>
      <td>${num(row.avg_target_price)}</td>
      <td class="dim">${escapeHtml(row.first_date || '')} → ${escapeHtml(row.last_date || '')}</td>
    </tr>`;
  }).join('\n');

  return `<table class="grid">
    <thead><tr>
      <th>ticker</th><th>signals</th><th>videos</th><th>bias</th><th>avg conf</th>
      <th>high</th><th>entries</th><th>targets</th><th>avg entry</th><th>avg target</th><th>dates</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The per-stream table.
 *
 * @param {Array<object>} daily
 * @returns {string}
 */
function renderDailyTable(daily) {
  if (!daily.length) {
    return '<p class="note">No streams yet.</p>';
  }
  const rows = daily.map((row) => `<tr>
    <td class="dim">${escapeHtml(row.upload_date || '')}</td>
    <td>${escapeHtml(row.provider || '')}</td>
    <td>${row.signal_count}</td>
    <td>${row.bullish_count}</td>
    <td>${row.bearish_count}</td>
    <td>${num(row.avg_confidence)}</td>
    <td class="dim tickers">${escapeHtml(row.tickers || '')}</td>
  </tr>`).join('\n');

  return `<table class="grid">
    <thead><tr>
      <th>date</th><th>provider</th><th>signals</th><th>bull</th><th>bear</th>
      <th>avg conf</th><th>tickers</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * Every signal, with its evidence.
 *
 * @param {Array<object>} signals
 * @returns {string}
 */
function renderSignalList(signals) {
  if (!signals.length) {
    return '<p class="note">No signals yet.</p>';
  }
  const rows = signals.map((signal) => {
    const id = `sig-${Math.abs(hashCode(signal.video_id + signal.ticker + signal.event_time_sec + signal.evidence_text))}`;
    const prices = [
      signal.entry_price !== '' && signal.entry_price !== null ? `entry ${num(signal.entry_price)}` : '',
      signal.target_price_low !== '' && signal.target_price_low !== null
        ? `target ${num(signal.target_price_low)}${signal.target_price_high !== '' && Number(signal.target_price_high) !== Number(signal.target_price_low) ? `–${num(signal.target_price_high)}` : ''}`
        : '',
      signal.stop_price !== '' && signal.stop_price !== null ? `stop ${num(signal.stop_price)}` : '',
    ].filter(Boolean).join(' · ');

    return `<tr class="sig" data-target="${id}">
      <td class="dim">${escapeHtml(signal.upload_date || '')}</td>
      <td class="ticker">${escapeHtml(signal.ticker)}</td>
      <td>${biasPill(signal.bias)}</td>
      <td>${escapeHtml(signal.action || '—')}</td>
      <td>${confidencePill(signal.confidence_label)}</td>
      <td class="num">${num(signal.confidence_score)}</td>
      <td class="num">${escapeHtml(prices || '—')}</td>
      <td class="dim">${escapeHtml(signal.horizon_text || '')}</td>
    </tr>
    <tr class="evidence-row" id="${id}"><td colspan="8">
      <blockquote>${escapeHtml(signal.evidence_text)}</blockquote>
      <div class="dim">${escapeHtml(signal.video_id)} · ${escapeHtml(signal.provider || '')}
        · parser ${escapeHtml(signal.parser_version || '')}
        ${signal.event_time_sec !== '' ? ` · ${formatTime(signal.event_time_sec)}` : ''}</div>
    </td></tr>`;
  }).join('\n');

  return `<table class="grid signals">
    <thead><tr>
      <th>date</th><th>ticker</th><th>bias</th><th>action</th><th>conf</th>
      <th>score</th><th>prices</th><th>horizon</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * A stable hash, for the evidence row ids.
 *
 * @param {string} value
 * @returns {number}
 */
function hashCode(value) {
  let hash = 0;
  const str = String(value || '');
  for (let index = 0; index < str.length; index += 1) {
    hash = ((hash << 5) - hash) + str.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

/**
 * Seconds as a timestamp.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * The whole dashboard.
 *
 * @param {object} payload
 * @returns {string}
 */
function buildSevcikReportHtml(payload) {
  const signals = payload.signals || [];
  const tickers = payload.tickers || [];
  const daily = payload.daily || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sevcik prediction signals</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36; --text: #e6e8ee;
    --dim: #8b93a7; --bull: #2ea36a; --bear: #d1483f; --mix: #b98a2e;
    --accent: #4c8dff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header { padding: 24px 28px 8px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .2px; }
  h2 { margin: 28px 0 10px; font-size: 15px; text-transform: uppercase; letter-spacing: .8px; color: var(--dim); }
  .sub { color: var(--dim); font-size: 13px; }
  main { padding: 18px 28px 60px; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 6px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; min-width: 108px; }
  .card-value { font-size: 24px; font-weight: 600; }
  .card-label { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .note { color: var(--dim); font-size: 12px; }
  table.grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  table.grid th, table.grid td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.grid th { color: var(--dim); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  table.grid tr:last-child td { border-bottom: none; }
  td.ticker { font-weight: 700; letter-spacing: .4px; }
  td.dim, .dim { color: var(--dim); }
  td.num { font-variant-numeric: tabular-nums; }
  td.tickers { font-size: 12px; max-width: 520px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
  .pill-bullish { background: rgba(46,163,106,.18); color: #4fd694; }
  .pill-bearish { background: rgba(209,72,63,.18); color: #ff8a80; }
  .pill-mixed { background: rgba(185,138,46,.18); color: #e6bb5c; }
  .pill-neutral { background: rgba(139,147,167,.16); color: var(--dim); }
  .pill-conf-high { background: rgba(76,141,255,.18); color: #7fb0ff; }
  .pill-conf-medium { background: rgba(139,147,167,.16); color: var(--dim); }
  .pill-conf-low { background: rgba(139,147,167,.1); color: #6b7286; }
  .bar { display: inline-block; width: 110px; height: 7px; border-radius: 4px; overflow: hidden; background: var(--bear); vertical-align: middle; }
  .bar-bull { display: inline-block; height: 100%; background: var(--bull); }
  .bar-bear { display: inline-block; height: 100%; background: var(--bear); }
  .bar-label { margin-left: 6px; font-size: 11px; color: var(--dim); }
  tr.evidence-row { display: none; }
  tr.evidence-row.open { display: table-row; }
  tr.evidence-row td { background: #12151c; }
  blockquote { margin: 0 0 6px; padding: 8px 12px; border-left: 2px solid var(--accent); background: #10131a; color: #cdd3e0; font-style: normal; }
  tr.sig { cursor: pointer; }
  tr.sig:hover td { background: #1b1f28; }
  .warn { border-left: 3px solid var(--bear); padding: 10px 14px; background: rgba(209,72,63,.08); color: #ffb4ab; border-radius: 6px; margin: 14px 0; }
</style>
</head>
<body>
<header>
  <h1>Sevcik prediction signals</h1>
  <div class="sub">Extracted from stream transcripts. Every signal carries the transcript text it was read from.</div>
</header>
<main>
  ${renderHeadline(payload)}
  ${payload.signal_count === 0
    ? '<div class="warn">No signals have been extracted yet. Run the transcript fetcher and the signal extractor first.</div>'
    : ''}
  <h2>Tickers</h2>
  ${renderTickerTable(tickers)}
  <h2>Streams</h2>
  ${renderDailyTable(daily)}
  <h2>Signals</h2>
  ${renderSignalList(signals)}
</main>
<script>
  // Clicking a signal row reveals the transcript text it came from.
  document.querySelectorAll('tr.sig').forEach(function (row) {
    row.addEventListener('click', function () {
      var target = document.getElementById(row.getAttribute('data-target'));
      if (target) target.classList.toggle('open');
    });
  });
</script>
</body>
</html>`;
}

module.exports = {
  buildSevcikReportHtml,
  escapeHtml,
  formatTime,
};
