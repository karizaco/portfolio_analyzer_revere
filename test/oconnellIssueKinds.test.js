'use strict';

// The newsletter taxonomy: what kind of document this is.
//
// The corpus is not one kind of document. Measured over the 302 PDFs on
// 2026-11-14:
//
//   market_analysis_watchlist ... 211   the trading-day newsletter
//   weekend_watchlist .........  54   the Saturday one
//   research_note .............   3   short "EDUCATIONAL CONTENT" notes
//   training_note .............   2   three-page training posts
//   knowledge_hub .............   3   the guides
//   special ...................  29   one-off posts
//
// The kinds matter because they carry DIFFERENT CONTENT, and a document
// without a position log must be reported as ABSENCE rather than as zero
// holdings.
//
// The masthead is read by FONT SIZE and not by line order: the order
// changed between the 2024 and the 2026 templates, so a classifier that
// read "line 1 is the title" would be right about half the corpus.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyIssue,
  kindExpectsPositionLog,
  readMasthead,
} = require('../src/oconnell/issueKinds');

/**
 * A masthead in the shape the helper returns: the text blocks of page 1.
 *
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
function masthead(blocks) {
  return blocks.map((block) => ({
    bbox: block.bbox || [45, 67, 400, 90],
    font_size: block.font_size,
    text: block.text,
  }));
}

test('the masthead gives the title, the series and the publish time', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'NVDA Earnings Incoming!' },
    { font_size: 13.44, text: 'Market Analysis & Watchlist 11.12.26' },
    { font_size: 8.28, text: "ANDREW O'CONNELL, CFA, FRM" },
    { font_size: 8.28, text: '2 HOURS AGO ∙ PAID' },
    { bbox: [14, 0, 612, 11], font_size: 10, text: 'NVDA Earnings Incoming! - by Andrew O\'Connell, CFA, FRMhttps://www.pristinecapital.net/p/nvda-earnings' },
    { bbox: [0, 781, 612, 792], font_size: 10, text: '1 of 292026-11-13, 10:20' },
  ]));
  assert.equal(read.title, 'NVDA Earnings Incoming!');
  assert.equal(read.series, 'Market Analysis & Watchlist 11.12.26');
  assert.equal(read.publishDate, '2026-11-13');
  assert.equal(read.publishTime, '10:20');
  assert.equal(read.sourceUrl, 'https://www.pristinecapital.net/p/nvda-earnings');
  assert.equal(read.access, 'paid');
});

test('the publish timestamp is read in the 2024 format too', () => {
  const read = readMasthead(masthead([
    { bbox: [0, 831, 612, 842], font_size: 10, text: '1 of 1529/03/2025, 20:05' },
  ]));
  assert.equal(read.publishDate, '2025-03-29');
  assert.equal(read.publishTime, '20:05');
});

test('the trading-day newsletter is recognised', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'SPCX & AMD Earnings Incoming!' },
    { font_size: 13.44, text: 'Market Analysis & Watchlist 8.3.26' },
  ]));
  assert.equal(classifyIssue(read), 'market_analysis_watchlist');
});

test('the weekend newsletter is recognised', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'Q2 Earnings Season Begins!' },
    { font_size: 13.44, text: 'Pristine Weekend Watchlist 7.12.26' },
  ]));
  assert.equal(classifyIssue(read), 'weekend_watchlist');
});

test('the 2024 weekend newsletter is recognised even though the title carries the series', () => {
  // In the 2024 template the series line and the article title are
  // swapped relative to the 2026 one.
  const read = readMasthead(masthead([
    { font_size: 24, text: 'Pristine Weekend Watchlist 1.7.24' },
    { font_size: 13.44, text: 'CPI and Earnings Season Incoming!' },
  ]));
  assert.equal(classifyIssue(read), 'weekend_watchlist');
});

test('a research note is recognised', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'EDUCATIONAL CONTENT2024 PnL Review' },
    { font_size: 13.44, text: 'Reviewing the past to succeed in the 2025 US Investing Championship' },
  ]));
  assert.equal(classifyIssue(read), 'research_note');
});

test('a knowledge-hub guide is recognised', () => {
  const read = readMasthead(masthead([
    { font_size: 10.4, text: 'KNOWLEDGE HUB' },
    { font_size: 24, text: 'Pristine Adaptive Alpha Screener Guide' },
    { font_size: 13.44, text: 'Everything you need to know about the Pristine Screening Process' },
  ]));
  assert.equal(classifyIssue(read), 'knowledge_hub');
});

test('a training session is recognised', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'Power Earnings Gap Training!' },
    { font_size: 13.44, text: 'Pristine Training Session' },
  ]));
  assert.equal(classifyIssue(read), 'training_note');
});

test('a document that matches nothing is a special, not a failure', () => {
  const read = readMasthead(masthead([
    { font_size: 24, text: 'Thoughts from Day 2 of Vacation' },
    { font_size: 13.44, text: 'NVDA -4.99% into Elite 8 Earnings!' },
  ]));
  assert.equal(classifyIssue(read), 'special');
});

test('a free document is not a paid one', () => {
  const read = readMasthead(masthead([
    { font_size: 8.28, text: 'JAN 10, 2026' },
  ]));
  assert.equal(read.access, 'free');
});

test('only the trading-day newsletter is expected to carry a position log', () => {
  assert.ok(kindExpectsPositionLog('market_analysis_watchlist'));
  assert.ok(!kindExpectsPositionLog('weekend_watchlist'));
  assert.ok(!kindExpectsPositionLog('research_note'));
  assert.ok(!kindExpectsPositionLog('training_note'));
  assert.ok(!kindExpectsPositionLog('knowledge_hub'));
});
