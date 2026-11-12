'use strict';

// The Benzinga content filter.
//
// The classifier is the GATE for the whole source: an allow-list of shows,
// because most of what Benzinga publishes is not its hosts calling trades
// (76 of the newest 150 streams are company earnings-call rebroadcasts).
// So the tests below are written against REAL sampled titles, not invented
// ones -- a title that reads like the channel's is the input that matters.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  BENZINGA_HANDLING,
  BENZINGA_SHOWS,
  benzingaVideoQuarantine,
  classifyBenzingaVideo,
  isSignalShow,
  partnerFromTitle,
  titleAirDate,
  titleTickers,
} = require('../src/benzinga/contentFilter');

// ─── The two shows the source is for ────────────────────────────────────────

test('a PreMarket Playbook episode is extracted', () => {
  const result = classifyBenzingaVideo({
    title: 'Hot CPI Hits Stocks as $NVDA China Spy Probe Deepens | PreMarket Playbook + T3 Live | Nov 10, 2026',
    duration_sec: 7286,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.PREMARKET_PLAYBOOK);
  assert.equal(result.handling, BENZINGA_HANDLING.EXTRACT);
  assert.equal(result.priority, 'high');
});

test('the older "PreMarket Prep" spelling is the same show', () => {
  const result = classifyBenzingaVideo({
    title: 'PreMarket Prep — $NVDA Earnings Setup | October 20, 2021',
    duration_sec: 5400,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.PREMARKET_PLAYBOOK);
});

test('a PreMarket Playbook title keeps its show even when it names the Fed', () => {
  // The show patterns run before the quarantine patterns, because the
  // daily show routinely has a Fed or an earnings title.
  const result = classifyBenzingaVideo({
    title: '$SPY, $QQQ Rise Ahead Of Fed Rate Decision | PreMarket Playbook | September 16, 2026',
    duration_sec: 11116,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.PREMARKET_PLAYBOOK);
});

test('The Drift is extracted', () => {
  const result = classifyBenzingaVideo({
    title: 'Midterm Election Results: Futures Sink, Then Rip Higher | The Drift // Ep.20',
    duration_sec: 3046,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.THE_DRIFT);
  assert.equal(result.handling, BENZINGA_HANDLING.EXTRACT);
});

// ─── The quarantine: what is NOT a call ────────────────────────────────────

test('an earnings-call rebroadcast is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'Moderna Q3 FY26 Earnings Call | $MRNA |  WATCH LIVE',
    duration_sec: 4154,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.EARNINGS_CALL);
  assert.equal(result.handling, BENZINGA_HANDLING.QUARANTINE);
});

test('a Fed press conference is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: "Kevin Warsh FOMC Press Conference LIVE | Fed Rate Decision [October 2026]",
    duration_sec: 2111,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.FED_PRESSER);
  assert.equal(result.handling, BENZINGA_HANDLING.QUARANTINE);
});

test('a CEO interview is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'Celsius ($CELH) CEO John Fieldly on Brand Strategy, Better-for-You Energy Shift, and Growth Outlook',
    duration_sec: 3078,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.INTERVIEW);
});

test('a Benzinga Pro product piece is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'The Easiest Way to Scan S&P 500 Stocks in Benzinga Pro',
    duration_sec: 180,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.PRODUCT_TUTORIAL);
});

test('an educational piece is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'Options Trading for Beginners (Everything You Need to Know)',
    duration_sec: 800,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.EDUCATION);
});

test('a clip that has not been streamed yet is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'Intro to KPI Binary Options',
    duration_sec: null,
    live_status: 'is_upcoming',
  });
  assert.equal(result.show, BENZINGA_SHOWS.UPCOMING);
  assert.equal(result.handling, BENZINGA_HANDLING.QUARANTINE);
});

