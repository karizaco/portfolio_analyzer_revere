'use strict';

/**
 * Measure the ENTRY RULE: what a forward claim is worth under different
 * entry prices.
 *
 * WHAT THIS IS FOR
 *
 * Every forward claim in this project is entered at one price -- the close
 * on the day the claim was made -- and that rule has never been measured
 * against an alternative. Three sources document a bias in it from their
 * own side: Martin Klass's calls are published after the news that moved
 * the name, Monoszon's retrospective calls are excluded because "the price
 * has already moved", and HariSeldon is an intraday trader whose same-day
 * trades a close-to-close model cannot see at all.
 *
 * So this tool asks the question the whole corpus turns on: is the
 * "these sources do not beat the index" finding a fact about the sources,
 * or a fact about the entry price?
 *
 * WHAT IT MEASURES
 *
 * For every forward claim of every source, under every entry rule:
 *
 *   n          how many claims were scored
 *   hit        the direction was right
 *   spy        the SAME call on SPY, under the SAME rule
 *   excess     the aligned return minus SPY's aligned return
 *
 * The exit never moves: it is the close on the CLAIM date plus the
 * horizon, in every rule. Only the entry changes, so the comparison
 * isolates the entry.
 *
 * THE VALIDATION IS THE POINT, AND IT IS LIKE-FOR-LIKE
 *
 * The `close_d0` rule IS the shipped rule, so this tool recomputes every
 * published number. The validation compares the two on the rows BOTH
 * scored, because "did my recomputation reproduce the published number?"
 * is a question about the rows both have -- and the rows only one of them
 * could score are a PRICE-DATA question, reported separately.
 *
 *   node tools/measureEntryRule.js
 *   node tools/measureEntryRule.js --json
 *   node tools/measureEntryRule.js --source monoszon
 */

const fs = require('node:fs');
const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const {
  adjustedBar, allRules, entryForRule, exitPrice, horizonElapsed, resolveBars,
} = require('../src/analysis/entryRule');
const { fundedmindPriceSymbolFor } = require('../src/fundedmind/priceSymbols');
const { parseCsvRecords } = require('../src/io/readCsv');
const { shiftIsoDate, toIsoDate } = require('../src/sevcik/outcomeAnalysis');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const OUTPUT_PATH = path.join(DATA_DIR, 'entry_rule_measurement.json');

const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;
const BENCHMARK = 'SPY';

/**
 * The claim sets, and where each one's rows live.
 *
 * Every one of them is a CSV of per-claim outcomes, and every one of them
 * carries the same three things the instrument needs: the claim's date,
 * the instrument, and the direction.
 *
 * `resolveSymbol` is the SOURCE's own translation, where it has one.
 * FundedMind's speakers name CFD shorthand ("XAUUSD", "NAS100",
 * "USOIL") and the source translates it in
 * `src/fundedmind/priceSymbols.js` -- so the instrument uses that
 * translation rather than inventing one, because a source's vocabulary
 * belongs to the source.
 */
const CLAIM_SETS = [
  { id: 'sevcik', file: 'sevcik_outcomes.csv', label: 'Sevcik (Czech streams)' },
  { id: 't3live', file: 't3live_outcomes.csv', label: 'T3Live' },
  { id: 'benzinga-signals', file: 'benzinga_outcomes.csv', label: 'Benzinga (signals)' },
  { id: 'benzinga-readings', file: 'benzinga_reading_outcomes.csv', label: 'Benzinga (readings)' },
  { id: 'asym', file: 'asym_outcomes.csv', label: 'AsymTrading' },
  { id: 'komar', file: 'komar_outcomes.csv', label: 'Komar' },
  {
    id: 'fundedmind',
    file: 'fundedmind_outcomes.csv',
    label: 'FundedMind',
    resolveSymbol: fundedmindPriceSymbolFor,
  },
  { id: 'monoszon', file: 'discord_monoszon_outcomes.csv', label: 'David Monoszon' },
  { id: 'martinklass', file: 'discord_martinklass_outcomes.csv', label: 'Martin Klass' },
];

const options = {
  json: process.argv.includes('--json'),
  source: (() => {
    const index = process.argv.indexOf('--source');
    return index >= 0 ? process.argv[index + 1] : '';
  })(),
};

