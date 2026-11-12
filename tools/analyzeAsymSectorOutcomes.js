'use strict';

// Score the AsymTrading SECTOR picks against what the sector ETFs did next.
//
// The written report names sectors to focus on and sectors to avoid. The
// TradeStation table ranks the same sectors by 1-month rate of change.
// This tool asks the third question: did a PRIMARY pick actually go up,
// and did an AVOID pick actually go down, over the next week and month?
//
// The mapping is the standard SPDR sector ETFs, plus a couple of close
// proxies where the GICS name and the ETF name diverge:
//
//   Technology             -> XLK
//   Healthcare             -> XLV
//   Financial Services     -> XLF
//   Energy                 -> XLE
//   Industrials            -> XLI
//   Basic Materials        -> XLB
//   Consumer Cyclical      -> XLY
//   Consumer Defensive     -> XLP
//   Utilities              -> XLU
//   Real Estate            -> XLRE
//   Communication Services -> XLC
//
// A primary/secondary pick is scored as BULLISH on its ETF; an avoid pick
// is scored as BEARISH. The rest of the bookkeeping -- entry on the post
// date, +7 / +30 horizons, same-call-on-SPY -- is the same as the ticker
// outcome tool.
//
// Usage:
//   node tools/aggregateAsymSignals.js
//   node tools/analyzeAsymSectorOutcomes.js
//   node tools/analyzeAsymSectorOutcomes.js --json

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { createYahooPriceProvider } = require('../src/analysis/priceProvider');
const {
  scoreSignalOutcome,
  shiftIsoDate,
  summarizeOutcomes,
  toIsoDate,
} = require('../src/sevcik/outcomeAnalysis');
const { writeCsv } = require('../src/write/writeCsv');
const { articleSector } = require('../src/asym/sectorTable');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'data', 'price_cache', 'yahoo');
const HORIZON_1W_DAYS = 7;
const HORIZON_1M_DAYS = 30;

/**
 * The SPDR (or close-proxy) ETF for each GICS sector.
 */
const SECTOR_ETFS = {
  'Technology': 'XLK',
  'Healthcare': 'XLV',
  'Financial Services': 'XLF',
  'Energy': 'XLE',
  'Industrials': 'XLI',
  'Basic Materials': 'XLB',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Communication Services': 'XLC',
};

const OUTCOME_COLUMNS = [
  'upload_date', 'video_id', 'article_sector', 'gics_sector', 'tier', 'bias',
  'etf', 'rank_by_roc', 'of_sectors', 'roc_1mo', 'pct_change',
  'event_date', 'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'spy_return_1w', 'spy_same_call_hit_1w', 'excess_aligned_1w',
  'spy_return_1m', 'spy_same_call_hit_1m', 'excess_aligned_1m',
  'hit_1w', 'hit_1m', 'price_status',
];

const argv = process.argv.slice(2);
const options = { json: argv.includes('--json') };

