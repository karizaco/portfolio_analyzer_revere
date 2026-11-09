'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyT3liveVideo,
  t3liveVideoQuarantine,
  T3LIVE_SHOWS,
  T3LIVE_HOSTS,
  T3LIVE_PRIORITY,
} = require('../src/t3live/contentFilter');

// ─── Show classification ───────────────────────────────────────────────────

test('Actionable Swing Trade Ideas → actionable_swings / sami / high', () => {
  const result = classifyT3liveVideo('Actionable Swing Trade Ideas — NVDA, AAPL, TSLA');
  assert.equal(result.show, T3LIVE_SHOWS.ACTIONABLE_SWINGS);
  assert.equal(result.host, T3LIVE_HOSTS.SAMI);
  assert.equal(result.priority, T3LIVE_PRIORITY.HIGH);
});

test('Actionable Swing Trade Ideas (singular) → actionable_swings', () => {
  const result = classifyT3liveVideo('Actionable Swing Trade Idea — AMD');
  assert.equal(result.show, T3LIVE_SHOWS.ACTIONABLE_SWINGS);
  assert.equal(result.host, T3LIVE_HOSTS.SAMI);
});

test('630 Club → 630club / scott / high', () => {
  const result = classifyT3liveVideo('The 630 Club — Morning Preview with Scott Redler');
  assert.equal(result.show, T3LIVE_SHOWS.CLUB_630);
  assert.equal(result.host, T3LIVE_HOSTS.SCOTT);
  assert.equal(result.priority, T3LIVE_PRIORITY.HIGH);
});

test('630club (no space) → 630club', () => {
  const result = classifyT3liveVideo('630club Morning Show');
  assert.equal(result.show, T3LIVE_SHOWS.CLUB_630);
});

test('the older "6:30 Club" spelling is the same show', () => {
  const result = classifyT3liveVideo('Redler 6:30 Club');
  assert.equal(result.show, T3LIVE_SHOWS.CLUB_630);
  assert.equal(result.host, T3LIVE_HOSTS.SCOTT);
  assert.equal(classifyT3liveVideo('6.30 Club').show, T3LIVE_SHOWS.CLUB_630);
});

test('Options In Play is its own series, and it does not invent a host', () => {
  const result = classifyT3liveVideo('Options In Play - Earnings On The Radar Week Of 11/15');
  assert.equal(result.show, T3LIVE_SHOWS.OPTIONS_IN_PLAY);
  assert.equal(result.host, T3LIVE_HOSTS.UNKNOWN);
  assert.equal(result.priority, T3LIVE_PRIORITY.MEDIUM);
});

test('Morning Call is its own series, even when Scott is named', () => {
  const named = classifyT3liveVideo('Scott Redler Morning Call - January 28th');
  assert.equal(named.show, T3LIVE_SHOWS.MORNING_CALL);
  assert.equal(named.host, T3LIVE_HOSTS.SCOTT);
  const unnamed = classifyT3liveVideo('Morning Call: Fed Ahead');
  assert.equal(unnamed.show, T3LIVE_SHOWS.MORNING_CALL);
  assert.equal(unnamed.host, T3LIVE_HOSTS.UNKNOWN);
});

test('a 630 Club title that also says morning stays the 630 Club', () => {
  const result = classifyT3liveVideo('The 630 Club — Morning Preview with Scott Redler');
  assert.equal(result.show, T3LIVE_SHOWS.CLUB_630);
});

test('Daily Recap is the format, and the host is whoever the title names', () => {
  const scott = classifyT3liveVideo('JUN-6-19 - Scott Redler - Daily Recap - Strive to Do Better');
  assert.equal(scott.show, T3LIVE_SHOWS.DAILY_RECAP);
  assert.equal(scott.host, T3LIVE_HOSTS.SCOTT);
  const unnamed = classifyT3liveVideo('Daily Recap: The Longer Term Direction is Up!');
  assert.equal(unnamed.show, T3LIVE_SHOWS.DAILY_RECAP);
  assert.equal(unnamed.host, T3LIVE_HOSTS.UNKNOWN);
});

test('an older format is its own show, not other', () => {
  assert.equal(classifyT3liveVideo('T3 Market Wrap: Coinbase and Breakout Bases').show, T3LIVE_SHOWS.MARKET_WRAP);
  assert.equal(classifyT3liveVideo('Half-Time Report: June 3, 2013').show, T3LIVE_SHOWS.HALF_TIME);
  assert.equal(classifyT3liveVideo("Derrick's Pro Desk Market Update 11/11/2021").show, T3LIVE_SHOWS.PRO_DESK);
  assert.equal(classifyT3liveVideo("Derrick's Weekly Market Update | 9/7/2021").show, T3LIVE_SHOWS.WEEKLY_UPDATE);
  assert.equal(classifyT3liveVideo('Tuesday\'s Watch List: AAPL, AMZN').show, T3LIVE_SHOWS.WATCH_LIST);
  assert.equal(classifyT3liveVideo('How to Trade Gaps for Consistent Profits').show, T3LIVE_SHOWS.HOW_TO);
  assert.equal(classifyT3liveVideo('LIVE Marketcast Call W/ Christian Tharp, CMT').show, T3LIVE_SHOWS.MARKETCAST);
  assert.equal(classifyT3liveVideo('Corey Smith- Core FX Pre- Week Analysis').show, T3LIVE_SHOWS.CORE_FX);
});