/**
 * Read a CSV into objects.
 *
 * The reader is the SHARED one (`src/io/readCsv.js`), and that matters
 * here for a measured reason: the `evidence_text` column of the outcome
 * CSVs carries the raw transcript of a claim, and those transcripts
 * contain line breaks -- so a record is NOT a line, and a line-based
 * reader silently shifts every column after the evidence. On
 * `data/sevcik_outcomes.csv` a line-based reader failed to parse 10,324
 * of 10,324 rows.
 *
 * @param {string} file  the file name inside data/
 * @returns {{rows: object[], skipped: number}}
 */
function readCsv(file) {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return { rows: [], skipped: 0 };
  const records = parseCsvRecords(fs.readFileSync(full, 'utf8'));
  if (!records.length) return { rows: [], skipped: 0 };
  const header = records[0];
  const rows = [];
  let skipped = 0;
  for (const values of records.slice(1)) {
    if (values.length !== header.length) { skipped += 1; continue; }
    const row = {};
    header.forEach((name, index) => { row[name] = values[index]; });
    rows.push(row);
  }
  return { rows, skipped };
}

/**
 * Is this cell a published hit, a published miss, or neither?
 *
 * The published CSVs write the hit as `1`/`0` in some sources and as
 * `true`/`false` in others, and a row the source could not score is an
 * EMPTY cell. All three are read here, because the validation is only
 * worth anything if it reads what the sources actually wrote.
 *
 * @param {string} cell
 * @returns {boolean|null} the published verdict
 */
function publishedVerdict(cell) {
  const value = String(cell === undefined || cell === null ? '' : cell).trim().toLowerCase();
  if (value === '' || value === 'null' || value === 'undefined') return null;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
}

/**
 * The claims of one set: the date, the instrument and the direction.
 *
 * Only FORWARD claims with a direction count. A reported or retrospective
 * claim is about something that has already happened and is not scored by
 * any source.
 *
 * @param {object[]} rows
 * @param {object} set  the claim set
 * @returns {object[]}
 */
function claimsFrom(rows, set) {
  const out = [];
  for (const row of rows) {
    if (row.claim_kind && row.claim_kind !== 'forward') continue;
    const bias = String(row.bias || '').toLowerCase();
    if (bias !== 'bullish' && bias !== 'bearish') continue;
    const date = toIsoDate(row.event_date || row.as_of_date || row.upload_date || '');
    const rawSymbol = String(row.yahoo_symbol || row.proxy_ticker || row.ticker || '').trim();
    if (!date || !rawSymbol) continue;
    const symbol = set.resolveSymbol ? set.resolveSymbol(rawSymbol) : rawSymbol;
    out.push({
      date,
      symbol,
      rawSymbol,
      bias,
      published: publishedVerdict(row.hit_1w),
    });
  }
  return out;
}

/**
 * Run a bounded number of tasks at once.
 *
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} limit
 * @returns {Promise<any[]>}
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Did the market move the way the claim said?
 *
 * @param {string} bias
 * @param {number|null} ret
 * @returns {boolean|null}
 */
function directionHit(bias, ret) {
  if (!Number.isFinite(ret)) return null;
  if (bias === 'bullish') return ret > 0;
  if (bias === 'bearish') return ret < 0;
  return null;
}

/**
 * Score one claim under one rule, and the same call on the benchmark.
 *
 * @param {object} claim
 * @param {object[]} symbolBars
 * @param {object[]} spyBars
 * @param {object} rule
 * @param {string} asOfDate
 * @returns {object} the scored row, or the reason it did not score
 */
