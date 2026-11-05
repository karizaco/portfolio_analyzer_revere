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
      <div class="card"><div class="card-value">${payload.transcript_video_count || payload.video_count || 0}</div><div class="card-label">transcribed</div></div>
      <div class="card"><div class="card-value">${payload.unique_tickers || 0}</div><div class="card-label">tickers</div></div>
      <div class="card"><div class="card-value">${bullish}</div><div class="card-label">bullish</div></div>
      <div class="card"><div class="card-value">${bearish}</div><div class="card-label">bearish</div></div>
      <div class="card"><div class="card-value">${withPrice}</div><div class="card-label">with a price</div></div>
      <div class="card"><div class="card-value">${payload.setup_count || 0}</div><div class="card-label">setups</div></div>
      <div class="card"><div class="card-value">${(payload.setups || []).filter((setup) => setup.still_running).length}</div><div class="card-label">still running</div></div>
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
function formatPct(value, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  const pct = parsed <= 1 && parsed >= -1 ? parsed * 100 : parsed;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

/**
 * Visual overview: bias split, top names, stream activity, setup lifecycle.
 *
 * Pure inline SVG -- no CDN, no fetched chart library.
 *
 * @param {object} payload
 * @returns {string}
 */
function renderOverviewCharts(payload) {
  const signals = payload.signals || [];
  const tickers = payload.tickers || [];
  const daily = (payload.daily || []).filter((row) => Number(row.signal_count) > 0)
    .sort((a, b) => String(a.upload_date).localeCompare(String(b.upload_date)));
  const setups = payload.setups || [];
  if (!signals.length && !setups.length) return '';

  const bullish = signals.filter((s) => s.bias === 'bullish').length;
  const bearish = signals.filter((s) => s.bias === 'bearish').length;
  const mixed = signals.filter((s) => s.bias === 'mixed').length;
  const totalBias = Math.max(1, bullish + bearish + mixed);

  const top = tickers.slice(0, 10);
  const maxSignals = Math.max(1, ...top.map((row) => Number(row.signal_count) || 0));
  const topBars = top.map((row, index) => {
    const count = Number(row.signal_count) || 0;
    const width = Math.max(4, Math.round((count / maxSignals) * 100));
    const total = Number(row.bullish_count) + Number(row.bearish_count);
    const bullShare = total ? Math.round((Number(row.bullish_count) / total) * 100) : 50;
    return `<div class="hbar-row">
      <div class="hbar-label">${escapeHtml(row.ticker)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${width}%">
        <span class="hbar-split" style="width:${bullShare}%"></span>
      </div></div>
      <div class="hbar-val">${count}</div>
    </div>`;
  }).join('\n');

  const maxDaily = Math.max(1, ...daily.map((row) => Number(row.signal_count) || 0));
  const timeline = daily.map((row) => {
    const count = Number(row.signal_count) || 0;
    const height = Math.max(4, Math.round((count / maxDaily) * 72));
    const label = String(row.upload_date || '').slice(4);
    return `<div class="vbar" title="${escapeHtml(row.upload_date)}: ${count} signals">
      <div class="vbar-fill" style="height:${height}px"></div>
      <div class="vbar-label">${escapeHtml(label)}</div>
    </div>`;
  }).join('\n');

  const stateCounts = {};
  for (const setup of setups) {
    const state = setup.state || 'unknown';
    stateCounts[state] = (stateCounts[state] || 0) + 1;
  }
  const stateOrder = ['new', 'running', 'worked', 'failed', 'invalidated', 'old'];
  const stateRows = stateOrder
    .filter((state) => stateCounts[state])
    .map((state) => {
      const count = stateCounts[state];
      const width = Math.max(6, Math.round((count / Math.max(1, setups.length)) * 100));
      return `<div class="hbar-row">
        <div class="hbar-label">${escapeHtml(state)}</div>
        <div class="hbar-track"><div class="hbar-fill state-${escapeHtml(state)}" style="width:${width}%"></div></div>
        <div class="hbar-val">${count}</div>
      </div>`;
    }).join('\n');

  const bullPct = Math.round((bullish / totalBias) * 100);
  const bearPct = Math.round((bearish / totalBias) * 100);
  const mixPct = Math.max(0, 100 - bullPct - bearPct);

  return `
  <section class="overview">
    <div class="panel">
      <h3>Bias mix</h3>
      <div class="donut-wrap">
        <div class="donut" style="background: conic-gradient(var(--bull) 0 ${bullPct}%, var(--bear) ${bullPct}% ${bullPct + bearPct}%, var(--mix) ${bullPct + bearPct}% 100%)"></div>
        <div class="donut-legend">
          <div><span class="swatch bull"></span>bullish ${bullish} (${bullPct}%)</div>
          <div><span class="swatch bear"></span>bearish ${bearish} (${bearPct}%)</div>
          <div><span class="swatch mix"></span>mixed ${mixed} (${mixPct}%)</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>Most discussed names</h3>
      <div class="hbars">${topBars || '<p class="note">No tickers yet.</p>'}</div>
    </div>
    <div class="panel">
      <h3>Signals per stream</h3>
      <div class="vbars">${timeline || '<p class="note">No streams yet.</p>'}</div>
    </div>
    <div class="panel">
      <h3>Setup lifecycle now</h3>
      <div class="hbars">${stateRows || '<p class="note">No setups yet.</p>'}</div>
    </div>
  </section>`;
}

/**
 * Market outcome panel, when analyzeSevcikOutcomes has been run.
 *
 * @param {object} payload
 * @returns {string}
 */
function renderOutcomeSection(payload) {
  const summary = payload.outcome_summary;
  const outcomes = payload.outcomes || [];
  if (!summary || !outcomes.length) {
    return `
  <h2>Market check</h2>
  <p class="note">Not scored yet. Run <code>npm run sevcik:outcomes</code> to compare each
    directional signal with the Yahoo close 1 week and 1 month later.</p>`;
  }

  const cards = `
    <div class="cards">
      <div class="card"><div class="card-value">${summary.scored_1w || 0}</div><div class="card-label">scored 1w</div></div>
      <div class="card"><div class="card-value">${summary.hit_rate_1w == null ? '—' : formatPct(summary.hit_rate_1w, 0)}</div><div class="card-label">1w hit rate</div></div>
      <div class="card"><div class="card-value">${summary.baseline_hit_rate_1w == null ? '—' : formatPct(summary.baseline_hit_rate_1w, 0)}</div><div class="card-label">SPY 1w up-rate</div></div>
      <div class="card"><div class="card-value">${escapeHtml(summary.assessment_1w || '—')}</div><div class="card-label">1w assessment</div></div>
      <div class="card"><div class="card-value">${summary.avg_return_1w == null ? '—' : formatPct(summary.avg_return_1w, 1)}</div><div class="card-label">avg 1w return</div></div>
      <div class="card"><div class="card-value">${summary.scored_1m || 0}</div><div class="card-label">scored 1m</div></div>
      <div class="card"><div class="card-value">${summary.hit_rate_1m == null ? '—' : formatPct(summary.hit_rate_1m, 0)}</div><div class="card-label">1m hit rate</div></div>
      <div class="card"><div class="card-value">${summary.avg_return_1m == null ? '—' : formatPct(summary.avg_return_1m, 1)}</div><div class="card-label">avg 1m return</div></div>
    </div>
    <p class="note">Market check scores <strong>forward directional</strong> signals and setup predictions only (retrospective reviews like "predikce vyšla" are excluded). A hit means the price moved the same way as the bias (bullish &gt; 0, bearish &lt; 0).
      Horizons are calendar 7 / 30 days from the stream date, using the nearest Yahoo daily close.
      Horizons that have not elapsed yet are left blank. Missing prices: ${summary.missing_prices || 0}.</p>`;

  const retClass = (value) => {
    if (!Number.isFinite(Number(value))) return 'num';
    return Number(value) >= 0 ? 'num ret-pos' : 'num ret-neg';
  };
  const tickerRows = (summary.tickers || []).slice(0, 15).map((row) => `<tr>
    <td class="ticker">${escapeHtml(row.ticker)}</td>
    <td>${row.signals}</td>
    <td>${row.scored_1w || 0}</td>
    <td>${row.hit_rate_1w == null ? '—' : formatPct(row.hit_rate_1w, 0)}</td>
    <td class="${retClass(row.avg_return_1w)}">${row.avg_return_1w == null ? '—' : formatPct(row.avg_return_1w, 1)}</td>
    <td>${row.scored_1m || 0}</td>
    <td>${row.hit_rate_1m == null ? '—' : formatPct(row.hit_rate_1m, 0)}</td>
    <td class="${retClass(row.avg_return_1m)}">${row.avg_return_1m == null ? '—' : formatPct(row.avg_return_1m, 1)}</td>
  </tr>`).join('\n');

  const assessNote = summary.note
    ? `<p class="note">${escapeHtml(summary.note)}</p>`
    : '';
  const sourceLine = summary.by_source
    ? `<p class="note">sources: ${escapeHtml(JSON.stringify(summary.by_source))}</p>`
    : '';
  const recent = outcomes
    .filter((row) => row.hit_1w === true || row.hit_1w === false || row.hit_1m === true || row.hit_1m === false)
    .slice(0, 25)
    .map((row) => {
      const hit = (value) => {
        if (value === true) return '<span class="hit">hit</span>';
        if (value === false) return '<span class="miss">miss</span>';
        return '—';
      };
      const retClass = (value) => {
        if (!Number.isFinite(Number(value))) return 'num';
        return Number(value) >= 0 ? 'num ret-pos' : 'num ret-neg';
      };
      return `<tr>
        <td class="dim">${escapeHtml(row.upload_date || '')}</td>
        <td class="ticker">${escapeHtml(row.ticker)}</td>
        <td>${biasPill(row.bias)}</td>
        <td class="${retClass(row.return_1w)}">${row.return_1w == null ? '—' : formatPct(row.return_1w, 1)}</td>
        <td>${hit(row.hit_1w)}</td>
        <td class="${retClass(row.return_1m)}">${row.return_1m == null ? '—' : formatPct(row.return_1m, 1)}</td>
        <td>${hit(row.hit_1m)}</td>
      </tr>`;
    }).join('\n');

  return `
  <h2>Market check</h2>
  ${assessNote}
  ${sourceLine}
  ${cards}
  <h3 class="subhead">Outcomes by ticker</h3>
  <table class="grid">
    <thead><tr>
      <th>ticker</th><th>signals</th><th>n 1w</th><th>hit 1w</th><th>avg 1w</th>
      <th>n 1m</th><th>hit 1m</th><th>avg 1m</th>
    </tr></thead>
    <tbody>${tickerRows || '<tr><td colspan="8" class="note">No scored tickers.</td></tr>'}</tbody>
  </table>
  <h3 class="subhead">Recent scored claims</h3>
  <table class="grid">
    <thead><tr>
      <th>date</th><th>ticker</th><th>bias</th><th>1w</th><th>hit</th><th>1m</th><th>hit</th>
    </tr></thead>
    <tbody>${recent || '<tr><td colspan="7" class="note">No scored rows yet.</td></tr>'}</tbody>
  </table>`;
}

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
/**
 * The pill for a setup's STATE.
 *
 * The states are the LIFECYCLE of a setup, and they are not the same
 * thing as a direction: "worked" and "failed" are outcomes, and
 * "running" and "new" mean it is still live.
 *
 * @param {string} state
 * @returns {string}
 */
function claimKindPill(kind) {
  const label = escapeHtml(kind || 'forward');
  return `<span class="pill pill-kind-${label}">${label}</span>`;
}
function setupStatePill(state) {
  const map = {
    new: 'pill-setup-new',
    running: 'pill-setup-running',
    worked: 'pill-setup-worked',
    failed: 'pill-setup-failed',
    invalidated: 'pill-setup-invalidated',
    old: 'pill-setup-old',
  };
  const css = map[state] || 'pill-neutral';
  return `<span class="pill ${css}">${escapeHtml(state || '')}</span>`;
}

/**
 * The pill for a certainty LEVEL.
 *
 * @param {string} level
 * @returns {string}
 */
function certaintyPill(level) {
  const map = {
    certain: 'pill-cert-certain',
    high: 'pill-cert-high',
    conditional: 'pill-cert-conditional',
    even: 'pill-cert-even',
    low: 'pill-cert-low',
    unknown: 'pill-neutral',
  };
  const css = map[level] || 'pill-neutral';
  return `<span class="pill ${css}">${escapeHtml(level || '')}</span>`;
}

/**
 * The SETUPS table -- what the speaker was talking about.
 *
 * A setup is not a signal. The speaker does not disclose positions; he
 * describes setups and ideas, and this table is the record of which
 * ones he described, how certain he was, and what became of them.
 *
 * @param {Array<object>} setups
 * @returns {string}
 */
function renderSetupTable(setups) {
  if (!setups.length) {
    return '<p class="note">No setups yet.</p>';
  }
  const rows = setups.map((setup) => {
    const id = `setup-${Math.abs(hashCode(setup.video_id + setup.ticker + setup.evidence_text))}`;
    const states = String(setup.states || '').split(',').filter(Boolean);
    const flags = [];
    if (setup.direction_uncertain) flags.push('direction unknown');
    if (setup.probability !== '' && setup.probability !== null) flags.push(`${setup.probability}%`);
    if (setup.mentions > 1) flags.push(`${setup.mentions} mentions`);

    return `<tr class="sig" data-target="${id}">
      <td class="dim">${escapeHtml(setup.upload_date || '')}</td>
      <td class="ticker">${escapeHtml(setup.ticker)}</td>
      <td class="dim">${escapeHtml(setup.spoken_name || '')}</td>
      <td>${setupStatePill(setup.state)} ${claimKindPill(setup.claim_kind)}</td>
      <td>${certaintyPill(setup.certainty_level)}</td>
      <td class="dim">${escapeHtml(states.join(' → '))}</td>
      <td class="dim">${escapeHtml(flags.join(' · '))}</td>
    </tr>
    <tr class="evidence-row" id="${id}">
      <td colspan="7">${String(setup.evidence_text || '').split('\n').map((line) => `<blockquote>${escapeHtml(line)}</blockquote>`).join('')}</td>
    </tr>`;
  }).join('\n');

  return `<table class="grid">
    <thead><tr>
      <th>date</th><th>ticker</th><th>said as</th><th>state</th><th>certainty</th>
      <th>history</th><th>notes</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * The per-ticker SETUP table -- how this source has talked about each
 * name.
 *
 * @param {Array<object>} tickers
 * @returns {string}
 */
function renderSetupTickerTable(tickers) {
  if (!tickers.length) {
    return '<p class="note">No setups yet.</p>';
  }
  const rows = tickers.map((row) => `<tr>
    <td class="ticker">${escapeHtml(row.ticker)}</td>
    <td class="dim">${escapeHtml(row.spoken_name || '')}</td>
    <td>${row.setup_count}</td>
    <td>${row.video_count}</td>
    <td>${row.worked_count}</td>
    <td>${row.failed_count}</td>
    <td>${row.invalidated_count}</td>
    <td>${row.still_running_count}</td>
    <td>${num(row.avg_certainty)}</td>
    <td>${row.high_certainty_count}</td>
    <td>${row.conditional_count}</td>
    <td>${row.direction_uncertain_count}</td>
    <td class="dim">${escapeHtml(row.first_date || '')} → ${escapeHtml(row.last_date || '')}</td>
  </tr>`).join('\n');

  return `<table class="grid">
    <thead><tr>
      <th>ticker</th><th>said as</th><th>setups</th><th>videos</th><th>worked</th>
      <th>failed</th><th>invalid</th><th>running</th><th>avg cert</th><th>high</th>
      <th>cond</th><th>dir unk</th><th>dates</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


/**
 * Technical-analysis evaluation section (regimes, archetypes, R, walk-forward).
 * @param {object} payload
 * @returns {string}
 */
function renderTaSection(payload) {
  const summary = payload && (payload.ta_summary || payload);
  if (!summary || !summary.claim_count) {
    return `
    <h2>Technical analysis check</h2>
    <p class="note">No TA evaluation yet. Run <code>npm run sevcik:ta</code> after aggregate/outcomes to score
      event alignment, regimes, gap setups, archetypes, R-multiples and walk-forward folds.</p>`;
  }

  const row = (label, value) => `<div class="card"><div class="card-value">${value}</div><div class="card-label">${label}</div></div>`;
  const sc = summary.scorecards || {};
  const all = sc.all || summary;
  const cards = `
    <div class="cards">
      ${row('TA claims', summary.claim_count || 0)}
      ${row('1w hit', summary.hit_rate_1w == null ? '—' : formatPct(summary.hit_rate_1w, 0))}
      ${row('median R', summary.median_r == null ? '—' : Number(summary.median_r).toFixed(2))}
      ${row('avg R clip', summary.avg_r_clipped == null ? '—' : Number(summary.avg_r_clipped).toFixed(2))}
      ${row('avg R raw', summary.avg_r == null ? '—' : Number(summary.avg_r).toFixed(2))}
      ${row('gap real', summary.gap_real_n || 0)}
      ${row('gap fill 5d', summary.gap_fill_rate_5d == null ? '—' : formatPct(summary.gap_fill_rate_5d, 0))}
      ${row('deduped', summary.dedupe && summary.dedupe.primary_n != null ? summary.dedupe.primary_n : '—')}
      ${row('MTF mono', summary.mtf_monotonic_hit_rate == null ? '—' : (summary.mtf_monotonic_hit_rate ? 'yes' : 'no'))}
    </div>`;

  function tableFromGroups(title, groups) {
    const list = Array.isArray(groups) ? groups : [];
    if (!list.length) return `<h3 class="subhead">${escapeHtml(title)}</h3><p class="note">No rows.</p>`;
    const body = list.slice(0, 12).map((g) => `<tr>
      <td>${escapeHtml(g.key)}</td>
      <td>${g.n}</td>
      <td>${g.scored_1w}</td>
      <td>${g.hit_rate_1w == null ? '—' : formatPct(g.hit_rate_1w, 0)}</td>
      <td>${g.median_r == null ? '—' : Number(g.median_r).toFixed(2)}</td>
      <td>${g.avg_r_clipped == null ? (g.avg_r == null ? '—' : Number(g.avg_r).toFixed(2)) : Number(g.avg_r_clipped).toFixed(2)}</td>
      <td>${g.avg_aligned_return_1w == null ? '—' : formatPct(g.avg_aligned_return_1w, 1)}</td>
    </tr>`).join('');
    return `<h3 class="subhead">${escapeHtml(title)}</h3>
      <table class="grid">
        <thead><tr><th>bucket</th><th>n</th><th>n 1w</th><th>hit 1w</th><th>median R</th><th>avg R clip</th><th>avg aligned 1w</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function scorecardTable() {
    const entries = [
      ['all', sc.all || all],
      ['signals_only', sc.signals_only],
      ['setups_only', sc.setups_only],
      ['deduped_primary', sc.deduped_primary],
    ].filter(([, v]) => v);
    if (!entries.length) return '';
    const body = entries.map(([name, g]) => `<tr>
      <td>${escapeHtml(name)}</td>
      <td>${g.claim_count || 0}</td>
      <td>${g.scored_1w || 0}</td>
      <td>${g.hit_rate_1w == null ? '—' : formatPct(g.hit_rate_1w, 0)}</td>
      <td>${g.median_r == null ? '—' : Number(g.median_r).toFixed(2)}</td>
      <td>${g.avg_r_clipped == null ? '—' : Number(g.avg_r_clipped).toFixed(2)}</td>
      <td>${g.avg_r == null ? '—' : Number(g.avg_r).toFixed(2)}</td>
    </tr>`).join('');
    return `<h3 class="subhead">Scorecards</h3>
      <table class="grid">
        <thead><tr><th>card</th><th>n</th><th>n 1w</th><th>hit 1w</th><th>median R</th><th>avg R clip</th><th>avg R raw</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function edgeTable() {
    const em = summary.edge_matrix || {};
    const rows = [...(em.allow || []), ...(em.avoid || [])].slice(0, 12);
    if (!rows.length) {
      return `<h3 class="subhead">Edge matrix</h3><p class="note">No allow/avoid buckets yet (min N=${em.min_n || 8}). Thin buckets=${em.thin_count || 0}.</p>`;
    }
    const body = rows.map((g) => `<tr>
      <td>${escapeHtml(g.policy)}</td>
      <td>${escapeHtml(g.key)}</td>
      <td>${g.scored_1w}</td>
      <td>${g.hit_rate_1w == null ? '—' : formatPct(g.hit_rate_1w, 0)}</td>
      <td>${g.wilson_lo == null ? '—' : formatPct(g.wilson_lo, 0)}–${g.wilson_hi == null ? '—' : formatPct(g.wilson_hi, 0)}</td>
      <td>${g.median_r == null ? '—' : Number(g.median_r).toFixed(2)}</td>
    </tr>`).join('');
    return `<h3 class="subhead">Edge matrix (allow/avoid)</h3>
      <p class="note">${escapeHtml(em.note || '')} allow=${em.allow_count || 0}, avoid=${em.avoid_count || 0}, neutral=${em.neutral_count || 0}, thin=${em.thin_count || 0}.</p>
      <table class="grid">
        <thead><tr><th>policy</th><th>bucket</th><th>n 1w</th><th>hit</th><th>Wilson</th><th>median R</th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  const wf = summary.walk_forward || {};
  const edgePol = wf.edge_policy || {};
  const wfNote = `<p class="note">Walk-forward: folds=${wf.fold_count || 0}, avg test 1w hit=${wf.avg_test_hit_rate_1w == null ? '—' : formatPct(wf.avg_test_hit_rate_1w, 0)}, edge-selected OOS hit=${edgePol.avg_selected_hit_rate_1w == null ? '—' : formatPct(edgePol.avg_selected_hit_rate_1w, 0)}. ${escapeHtml(wf.note || '')}</p>`;
  const exit = summary.exit_mix || {};
  const exitNote = `<p class="note">Exit mix: stop=${exit.stop || 0}, target=${exit.target || 0}, time=${exit.time || 0}. Gap talk=${summary.gap_talk_n || 0}, real gaps=${summary.gap_real_n || 0}, linguistic gap setups=${summary.gap_linguistic_n || summary.gap_confirmed_n || 0}.</p>`;

  return `
    <h2>Technical analysis check</h2>
    ${cards}
    <p class="note">Executable date is the next regular session after the stream (venue calendar; weekends/holidays skipped). Features use bars through the prior close. R-sim uses next open, ATR×1.5 stop with structure widen + 1–8% floor/cap, 2R target, max 20 bars. Primary scorecards use median/clipped R.</p>
    ${exitNote}
    ${scorecardTable()}
    ${tableFromGroups('By trend regime', summary.by_trend_regime)}
    ${tableFromGroups('By volatility regime', summary.by_vol_regime)}
    ${tableFromGroups('By archetype', summary.by_archetype)}
    ${tableFromGroups('By MTF confirmation', summary.by_mtf_label)}
    ${tableFromGroups('By source', summary.by_source)}
    ${edgeTable()}
    ${wfNote}`;
}

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
  .pill-setup-new { background: rgba(76,141,255,.18); color: #7fb0ff; }
  .pill-setup-running { background: rgba(185,138,46,.18); color: #e6bb5c; }
  .pill-setup-worked { background: rgba(46,163,106,.18); color: #4fd694; }
  .pill-setup-failed { background: rgba(209,72,63,.18); color: #ff8a80; }
  .pill-setup-invalidated { background: rgba(140,90,200,.2); color: #c4a2f0; }
  .pill-setup-old { background: rgba(139,147,167,.16); color: var(--dim); }
  .pill-cert-certain { background: rgba(46,163,106,.22); color: #4fd694; }
  .pill-cert-high { background: rgba(76,141,255,.18); color: #7fb0ff; }
  .pill-cert-conditional { background: rgba(185,138,46,.18); color: #e6bb5c; }
  .pill-cert-even { background: rgba(140,90,200,.16); color: #c4a2f0; }
  .pill-cert-low { background: rgba(139,147,167,.16); color: var(--dim); }
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
  .overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 18px 0 8px; }
  @media (max-width: 980px) { .overview { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .panel h3 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: .7px; color: var(--dim); }
  .subhead { margin: 18px 0 8px; font-size: 13px; color: var(--dim); text-transform: uppercase; letter-spacing: .6px; }
  .donut-wrap { display: flex; gap: 18px; align-items: center; }
  .donut { width: 120px; height: 120px; border-radius: 50%; position: relative; flex: 0 0 auto; }
  .donut::after { content: ""; position: absolute; inset: 28px; background: var(--panel); border-radius: 50%; }
  .donut-legend { font-size: 13px; line-height: 1.8; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 8px; }
  .swatch.bull { background: var(--bull); }
  .swatch.bear { background: var(--bear); }
  .swatch.mix { background: var(--mix); }
  .hbars { display: flex; flex-direction: column; gap: 8px; }
  .hbar-row { display: grid; grid-template-columns: 64px 1fr 36px; gap: 8px; align-items: center; }
  .hbar-label { font-weight: 600; font-size: 12px; }
  .hbar-track { height: 10px; background: #10131a; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
  .hbar-fill { height: 100%; background: linear-gradient(90deg, #3d6fd4, #6ea0ff); position: relative; }
  .hbar-fill .hbar-split { display: block; height: 100%; background: var(--bull); }
  .hbar-fill.state-running { background: var(--mix); }
  .hbar-fill.state-worked, .hbar-fill.state-new { background: var(--bull); }
  .hbar-fill.state-failed, .hbar-fill.state-invalidated { background: var(--bear); }
  .hbar-fill.state-old { background: #6b7286; }
  .hbar-val { text-align: right; font-variant-numeric: tabular-nums; color: var(--dim); font-size: 12px; }
  .vbars { display: flex; align-items: flex-end; gap: 6px; min-height: 110px; overflow-x: auto; padding-bottom: 4px; }
  .vbar { flex: 0 0 28px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
  .vbar-fill { width: 16px; border-radius: 4px 4px 2px 2px; background: linear-gradient(180deg, #7fb0ff, #3d6fd4); }
  .vbar-label { font-size: 10px; color: var(--dim); writing-mode: horizontal-tb; }
  code { background: #10131a; padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
  .pill-kind-forward { background: rgba(76,141,255,.18); color: #7fb0ff; }
  .pill-kind-retrospective { background: rgba(139,147,167,.16); color: var(--dim); }
  .hit { color: #4fd694; font-weight: 600; }
  .miss { color: #ff8a80; font-weight: 600; }
  .ret-pos { color: #4fd694; }
  .ret-neg { color: #ff8a80; }
</style>
</head>
<body>
<header>
  <h1>Sevcik prediction signals</h1>
  <div class="sub">Transcript calls, setup lifecycle, and optional market cross-check. Click a row for the source wording.</div>
</header>
<main>
  ${renderHeadline(payload)}
  ${payload.signal_count === 0
    ? '<div class="warn">No signals have been extracted yet. Run the transcript fetcher and the signal extractor first.</div>'
    : ''}
  ${renderOverviewCharts(payload)}
  ${renderOutcomeSection(payload)}
  ${renderTaSection(payload)}
  <h2>Setups by ticker</h2>
  ${renderSetupTickerTable(payload.setup_tickers || [])}
  <h2>Setups</h2>
  ${renderSetupTable(payload.setups || [])}
  <h2>Signals by ticker</h2>
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