test('a title that matches two older formats takes the more specific one', () => {
  assert.equal(classifyT3liveVideo('Red Dog mid-day').show, T3LIVE_SHOWS.RED_DOG);
  assert.equal(classifyT3liveVideo('Red Dog mid-day').host, T3LIVE_HOSTS.SCOTT);
  const room = classifyT3liveVideo('Watchlist Review with Sami Abusaad | Black Room Open House');
  assert.equal(room.show, T3LIVE_SHOWS.BLACK_ROOM);
  assert.equal(room.host, T3LIVE_HOSTS.SAMI);
});

test('Scott Redler named without 630 Club → scott_misc', () => {
  const result = classifyT3liveVideo('Market Recap with Scott Redler');
  assert.equal(result.show, T3LIVE_SHOWS.SCOTT_MISC);
  assert.equal(result.host, T3LIVE_HOSTS.SCOTT);
  assert.equal(result.priority, T3LIVE_PRIORITY.MEDIUM);
});

test('Sami Abusaad named without Actionable Swing → sami_misc', () => {
  const result = classifyT3liveVideo('Weekend Review with Sami Abusaad');
  assert.equal(result.show, T3LIVE_SHOWS.SAMI_MISC);
  assert.equal(result.host, T3LIVE_HOSTS.SAMI);
});

test('Derrick (title spelling) → other / derreck', () => {
  const result = classifyT3liveVideo('Huge Week: Earnings + Election Day LIVE with Derrick Oldensmith');
  assert.equal(result.show, T3LIVE_SHOWS.OTHER);
  assert.equal(result.host, T3LIVE_HOSTS.DERRECK);
});

test('Adam → other / adam', () => {
  const result = classifyT3liveVideo('Adam\'s Trading Tips');
  assert.equal(result.show, T3LIVE_SHOWS.OTHER);
  assert.equal(result.host, T3LIVE_HOSTS.ADAM);
});

test('Michael → other / michael', () => {
  const result = classifyT3liveVideo('Michael\'s Morning Notes');
  assert.equal(result.show, T3LIVE_SHOWS.OTHER);
  assert.equal(result.host, T3LIVE_HOSTS.MICHAEL);
});

test('unknown title → other / unknown', () => {
  const result = classifyT3liveVideo('Morning Market Brief');
  assert.equal(result.show, T3LIVE_SHOWS.OTHER);
  assert.equal(result.host, T3LIVE_HOSTS.UNKNOWN);
  assert.equal(result.priority, T3LIVE_PRIORITY.MEDIUM);
});

test('empty title → other / unknown', () => {
  const result = classifyT3liveVideo('');
  assert.equal(result.show, T3LIVE_SHOWS.OTHER);
  assert.equal(result.host, T3LIVE_HOSTS.UNKNOWN);
});

test('case insensitive: ACTIONABLE SWING TRADE IDEAS', () => {
  const result = classifyT3liveVideo('ACTIONABLE SWING TRADE IDEAS — Q1 2026');
  assert.equal(result.show, T3LIVE_SHOWS.ACTIONABLE_SWINGS);
});

test('case insensitive: 630 CLUB', () => {
  const result = classifyT3liveVideo('THE 630 CLUB LIVE');
  assert.equal(result.show, T3LIVE_SHOWS.CLUB_630);
});

// ─── Quarantine filter ─────────────────────────────────────────────────────

test('educational "how to read" title is quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'How to Read a Candlestick Chart' });
  assert.equal(result.quarantined, true);
  assert.equal(result.reason, 'non_market_series');
});

test('educational "introduction to" title is quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'Introduction to Options Trading' });
  assert.equal(result.quarantined, true);
});

test('educational "basics of" title is quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'Basics of Technical Analysis' });
  assert.equal(result.quarantined, true);
});

test('educational "beginner guide" title is quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'Beginner Guide to Swing Trading' });
  assert.equal(result.quarantined, true);
});

test('Actionable Swing Trade Ideas is NOT quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'Actionable Swing Trade Ideas — NVDA, AAPL' });
  assert.equal(result.quarantined, false);
});

test('630 Club is NOT quarantined', () => {
  const result = t3liveVideoQuarantine({ title: 'The 630 Club — Morning Preview' });
  assert.equal(result.quarantined, false);
});

test('unknown title is NOT quarantined (permissive default)', () => {
  const result = t3liveVideoQuarantine({ title: 'Morning Market Brief' });
  assert.equal(result.quarantined, false);
});

test('empty title is NOT quarantined', () => {
  const result = t3liveVideoQuarantine({ title: '' });
  assert.equal(result.quarantined, false);
});

test('null video is NOT quarantined', () => {
  const result = t3liveVideoQuarantine(null);
  assert.equal(result.quarantined, false);
});