function scoreClaim(claim, symbolBars, spyBars, rule, asOfDate) {
  const bars = resolveBars(symbolBars, claim.date);
  const entry = entryForRule(rule, bars, claim.bias);
  if (!Number.isFinite(entry.entry)) return { status: entry.status };

  // A horizon that has not ELAPSED has no exit. Taking "the last close
  // so far" as one would measure a partial window and report it as a
  // full one.
  const weekElapsed = horizonElapsed(claim.date, HORIZON_1W_DAYS, asOfDate);
  const monthElapsed = horizonElapsed(claim.date, HORIZON_1M_DAYS, asOfDate);

  const exit1w = weekElapsed ? exitPrice(symbolBars, claim.date, HORIZON_1W_DAYS) : null;
  const exit1m = monthElapsed ? exitPrice(symbolBars, claim.date, HORIZON_1M_DAYS) : null;

  const spyResolved = resolveBars(spyBars, claim.date);
  const spyEntry = entryForRule(rule, spyResolved, claim.bias);
  const spyExit1w = weekElapsed ? exitPrice(spyBars, claim.date, HORIZON_1W_DAYS) : null;
  const spyExit1m = monthElapsed ? exitPrice(spyBars, claim.date, HORIZON_1M_DAYS) : null;

  const sign = claim.bias === 'bullish' ? 1 : -1;
  const ret1w = Number.isFinite(exit1w) && exit1w !== 0 ? (exit1w - entry.entry) / entry.entry : null;
  const ret1m = Number.isFinite(exit1m) && exit1m !== 0 ? (exit1m - entry.entry) / entry.entry : null;
  const spyRet1w = Number.isFinite(spyEntry.entry) && Number.isFinite(spyExit1w) && spyExit1w !== 0
    ? (spyExit1w - spyEntry.entry) / spyEntry.entry : null;
  const spyRet1m = Number.isFinite(spyEntry.entry) && Number.isFinite(spyExit1m) && spyExit1m !== 0
    ? (spyExit1m - spyEntry.entry) / spyEntry.entry : null;

  return {
    status: 'ok',
    entry: entry.entry,
    hit_1w: directionHit(claim.bias, ret1w),
    hit_1m: directionHit(claim.bias, ret1m),
    aligned_1w: Number.isFinite(ret1w) ? sign * ret1w : null,
    aligned_1m: Number.isFinite(ret1m) ? sign * ret1m : null,
    spy_hit_1w: directionHit(claim.bias, spyRet1w),
    spy_hit_1m: directionHit(claim.bias, spyRet1m),
    spy_aligned_1w: Number.isFinite(spyRet1w) ? sign * spyRet1w : null,
    spy_aligned_1m: Number.isFinite(spyRet1m) ? sign * spyRet1m : null,
    excess_1w: Number.isFinite(ret1w) && Number.isFinite(spyRet1w) ? sign * (ret1w - spyRet1w) : null,
    excess_1m: Number.isFinite(ret1m) && Number.isFinite(spyRet1m) ? sign * (ret1m - spyRet1m) : null,
  };
}

/**
 * The summary of one (source, rule) pair.
 *
 * THE TWO DENOMINATORS ARE THE SAME SET, AND THAT MATTERS
 *
 * A rule can produce a trade for the claim and NO trade for the
 * benchmark: a limit 1 % better than the signal close fills for one
 * name and not for SPY. When the benchmark did not trade, it did not
 * LOSE -- and counting it as a loss would hand the claim an edge it did
 * not earn.
 *
 * That is not a hypothetical. Measured on the limit rules, the SPY
 * baseline's hit rate collapses to 3-15 %, and the reason is that half
 * the rows where SPY's limit did not fill were counted as SPY misses.
 * The comparison is therefore made on the rows where BOTH traded, and
 * the count of rows where only one of them traded is reported beside it.
 *
 * For the three EXECUTABLE rules both always trade, so the comparison
 * set is every row -- and the validation against the published numbers
 * is unaffected.
 *
 * @param {object[]} scored
 * @returns {object}
 */
function summarize(scored) {
  const out = {};
  for (const horizon of ['1w', '1m']) {
    const hitKey = `hit_${horizon}`;
    const excessKey = `excess_${horizon}`;
    const spyHitKey = `spy_hit_${horizon}`;
    const traded = scored.filter((row) => row[hitKey] === true || row[hitKey] === false);
    // The COMPARABLE set: both the claim and the benchmark traded.
    const rows = traded.filter((row) => row[spyHitKey] === true || row[spyHitKey] === false);
    const n = rows.length;
    if (!n) {
      out[horizon] = {
        n: 0,
        traded: traded.length,
        only_one_traded: traded.length,
        hit_rate: null,
        spy_same_call_hit_rate: null,
        excess_pp: null,
      };
      continue;
    }
    const hits = rows.filter((row) => row[hitKey] === true).length;
    const spyHits = rows.filter((row) => row[spyHitKey] === true).length;
    const excesses = rows.map((row) => row[excessKey]).filter((v) => Number.isFinite(v));
    const meanExcess = excesses.length
      ? excesses.reduce((a, b) => a + b, 0) / excesses.length : null;
    const variance = excesses.length > 1
      ? excesses.reduce((a, b) => a + (b - meanExcess) ** 2, 0) / (excesses.length - 1) : 0;
    const half = 1.96 * Math.sqrt(variance / excesses.length);
    out[horizon] = {
      n,
      traded: traded.length,
      only_one_traded: traded.length - n,
      hit_rate: Number((hits / n).toFixed(4)),
      spy_same_call_hit_rate: Number((spyHits / n).toFixed(4)),
      excess_pp: Number(((hits - spyHits) / n * 100).toFixed(2)),
      mean_excess_pct: meanExcess === null ? null : Number((meanExcess * 100).toFixed(3)),
      excess_ci95: meanExcess === null
        ? null
        : [Number(((meanExcess - half) * 100).toFixed(3)), Number(((meanExcess + half) * 100).toFixed(3))],
    };
  }
  return out;
}