function finitePrice(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function attachSameCallOnSpy(row, provider, asOfDate) {
  const sign = row.bias === 'bullish' ? 1 : row.bias === 'bearish' ? -1 : 0;
  for (const [h, days] of [['1w', HORIZON_1W_DAYS], ['1m', HORIZON_1M_DAYS]]) {
    row['spy_return_' + h] = null;
    row['spy_same_call_hit_' + h] = null;
    row['excess_aligned_' + h] = null;
    const stockReturn = row['return_' + h];
    if (!sign || !row.event_date || !Number.isFinite(stockReturn)) continue;
    const exitDate = shiftIsoDate(row.event_date, days);
    if (exitDate > asOfDate) continue;
    const entry = finitePrice((await provider.getPricePoint('SPY', row.event_date)).price);
    const exit = finitePrice((await provider.getPricePoint('SPY', exitDate)).price);
    if (!entry || !exit) continue;
    const spyReturn = exit / entry - 1;
    row['spy_return_' + h] = Number(spyReturn.toFixed(6));
    row['spy_same_call_hit_' + h] = sign * spyReturn > 0;
    row['excess_aligned_' + h] = Number((sign * (stockReturn - spyReturn)).toFixed(6));
  }
}

function sameCallStats(rows, h) {
  const scored = rows.filter((row) => (row['hit_' + h] === true || row['hit_' + h] === false)
    && Number.isFinite(row['excess_aligned_' + h]));
  const n = scored.length;
  if (!n) {
    return {
      n: 0, hit_rate: null, spy_same_call_hit_rate: null,
      edge_pp: null, mean_excess_aligned: null, excess_ci95: null,
    };
  }
  const hits = scored.filter((row) => row['hit_' + h] === true).length;
  const spyHits = scored.filter((row) => row['spy_same_call_hit_' + h] === true).length;
  const excess = scored.map((row) => row['excess_aligned_' + h]);
  const mean = excess.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / n);
  const round = (v, d = 4) => Number(v.toFixed(d));
  return {
    n,
    hit_rate: round(hits / n, 3),
    spy_same_call_hit_rate: round(spyHits / n, 3),
    edge_pp: round(((hits - spyHits) / n) * 100, 1),
    mean_excess_aligned: round(mean),
    excess_ci95: [round(mean - half), round(mean + half)],
  };
}

