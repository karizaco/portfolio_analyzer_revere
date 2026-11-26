'use strict';

/**
 * The Discord traders' dashboard.
 *
 * A self-contained HTML page: no CDN, no fonts, nothing fetched from the
 * network. A report that needs a network to render is a report that renders
 * blank on a plane.
 *
 * It is SELF-CONTAINED rather than built on `src/report/sourceDashboardShell.js`
 * because that module is not committed yet, and a report that depends on an
 * untracked file cannot be rebuilt from a clone.
 *
 * WHAT IT SHOWS, AND WHAT IT REFUSES TO SAY
 *
 * Every number here is MODELLED from daily closes. Neither trader publishes
 * fills, so nothing here is his P&L. The page says so in the header, and the
 * caveats sit next to the numbers they apply to rather than in a footnote.
 */

const CSS = `
  :root { --paper:#f4f1e9; --ink:#1e2829; --muted:#69716f; --rule:#d8d4c9; --panel:#fbfaf6; --accent:#2f6f6b; --up:#1d7a4c; --down:#a84234; }
  body { margin:0 auto; max-width:1400px; padding:2rem clamp(1rem,4vw,4rem) 5rem; background:var(--paper); color:var(--ink); font-family:Georgia,'Iowan Old Style',serif; }
  header.hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(13rem,20rem); gap:2rem; align-items:end; padding:1.4rem 0 1.8rem; border-top:5px solid var(--accent); border-bottom:1px solid var(--rule); }
  .kicker { margin:0 0 .5rem; color:var(--accent); font:700 .68rem/1.2 ui-monospace,Consolas,monospace; letter-spacing:.16em; }
  header.hero h1 { margin:.2rem 0 .45rem; font-size:clamp(2rem,4vw,3.6rem); letter-spacing:-.045em; }
  .description { max-width:56rem; color:var(--muted); font:1rem/1.55 Georgia,serif; }
  .meta { border-left:1px solid var(--rule); padding-left:1rem; color:var(--muted); font:.8rem/1.6 ui-monospace,Consolas,monospace; }
  .meta strong { display:block; color:var(--ink); font-size:.9rem; }
  nav { display:flex; flex-wrap:wrap; gap:1.2rem; border-bottom:1px solid var(--rule); margin:1.2rem 0 2rem; }
  nav a { padding:.7rem .1rem; color:var(--muted); text-decoration:none; font:700 .78rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.08em; border-bottom:2px solid transparent; }
  nav a:hover { color:var(--ink); border-color:var(--accent); }
  section { padding:1rem 0 2rem; border-bottom:1px solid var(--rule); }
  h2 { font-size:1.35rem; letter-spacing:-.02em; }
  h3 { font-size:1rem; margin:1.4rem 0 .5rem; }
  table { width:100%; border-collapse:collapse; margin:.8rem 0; font:.82rem/1.45 ui-monospace,Consolas,monospace; }
  th,td { text-align:right; padding:.42rem .55rem; border-bottom:1px solid var(--rule); font-variant-numeric:tabular-nums; }
  th:first-child,td:first-child { text-align:left; }
  thead th { color:var(--muted); font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; border-bottom:1px solid var(--ink); }
  tbody tr:hover { background:var(--panel); }
  .pill { display:inline-block; padding:.1rem .4rem; border:1px solid var(--rule); font-size:.68rem; }
  .up { color:var(--up); } .down { color:var(--down); }
  .note { color:var(--muted); font:.78rem/1.5 ui-monospace,Consolas,monospace; margin:.5rem 0 0; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:1px; background:var(--rule); border:1px solid var(--rule); margin:1rem 0; }
  .card { background:var(--panel); padding:.9rem; }
  .card span { display:block; color:var(--muted); font:.66rem ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:.06em; }
  .card strong { font-size:1.6rem; font-variant-numeric:tabular-nums; }
  .card small { color:var(--muted); font:.7rem ui-monospace,Consolas,monospace; display:block; }
  .caveat { border-left:3px solid var(--accent); padding:.5rem .9rem; background:var(--panel); margin:1rem 0; font:.82rem/1.55 Georgia,serif; }
  .bar { height:.5rem; background:var(--rule); position:relative; }
  .bar i { position:absolute; top:0; bottom:0; display:block; }
  @media(max-width:700px) { header.hero { grid-template-columns:1fr; } .meta { border-left:0; border-top:1px solid var(--rule); padding:1rem 0 0; } }
`;

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function num(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '&mdash;';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return escapeHtml(value);
  return parsed.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function pct(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '&mdash;';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return escapeHtml(value);
  const sign = parsed > 0 ? '+' : '';
  return `${sign}${parsed.toFixed(digits)}%`;
}

function signed(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '&mdash;';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return escapeHtml(value);
  const cls = parsed > 0 ? 'up' : parsed < 0 ? 'down' : '';
  return `<span class="${cls}">${pct(parsed, digits)}</span>`;
}

function card(label, value, note) {
  return `<div class="card"><span>${escapeHtml(label)}</span><strong>${value}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`;
}

function table(headers, rows) {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows.map((row) => {
    // A row is either an array of cells or a rendered <tr>.
    const cells = Array.isArray(row) ? row.map((cell) => `<td>${cell}</td>`).join('') : row;
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function summaryRow(label, value) {
  return [
    escapeHtml(label),
    value.closed ?? '&mdash;',
    value.same_day_trades ?? '&mdash;',
    value.still_open ?? '&mdash;',
    value.hit_rate_pct === null || value.hit_rate_pct === undefined ? '&mdash;' : `${num(value.hit_rate_pct, 1)}%`,
    value.avg_return_pct === null || value.avg_return_pct === undefined ? '&mdash;' : signed(value.avg_return_pct),
    value.winsorised_avg_return_pct === null || value.winsorised_avg_return_pct === undefined ? '&mdash;' : signed(value.winsorised_avg_return_pct),
    value.median_return_pct === null || value.median_return_pct === undefined ? '&mdash;' : signed(value.median_return_pct),
    value.avg_excess_pct === null || value.avg_excess_pct === undefined ? '&mdash;' : signed(value.avg_excess_pct),
    value.avg_holding_days === null || value.avg_holding_days === undefined ? '&mdash;' : num(value.avg_holding_days, 1),
  ];
}

/**
 * The name of a source, as the page shows it.
 *
 * @param {string} name
 * @returns {string}
 */
function sourceLabel(name) {
  const known = { plechac: 'Plechac' };
  if (known[name]) return known[name];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const SUMMARY_HEADERS = ['book', 'closed', 'same-day', 'open', 'hit rate', 'avg', 'avg (capped)', 'median', 'avg vs SPY', 'days held'];

/**
 * The dashboard.
 *
 * @param {object} payload  the analysis payload
 * @returns {string} the HTML page
 */
function renderDiscordReport(payload) {
  const sources = payload.sources || {};
  const rules = payload.rules || {};
  const coverage = payload.coverage || {};
  const curves = payload.curves || {};

  const sourceRows = [];
  sourceRows.push(summaryRow('Drendel &mdash; all episodes', sources.drendel ? sources.drendel.all : {}));
  if (sources.drendel && sources.drendel.trading_account) sourceRows.push(summaryRow('Drendel &mdash; trading account', sources.drendel.trading_account));
  if (sources.drendel && sources.drendel.vibe_account) sourceRows.push(summaryRow('Drendel &mdash; Vibe account', sources.drendel.vibe_account));
  sourceRows.push(summaryRow('Ariel &mdash; long book', sources['ariel-long'] ? sources['ariel-long'].all : {}));
  sourceRows.push(summaryRow('Ariel &mdash; short book', sources['ariel-short'] ? sources['ariel-short'].all : {}));
  // Every OTHER source, with its books. A source with its own parser --
  // plechac -- is not named in this file, so it is rendered from the
  // payload and the page grows without this file knowing its name.
  for (const [name, source] of Object.entries(sources)) {
    if (name === 'drendel' || name === 'ariel-long' || name === 'ariel-short') continue;
    const label = sourceLabel(name);
    sourceRows.push(summaryRow(`${label} &mdash; all episodes`, source.all || {}));
    for (const [account, summary] of Object.entries(source.by_account || {})) {
      sourceRows.push(summaryRow(`${label} &mdash; ${account} book`, summary));
    }
  }

  const accounts = payload.drendel_accounts || {};
  const tradingCurve = curves.trading_account || {};
  const vibeCurve = curves.vibe_account || {};

  const curveRows = [
    ['Trading account (weighted, as posted)', tradingCurve.periods, tradingCurve.cumulative_pct, tradingCurve.cumulative_excess_pct, tradingCurve.hit_rate_pct, tradingCurve.equal_weighted ? 'equal-weighted' : 'as posted'],
    ['Vibe account (no weights posted)', vibeCurve.periods, vibeCurve.cumulative_pct, vibeCurve.cumulative_excess_pct, vibeCurve.hit_rate_pct, vibeCurve.equal_weighted ? 'equal-weighted' : 'as posted'],
  ].map(([label, periods, cumulative, excess, hit, basis]) => `<tr><td>${escapeHtml(label)}</td><td>${periods ?? '&mdash;'}</td><td>${signed(cumulative)}</td><td>${signed(excess)}</td><td>${hit === null || hit === undefined ? '&mdash;' : `${num(hit, 1)}%`}</td><td>${escapeHtml(basis)}</td></tr>`);

  const atr = rules.atr_trim || {};
  const atrRows = [];
  for (const [book, measures] of Object.entries(atr.by_book || {})) {
    for (const [label, measure] of Object.entries(measures)) {
      if (!measure || !measure.n) continue;
      atrRows.push(`<tr><td>${escapeHtml(book)}</td><td>${escapeHtml(label.replace(/_/g, ' '))}</td><td>${measure.n}</td><td>${signed(measure.avg_forward_pct)}</td><td>${signed(measure.avg_trim_quality_pct)}</td><td>${measure.hit_rate_pct === null ? '&mdash;' : `${num(measure.hit_rate_pct, 1)}%`}</td></tr>`);
    }
  }

  const stop = rules.stop || {};
  const size = rules.size || {};
  const sizeRows = Object.entries(size).map(([bucket, measure]) => `<tr><td>${escapeHtml(bucket)}</td><td>${measure.n}</td><td>${signed(measure.avg_pct)}</td><td>${num(measure.hit_rate_pct, 1)}%</td></tr>`);

  const overlap = payload.overlap || {};
  const cross = payload.cross_source || {};

  // DAVID MONOSZON -- calls, not positions.
  //
  // He publishes no position list and no size, so he is not in the table
  // above: what he publishes are CALLS about indexes, sector ETFs and
  // commodities, and those are scored against the instrument's proxy.
  //
  // The block is OPTIONAL: the report renders without it, and the
  // analyze tool attaches it only when the file exists.
  const mono = payload.monoszon || null;
  const monoSection = mono ? renderMonoszonSection(mono) : '';

  // The POSTED books: a position list a trader posted himself, with the
  // weights he gave it. It is a different thing from an episode -- an
  // episode is priced, a snapshot is what the book looked like that day.
  const posted = payload.posted_books || {};
  const postedRows = [];
  for (const [name, book] of Object.entries(posted)) {
    for (const [account, detail] of Object.entries(book.by_account || {})) {
      if (!detail.positions) continue;
      postedRows.push(`<tr><td>${escapeHtml(sourceLabel(name))}</td>`
        + `<td>${escapeHtml(account || 'main')}</td>`
        + `<td>${detail.snapshots}</td>`
        + `<td>${escapeHtml(detail.latest_date || '')}</td>`
        + `<td>${detail.positions}</td>`
        + `<td>${detail.weight_sum_pct === null || detail.weight_sum_pct === undefined ? '&mdash;' : `${num(detail.weight_sum_pct, 2)} %`}</td>`
        + `<td>${escapeHtml((detail.top || []).slice(0, 6).map((row) => `${row.ticker} ${num(row.weight_pct, 1)}%`).join(', '))}</td></tr>`);
    }
  }
  const postedSection = postedRows.length ? `<section id="posted">
  <div class="section-heading"><p class="kicker">THE POSTED BOOKS</p><h2>What the book looked like, as posted</h2></div>
  <p class="description">A snapshot is a position list a trader posted himself. It is a different thing from an
    episode: an episode is priced from an entry and an exit, and a snapshot is what the book looked like on the day
    it was posted. The weights are the ones he gave, and the sum is reported so a reader can see whether the snapshot
    is whole &mdash; the broker's own table says 100&nbsp;%.</p>
  ${table(['source', 'book', 'snapshots', 'latest', 'holdings', 'weights', 'largest'], postedRows)}
</section>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord traders &mdash; drendel, ariel</title>
<style>${CSS}</style></head><body>
<header class="hero">
  <div>
    <p class="kicker">SOURCE RESEARCH / discord</p>
    <h1>Three Discord channels, two traders, and what their positions returned</h1>
    <p class="description">Two private trading channels carry a position history that is more precise than anything spoken:
      Drendel posts his whole book every day, with weights; Ariel posts her entries and exits as she makes them.
      Every number on this page is <strong>modelled from daily closes</strong> &mdash; neither trader publishes fills, so
      none of it is his or her P&amp;L.</p>
  </div>
  <aside class="meta">
    <span>Corpus</span><strong>${escapeHtml(payload.price_range ? `${payload.price_range.from} &rarr; ${payload.price_range.to}` : '')}</strong>
    <span>Messages parsed</span><strong>${num(coverage.actions, 0)}</strong>
    <span>Episodes</span><strong>${num(Object.values(sources).reduce((total, entry) => total + (entry.all ? entry.all.episodes : 0), 0), 0)}</strong>
    <span>Snapshots</span><strong>${num(coverage.snapshots, 0)}</strong>
    <span>Generated</span><strong>${escapeHtml(String(payload.generated_at || '').slice(0, 10))}</strong>
  </aside>
</header>
<nav>
  <a href="#books">the books</a><a href="#accounts">drendel's two accounts</a><a href="#rules">their rules</a>
  <a href="#together">the two traders</a>${postedRows.length ? '<a href="#posted">the posted books</a>' : ''}${mono ? '<a href="#monoszon">monoszon\'s calls</a>' : ''}<a href="#coverage">coverage &amp; caveats</a>
</nav>

<section id="books">
  <div class="section-heading"><p class="kicker">THE BOOKS</p><h2>What each book returned</h2></div>
  <div class="caveat">A trade opened and closed on the same day is invisible to a close-to-close model: it reads as a flat 0%.
    Those trades are counted separately (<em>same-day</em>) and left out of the hit rate. The still-open book is marked to
    the last close and is reported apart, because a mark-to-market over months is not a trade.</div>
  ${table(SUMMARY_HEADERS, sourceRows)}
  <p class="note">hit rate = trades held more than one day that closed positive, with a 95% Wilson interval in the JSON.
    <em>avg</em> is the mean return of a closed trade, signed; <em>avg (capped)</em> is the same mean with every trade
    clamped to &plusmn;100% (one long SOXL hold is +947% and it moves an average); <em>avg vs SPY</em> is the excess of
    the same window over SPY.</p>
</section>

<section id="accounts">
  <div class="section-heading"><p class="kicker">DRENDEL</p><h2>One trader, two accounts</h2></div>
  <p class="description">He trades one account and runs a second he calls <strong>Vibe</strong>. A position not listed under
    &ldquo;Vibe Account&rdquo; is in the trading account. The Vibe list carries no weights, so it is read as an
    equal-weighted, fully invested basket of the names he lists &mdash; and that assumption is the reason its numbers are
    not directly comparable with the trading account's.</p>
  <div class="cards">
    ${card('trading account', signed(tradingCurve.cumulative_pct), `${tradingCurve.periods ?? 0} periods, as posted`)}
    ${card('vibe account', signed(vibeCurve.cumulative_pct), `${vibeCurve.periods ?? 0} periods, equal-weighted`)}
    ${card('vibe vs SPY', signed(vibeCurve.cumulative_excess_pct), 'same windows')}
    ${card('shared names', num((accounts.trading && accounts.trading.shared_tickers) || 0, 0), 'vibe names also traded')}
  </div>
  ${table(['account', 'periods', 'cumulative', 'vs SPY', 'hit rate', 'basis'], curveRows)}
  <p class="note">A position that closed during a period contributes its move to the day it was closed, not to the period
    end and not nothing &mdash; dropping it would be a survivorship bias, because the positions that lose money are exactly
    the ones that disappear.</p>
</section>

<section id="rules">
  <div class="section-heading"><p class="kicker">THE RULES</p><h2>The rules they state, measured</h2></div>
  <h3>The ATR trim</h3>
  <p class="description">Ariel trims into strength and cites the multiple: &ldquo;trimming a piece of RKLB into the 7x ATR
    extension from the 50sma&rdquo;. ${num(atr.atr_cited, 0)} of her ${num(atr.trims_total, 0)} trims name an ATR multiple.
    The table reports the price's forward move and the <em>trim quality</em> &mdash; the same move signed by the book, so a
    good trim in the long book is a price that fell after it and a good cover in the short book is a price that rose.</p>
  ${table(['book', 'measure', 'n', 'forward', 'trim quality', 'hit rate'], atrRows)}
  <h3>The stop</h3>
  <div class="cards">
    ${card('with a stated stop', num(stop.with_a_stop, 0), 'entries')}
    ${card('stop breached before the exit', num(stop.breached_before_exit, 0), `${num(stop.breach_rate_pct, 1)}% of them`)}
    ${card('exited by a stop', num(stop.exited_by_stop, 0), 'of the stops')}
    ${card('avg return, breached', signed(stop.avg_return_when_breached), 'the trade that broke it')}
    ${card('avg return, held', signed(stop.avg_return_when_held), 'the trade that did not')}
  </div>
  <p class="note">The stop measured is the one stated at the entry. He also moves stops (&ldquo;moving stop to today's
    low&rdquo;), and a moved stop is not the one this measures &mdash; so the breach rate is an upper bound on how often his
    stated stop was not the operative one.</p>
  <h3>Size</h3>
  ${table(['position size', 'trades', 'avg return', 'hit rate'], sizeRows)}
  <p class="note">The weight is the position size he states on the entry. The biggest positions did the worst.</p>
</section>

<section id="together">
  <div class="section-heading"><p class="kicker">TOGETHER</p><h2>The two traders</h2></div>
  <div class="cards">
    ${card('shared names', num((overlap.shared || []).length, 0), 'held by both')}
    ${card('Ariel first', num((overlap.first_mover || {}).ariel, 0), 'earlier entry')}
    ${card('Drendel first', num((overlap.first_mover || {}).drendel, 0), 'earlier entry')}
    ${card('same day', num((overlap.first_mover || {}).same_day, 0), 'both entered')}
    ${card('trades matching a transcript call', num(cross.matched_trades, 0), `of ${num(cross.total_signals, 0)} signals`)}
  </div>
  ${(overlap.shared || []).length ? `<p class="note">shared names: ${escapeHtml((overlap.shared || []).join(', '))}</p>` : ''}
  <p class="note">A "matching call" is a trade whose ticker appears in a signal from another source within five days of the
    entry. It is a coincidence of names, not a claim that one source copied another.</p>
</section>

${postedSection}
${monoSection}

<section id="coverage">
  <div class="section-heading"><p class="kicker">COVERAGE</p><h2>What is measured, and what is not</h2></div>
  <table><tbody>
    <tr><td>messages parsed</td><td>${num(coverage.actions, 0)}</td></tr>
    <tr><td>actions with no ticker (kept, not counted)</td><td>${num(coverage.actions_without_ticker, 0)}</td></tr>
    <tr><td>tickers inherited from the previous message</td><td>${num(coverage.inferred_tickers, 0)}</td></tr>
    <tr><td>episodes with no price</td><td>${num(coverage.episodes_unpriced, 0)}</td></tr>
    <tr><td>Drendel snapshots</td><td>${num(coverage.snapshots, 0)}</td></tr>
  </tbody></table>
  <div class="caveat">
    <strong>What this page does not claim.</strong> The returns are modelled from daily closes, so an entry made on an
    intraday level is measured from that day's close &mdash; conservative about the entry and silent about the exit.
    Same-day trades are invisible. The Vibe account's weights are assumed equal. Drendel's trading-account &ldquo;Shorts&rdquo;
    are inverse instruments he BUYS, so they are signed as long positions; only a short of a real stock is signed negative.
    And nothing here is P&amp;L: no trader publishes fills.
  </div>
</section>
</body></html>`;
}

/**
 * David's calls, scored.
 *
 * @param {object} mono  the payload of `data/discord_monoszon.json`
 * @returns {string} the section's HTML
 */
function renderMonoszonSection(mono) {
  const overall = mono.overall || {};
  const week = (overall.same_call_on_spy || {})['1w'] || {};
  const month = (overall.same_call_on_spy || {})['1m'] || {};
  const coverage = mono.coverage || {};

  const subjectRows = Object.entries(mono.by_subject || {}).map(([subject, summary]) => {
    const w = (summary.same_call_on_spy || {})['1w'] || {};
    const m = (summary.same_call_on_spy || {})['1m'] || {};
    return `<tr><td>${escapeHtml(subject)}</td><td>${num(summary.claim_count, 0)}</td>`
      + `<td>${w.hit_rate === null || w.hit_rate === undefined ? '&mdash;' : `${num(w.hit_rate * 100, 1)}%`}</td>`
      + `<td>${w.n || 0}</td>`
      + `<td>${m.hit_rate === null || m.hit_rate === undefined ? '&mdash;' : `${num(m.hit_rate * 100, 1)}%`}</td>`
      + `<td>${w.mean_excess_aligned === null || w.mean_excess_aligned === undefined ? '&mdash;' : signed(w.mean_excess_aligned * 100)}</td></tr>`;
  });

  return `<section id="monoszon">
  <div class="section-heading"><p class="kicker">DAVID MONOSZON</p><h2>Calls about indexes, not positions</h2></div>
  <p class="description">A third Discord source, and a different KIND of source: he publishes no position list and no
    size &mdash; only &ldquo;mal&yacute; size&rdquo;, &ldquo;t&#345;etinov&yacute;m size&rdquo; &mdash; so there is nothing
    to price as a holding. What he publishes is a TAPE of calls about the index futures and the ETFs around them, and those
    are scored against the instrument: QQQ for the Nasdaq 100 future, SPY for the S&amp;P 500 future, GLD for gold.</p>
  <div class="cards">
    ${card('forward calls', num(overall.claim_count, 0), `of ${num(coverage.readings, 0)} readings`)}
    ${card('hit rate, 1 week', week.hit_rate === null || week.hit_rate === undefined ? '&mdash;' : `${num(week.hit_rate * 100, 1)}%`, `${num(week.n, 0)} scored`)}
    ${card('the same call on SPY', week.spy_same_call_hit_rate === null || week.spy_same_call_hit_rate === undefined ? '&mdash;' : `${num(week.spy_same_call_hit_rate * 100, 1)}%`, 'on the same dates')}
    ${card('edge vs SPY', week.edge_pp === null || week.edge_pp === undefined ? '&mdash;' : `${num(week.edge_pp, 1)} pp`, 'one week')}
  </div>
  ${table(['subject', 'calls', '1w hit', 'n', '1m hit', 'excess 1w'], subjectRows)}
  <p class="note">A reading is a call about the FUTURE. His retrospective calls (&ldquo;dnes byl krásn&yacute; long na
    GC&rdquo;) and the positions he holds right now (&ldquo;dnes uzav&iacute;r&aacute;m t&#345;etinu BTAL longu&rdquo;) are
    recorded and NOT scored: a fact has already had its move. The entry is the close on the day he wrote it &mdash; the level
    he names is kept with the call, but a limit level is not a fill, so it is not the entry. A call on the S&amp;P 500 future
    is scored on SPY, so its excess against SPY is zero by construction; the hit rate is the number that means something
    there.</p>
</section>`;
}

module.exports = { renderDiscordReport, renderMonoszonSection };