/**
 * The series a symbol needs: from its earliest claim to its latest.
 *
 * The range is PER SYMBOL and not global, and that is not an
 * optimisation: asking for one wide range for every symbol forces a
 * refetch of every cache and the fetches throttle each other, and a
 * throttled fetch returns the STALE cache -- which does not cover the
 * claim's date, and the claim is then dropped for a reason that has
 * nothing to do with the parser.
 *
 * @param {object[]} claims
 * @returns {Map<string, {from: string, to: string}>}
 */
function rangesFor(claims) {
  const bySymbol = new Map();
  for (const claim of claims) {
    const current = bySymbol.get(claim.symbol);
    if (!current) {
      bySymbol.set(claim.symbol, { from: claim.date, to: claim.date });
      continue;
    }
    if (claim.date < current.from) current.from = claim.date;
    if (claim.date > current.to) current.to = claim.date;
  }
  const ranges = new Map();
  for (const [symbol, span] of bySymbol) {
    ranges.set(symbol, {
      from: shiftIsoDate(span.from, -10),
      to: shiftIsoDate(span.to, HORIZON_1M_DAYS + 40),
    });
  }
  return ranges;
}

async function main() {
  const rules = allRules();
  const sets = CLAIM_SETS.filter((set) => !options.source || set.id === options.source);

  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    prefetchConcurrency: 2,
  });

  // ---- the claims -----------------------------------------------------
  const claimSets = [];
  for (const set of sets) {
    const { rows, skipped } = readCsv(set.file);
    const claims = claimsFrom(rows, set);
    if (!claims.length) {
      console.log(`[entry-rule] ${set.id}: no claims in ${set.file}`);
      continue;
    }
    if (skipped) console.log(`[entry-rule] ${set.id}: ${skipped} row(s) did not parse and were skipped`);
    claimSets.push({ ...set, claims });
  }
  if (!claimSets.length) {
    console.log('[entry-rule] no claim sets -- have the source analyses been run?');
    return;
  }

  const asOfDate = new Date().toISOString().slice(0, 10);
  const allClaims = claimSets.flatMap((set) => set.claims);

  // ---- the bars -------------------------------------------------------
  const ranges = rangesFor(allClaims);
  ranges.set(BENCHMARK, {
    from: shiftIsoDate(allClaims.map((c) => c.date).sort()[0], -10),
    to: shiftIsoDate(allClaims.map((c) => c.date).sort().slice(-1)[0], HORIZON_1M_DAYS + 40),
  });
  console.log(`[entry-rule] ${claimSets.length} claim sets, ${ranges.size} symbols, as of ${asOfDate}`);

  const symbolList = [...ranges.keys()];
  const barTasks = symbolList.map((symbol) => async () => {
    const range = ranges.get(symbol);
    let series = await provider.loadTickerSeries(symbol, range.from, range.to);
    // A THROTTLED fetch returns the stale cache, which does not cover
    // the claim's date. One retry, a moment later, is the difference
    // between "the price is not there" and "the network was busy".
    if (!series.prices || !series.prices.length) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      series = await provider.loadTickerSeries(symbol, range.from, range.to);
    }
    return [symbol, (series.prices || []).map(adjustedBar).filter(Boolean)];
  });
  console.log(`[entry-rule] loading ${symbolList.length} series...`);
  const loaded = await runWithConcurrency(barTasks, 4);
  const bars = new Map(loaded);
  console.log(`[entry-rule] loaded ${[...bars.values()].filter((b) => b.length).length} series with bars`);

  const spyBars = bars.get(BENCHMARK) || [];

  // ---- score ----------------------------------------------------------
  const report = {};
  for (const set of claimSets) {
    const perRule = {};
    for (const rule of rules) {
      const scored = [];
      const dropped = {};
      const scoredRows = [];
      for (const claim of set.claims) {
        const series = bars.get(claim.symbol) || [];
        const row = scoreClaim(claim, series, spyBars, rule, asOfDate);
        if (!row || row.status !== 'ok') {
          const why = (row && row.status) || 'no_price';
          dropped[why] = (dropped[why] || 0) + 1;
          continue;
        }
        scored.push(row);
        scoredRows.push({ claim, row });
      }
      perRule[rule.name] = {
        rule: rule.name,
        label: rule.label,
        claims: set.claims.length,
        scored: scored.length,
        dropped,
        ...summarize(scored),
      };
      if (rule.name === 'close_d0') perRule.close_d0_rows = scoredRows;
    }

    // ---- the validation, LIKE FOR LIKE --------------------------------
    // The question is "does my recomputation reproduce the published
    // number?", and that is a question about the rows BOTH have. The
    // rows only one of them could score are a PRICE-DATA question, and
    // they are counted separately rather than mixed in.
    const rows = perRule.close_d0_rows || [];
    const comparable = rows.filter(({ claim, row }) => claim.published !== null
      && (row.hit_1w === true || row.hit_1w === false));
    const publishedHits = comparable.filter(({ claim }) => claim.published === true).length;
    const recomputedHits = comparable.filter(({ row }) => row.hit_1w === true).length;
    const validation = comparable.length
      ? {
        compared: comparable.length,
        published_hit_rate: Number((publishedHits / comparable.length).toFixed(4)),
        recomputed_hit_rate: Number((recomputedHits / comparable.length).toFixed(4)),
        agrees: publishedHits === recomputedHits,
        published_only: set.claims.filter((claim) => claim.published !== null).length - comparable.length,
      }
      : null;

    report[set.id] = { label: set.label, claims: set.claims.length, rules: perRule, validation };
  }

  // ---- the printed table ---------------------------------------------
  console.log('');
  console.log('the ENTRY RULE, measured over every forward claim of every source');
  console.log('(the exit never moves: it is the close on the CLAIM date plus the horizon)');
  console.log("('one' is the claims where only ONE of the two traded -- the claim or SPY -- and so the pair is not compared)");
  console.log('');
  for (const set of claimSets) {
    const entry = report[set.id];
    console.log(`${entry.label}  (${entry.claims} forward claims)`);
    if (entry.validation) {
      const v = entry.validation;
      console.log(`  validation: published ${v.published_hit_rate} / recomputed ${v.recomputed_hit_rate}`
        + ` on ${v.compared} rows  ${v.agrees ? 'AGREES' : '*** DISAGREES ***'}`
        + (v.published_only ? `  (${v.published_only} published rows had no price here)` : ''));
    }
    console.log(`  ${'rule'.padEnd(18)}${'n'.padStart(6)}${'one'.padStart(5)}${'dropped'.padStart(9)}`
      + `${'1w hit'.padStart(9)}${'1w SPY'.padStart(9)}${'1w edge'.padStart(10)}`
      + `${'1m hit'.padStart(9)}${'1m SPY'.padStart(9)}${'1m edge'.padStart(10)}`);
    for (const rule of rules) {
      const r = entry.rules[rule.name];
      const dropped = Object.values(r.dropped).reduce((a, b) => a + b, 0);
      const fmt = (v) => (v === null || v === undefined ? '-' : (v * 100).toFixed(1) + '%');
      const edge = (v) => (v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}pp`);
      const one = r['1w'].only_one_traded || 0;
      console.log(`  ${rule.name.padEnd(18)}${String(r['1w'].n).padStart(6)}${String(one).padStart(5)}${String(dropped).padStart(9)}`
        + `${fmt(r['1w'].hit_rate).padStart(9)}${fmt(r['1w'].spy_same_call_hit_rate).padStart(9)}`
        + `${edge(r['1w'].excess_pp).padStart(10)}`
        + `${fmt(r['1m'].hit_rate).padStart(9)}${fmt(r['1m'].spy_same_call_hit_rate).padStart(9)}`
        + `${edge(r['1m'].excess_pp).padStart(10)}`);
    }
    console.log('');
  }

  const payload = {
    generated_at: new Date().toISOString(),
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
    as_of_date: asOfDate,
    benchmark: BENCHMARK,
    entry_rule_note: 'the exit is the close on the CLAIM date plus the horizon, in every rule;'
      + ' only the entry changes',
    rules: rules.map((rule) => ({
      name: rule.name,
      label: rule.label,
      needsFill: Boolean(rule.needsFill),
      limitPct: rule.limitPct === undefined ? null : rule.limitPct,
    })),
    sources: report,
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[entry-rule] wrote ${path.relative(ROOT, OUTPUT_PATH)}`);

  if (options.json) console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(`[entry-rule] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