function loadClaims(db) {
  const articles = db.prepare(`
    SELECT a.video_id, a.sectors, p.upload_date
      FROM asym_articles a
      JOIN asym_posts p ON p.video_id = a.video_id
     WHERE a.sectors IS NOT NULL AND length(a.sectors) > 2
     ORDER BY p.upload_date DESC
  `).all();

  const sectorRows = new Map();
  for (const row of db.prepare('SELECT * FROM asym_sectors').all()) {
    if (!sectorRows.has(row.video_id)) sectorRows.set(row.video_id, []);
    sectorRows.get(row.video_id).push(row);
  }

  const claims = [];
  for (const article of articles) {
    let named = [];
    try { named = JSON.parse(article.sectors); } catch { continue; }
    const table = sectorRows.get(article.video_id) || [];
    const ranked = table
      .filter((row) => row.roc_1mo !== null && row.roc_1mo !== undefined)
      .slice()
      .sort((a, b) => Number(b.roc_1mo) - Number(a.roc_1mo));
    const rankOf = new Map(ranked.map((row, index) => [row.sector, index + 1]));

    for (const entry of named) {
      const gics = articleSector(entry.sector);
      if (!gics) continue;
      const tier = String(entry.tier || '');
      let bias = '';
      if (tier === 'primary' || tier === 'secondary') bias = 'bullish';
      else if (tier === 'avoid') bias = 'bearish';
      else continue;
      const etf = SECTOR_ETFS[gics];
      if (!etf) continue;
      const tableRow = table.find((row) => row.sector === gics) || null;
      claims.push({
        video_id: article.video_id,
        upload_date: article.upload_date,
        article_sector: entry.sector,
        gics_sector: gics,
        tier,
        bias,
        ticker: etf,
        etf,
        rank_by_roc: rankOf.get(gics) || '',
        of_sectors: ranked.length,
        roc_1mo: tableRow ? tableRow.roc_1mo : '',
        pct_change: tableRow ? tableRow.pct_change : '',
        confidence_label: tier === 'primary' ? 'high' : 'medium',
        confidence_score: tier === 'primary' ? 0.8 : (tier === 'avoid' ? 0.7 : 0.5),
        evidence_text: entry.evidence || '',
        claim_kind: 'forward',
      });
    }
  }
  return claims;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('No SQLite at ' + DB_PATH);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const claims = loadClaims(db);
  db.close();

  if (!claims.length) {
    console.log('[asym-sector-outcomes] no sector claims yet. Run npm run asym:sectors first.');
    return;
  }

  const dates = claims.map((c) => toIsoDate(c.upload_date)).filter(Boolean).sort();
  const asOfDate = new Date().toISOString().slice(0, 10);
  const provider = createYahooPriceProvider({
    cacheDirectory: CACHE_DIR,
    defaultFromDate: dates[0] ? shiftIsoDate(dates[0], -5) : '',
    defaultToDate: dates.length ? shiftIsoDate(dates[dates.length - 1], HORIZON_1M_DAYS + 5) : asOfDate,
    prefetchConcurrency: 2,
  });
  const symbols = [...new Set([...claims.map((c) => c.etf), 'SPY'])];
  console.log('[asym-sector-outcomes] claims=' + claims.length + ' symbols=' + symbols.length);
  await provider.prefetchTickers(symbols);

  const outcomes = [];
  for (const claim of claims) {
    const eventDate = toIsoDate(claim.upload_date);
    let prices;
    if (!eventDate) {
      prices = { entry: null, week: null, month: null, meta: { status: 'missing_event_date' } };
    } else {
      const weekDate = shiftIsoDate(eventDate, HORIZON_1W_DAYS);
      const monthDate = shiftIsoDate(eventDate, HORIZON_1M_DAYS);
      const entry = await provider.getPricePoint(claim.etf, eventDate);
      const week = weekDate <= asOfDate
        ? await provider.getPricePoint(claim.etf, weekDate)
        : { price: '', priceStatus: 'horizon_not_elapsed' };
      const month = monthDate <= asOfDate
        ? await provider.getPricePoint(claim.etf, monthDate)
        : { price: '', priceStatus: 'horizon_not_elapsed' };
      const status = [entry.priceStatus, week.priceStatus, month.priceStatus]
        .filter((value) => value && !String(value).startsWith('ok'))
        .join('|') || 'ok';
      prices = {
        entry: finitePrice(entry.price),
        week: finitePrice(week.price),
        month: finitePrice(month.price),
        meta: { status },
      };
    }
    const scored = scoreSignalOutcome(claim, prices);
    const row = {
      ...scored,
      article_sector: claim.article_sector,
      gics_sector: claim.gics_sector,
      tier: claim.tier,
      etf: claim.etf,
      rank_by_roc: claim.rank_by_roc,
      of_sectors: claim.of_sectors,
      roc_1mo: claim.roc_1mo,
      pct_change: claim.pct_change,
    };
    await attachSameCallOnSpy(row, provider, asOfDate);
    outcomes.push(row);
  }

  const overall = summarizeOutcomes(outcomes, {});
  overall.same_call_on_spy = {
    '1w': sameCallStats(outcomes, '1w'),
    '1m': sameCallStats(outcomes, '1m'),
  };
  const byTier = {};
  for (const tier of ['primary', 'secondary', 'avoid']) {
    const subset = outcomes.filter((row) => row.tier === tier);
    if (!subset.length) continue;
    const summary = summarizeOutcomes(subset, {});
    summary.same_call_on_spy = {
      '1w': sameCallStats(subset, '1w'),
      '1m': sameCallStats(subset, '1m'),
    };
    byTier[tier] = summary;
  }

  const blank = (v) => (v === null || v === undefined ? '' : v);
  const serialized = outcomes.map((row) => ({
    upload_date: row.upload_date,
    video_id: row.video_id,
    article_sector: row.article_sector,
    gics_sector: row.gics_sector,
    tier: row.tier,
    bias: row.bias,
    etf: row.etf,
    rank_by_roc: blank(row.rank_by_roc),
    of_sectors: blank(row.of_sectors),
    roc_1mo: blank(row.roc_1mo),
    pct_change: blank(row.pct_change),
    event_date: row.event_date,
    entry_price: blank(row.entry_price),
    price_1w: blank(row.price_1w),
    price_1m: blank(row.price_1m),
    return_1w: blank(row.return_1w),
    return_1m: blank(row.return_1m),
    aligned_return_1w: blank(row.aligned_return_1w),
    aligned_return_1m: blank(row.aligned_return_1m),
    spy_return_1w: blank(row.spy_return_1w),
    spy_same_call_hit_1w: row.spy_same_call_hit_1w === null ? '' : (row.spy_same_call_hit_1w ? 1 : 0),
    excess_aligned_1w: blank(row.excess_aligned_1w),
    spy_return_1m: blank(row.spy_return_1m),
    spy_same_call_hit_1m: row.spy_same_call_hit_1m === null ? '' : (row.spy_same_call_hit_1m ? 1 : 0),
    excess_aligned_1m: blank(row.excess_aligned_1m),
    hit_1w: row.hit_1w === null ? '' : (row.hit_1w ? 1 : 0),
    hit_1m: row.hit_1m === null ? '' : (row.hit_1m ? 1 : 0),
    price_status: row.price_status || '',
  }));

  await writeCsv(path.join(OUTPUT_DIR, 'asym_sector_outcomes.csv'), OUTCOME_COLUMNS, serialized);
  const summary = {
    generated_at: new Date().toISOString(),
    horizons: { '1w_days': HORIZON_1W_DAYS, '1m_days': HORIZON_1M_DAYS },
    entry_rule: 'close on the post date; previous trading day for a weekend post',
    claims: claims.length,
    overall: {
      claim_count: overall.claim_count || claims.length,
      hit_rate_1w: overall.hit_rate_1w,
      hit_rate_1m: overall.hit_rate_1m,
      same_call_on_spy: overall.same_call_on_spy,
      same_call_excess_1w: overall.same_call_on_spy['1w'].mean_excess_aligned,
      same_call_excess_1w_ci: {
        low: overall.same_call_on_spy['1w'].excess_ci95 && overall.same_call_on_spy['1w'].excess_ci95[0],
        high: overall.same_call_on_spy['1w'].excess_ci95 && overall.same_call_on_spy['1w'].excess_ci95[1],
      },
      same_call_hit_rate_1w: overall.same_call_on_spy['1w'].hit_rate,
    },
    by_tier: Object.fromEntries(Object.entries(byTier).map(([tier, s]) => [tier, {
      claim_count: s.claim_count || outcomes.filter((r) => r.tier === tier).length,
      hit_rate_1w: s.hit_rate_1w,
      hit_rate_1m: s.hit_rate_1m,
      same_call_on_spy: s.same_call_on_spy,
      same_call_excess_1w: s.same_call_on_spy['1w'].mean_excess_aligned,
      same_call_excess_1w_ci: {
        low: s.same_call_on_spy['1w'].excess_ci95 && s.same_call_on_spy['1w'].excess_ci95[0],
        high: s.same_call_on_spy['1w'].excess_ci95 && s.same_call_on_spy['1w'].excess_ci95[1],
      },
      same_call_hit_rate_1w: s.same_call_on_spy['1w'].hit_rate,
    }])),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'asym_sector_outcome_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const line = (label, s) => {
    const w = s.same_call_on_spy['1w'];
    console.log('[asym-sector-outcomes] ' + label.padEnd(12)
      + ' claims=' + String(s.claim_count).padStart(3)
      + ' | 1w hit=' + w.hit_rate
      + ' same-call-on-SPY=' + w.spy_same_call_hit_rate
      + ' excess=' + w.mean_excess_aligned
      + ' ci=' + JSON.stringify(w.excess_ci95));
  };
  line('overall', summary.overall);
  for (const [tier, s] of Object.entries(summary.by_tier)) line(tier, s);
  console.log('[asym-sector-outcomes] wrote data/asym_sector_outcomes.csv and data/asym_sector_outcome_summary.json');
}

main().catch((error) => {
  console.error('[asym-sector-outcomes] failed: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});