test('a live stream is not read while it is still running', () => {
  const result = classifyBenzingaVideo({
    title: 'Is the AI Trade Back? $CRWV Soars 15% on Earnings Beat | PreMarket Playbook | November 11, 2026',
    duration_sec: null,
    live_status: 'is_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.UPCOMING);
});

// ─── The prerecorded tab ────────────────────────────────────────────────────

test('a futures update is read for the market, and not for ticker signals', () => {
  const result = classifyBenzingaVideo({
    title: 'Markets Trend Up as Bessent Urges US-China to \'De-Risk\'',
    duration_sec: 187,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.MARKET_UPDATE);
  assert.equal(result.handling, BENZINGA_HANDLING.READINGS);
  assert.equal(isSignalShow({ title: result.title, duration_sec: 187 }), false);
});

test('a single-ticker clip is extracted as a setup', () => {
  const result = classifyBenzingaVideo({
    title: 'VIVS Stock in Play After Massive Volume Spike',
    duration_sec: 166,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.STOCK_IN_PLAY);
  assert.equal(result.handling, BENZINGA_HANDLING.EXTRACT);
});

test('a long thematic explainer is extracted', () => {
  const result = classifyBenzingaVideo({
    title: 'If I Could Only Buy 7 AI Stocks Forever, It Would Be These.',
    duration_sec: 697,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.EXPLAINER);
  assert.equal(result.handling, BENZINGA_HANDLING.EXTRACT);
});

test('a very short clip is quarantined', () => {
  const result = classifyBenzingaVideo({
    title: 'DKI Momentum Test: Can Dark Iris Hold Dollar Territory?',
    duration_sec: 26,
    live_status: 'was_live',
  });
  assert.equal(result.show, BENZINGA_SHOWS.SHORT_CLIP);
});

// ─── The partner ───────────────────────────────────────────────────────────

test('the partner is read from the title', () => {
  assert.equal(partnerFromTitle('Fed On Deck: Why Pros Are Sitting on Their Hands | PreMarket Playbook + T3 Live | Oct 27, 2026'), 't3live');
  assert.equal(partnerFromTitle('$SPY, $QQQ Rise Ahead Of Fed Rate Decision | PreMarket Playbook + Nasdaq'), 'nasdaq');
  assert.equal(partnerFromTitle('Chip Sell-Off Deepens | PreMarket Playbook + Cboe'), 'cboe');
  assert.equal(partnerFromTitle('T3 Tuesday | PreMarket Playbook + All Access'), 'all_access');
  assert.equal(partnerFromTitle('Canary in the Coal Mine | PreMarket Playbook'), '');
});

// ─── The air date in the title ─────────────────────────────────────────────

test('the air date is read from the title', () => {
  assert.equal(titleAirDate('Nvidia CEO Controversy | PreMarket Playbook | November 9, 2026'), '20261109');
  assert.equal(titleAirDate('$INTC Plunges 26% | PreMarket Playbook | October 30, 2026'), '20261030');
  assert.equal(titleAirDate('The Pain of Discipline | PreMarket Playbook + T3 Live | OCT 20, 2026'), '20261020');
  assert.equal(titleAirDate('CPI Week | PreMarket Playbook + All Access | Oct 12, 2026'), '20261012');
});

test('a title without a full date yields none', () => {
  assert.equal(titleAirDate('Fed Rate Decision LIVE | Fed Rate Decision [October 2026]'), '');
  assert.equal(titleAirDate('Kevin Warsh FOMC Press Conference LIVE'), '');
});

test('an impossible date is refused', () => {
  assert.equal(titleAirDate('PreMarket Playbook | February 30, 2026'), '');
});

// ─── The tickers a title names ─────────────────────────────────────────────

test('a cashtag in the title is read', () => {
  const { cashtags } = titleTickers('$SPCX & $SMCI Rip Higher, Is $META the Next AI Domino?');
  assert.deepEqual(cashtags, ['SPCX', 'SMCI', 'META']);
});

test('an ordinary all-caps word is not a ticker', () => {
  const { bare } = titleTickers('FOMC Today? But Big Tech Earnings Matter More');
  assert.deepEqual(bare, []);
});

// ─── The gate ──────────────────────────────────────────────────────────────

test('the quarantine reports the show that caused it', () => {
  const result = benzingaVideoQuarantine({
    title: 'Moderna Q3 FY26 Earnings Call | $MRNA |  WATCH LIVE',
    duration_sec: 4154,
    live_status: 'was_live',
  });
  assert.equal(result.quarantined, true);
  assert.equal(result.reason, BENZINGA_SHOWS.EARNINGS_CALL);
});

test('a show on the allow-list is not quarantined', () => {
  const result = benzingaVideoQuarantine({
    title: 'T3 Tuesday | PreMarket Playbook + All Access | October 13, 2026',
    duration_sec: 7180,
    live_status: 'was_live',
  });
  assert.equal(result.quarantined, false);
});
