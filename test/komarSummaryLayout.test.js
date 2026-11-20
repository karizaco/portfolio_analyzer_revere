'use strict';

// The Komar WEEKEND-REPORT SUMMARY reader.
//
// THE RULE THIS FILE EXISTS TO PIN
//
// The two Summary PDFs are in DIFFERENT FORMATS, and the difference is
// the whole difficulty:
//
//   16 August: "VFF (Village Farms) -- commentary. [square] verdict."
//   24 August: "DFDV: commentary. [square]"
//
// The square is a ZapfDingbats filled square that the TEXT LAYER
// renders as the letter "I", and it is GLUED to what follows it -- so
// every entry of the 24 August file but the first reads as "ISBET"
// where the ticker is SBET. The corpus's own trade log confirms it: it
// carries BMNR for the entry the text layer reads as "IBMNR".
//
// The two files are pinned as TEXT (their PDFs are paid and outside the
// repository), so this suite needs no corpus.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SUMMARY_SECTIONS,
  parseSummaryDocument,
  splitEntries,
  splitSections,
  stanceForVerdict,
} = require('../src/komar/summaryLayout');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'komar_summaries');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
}

/**
 * The readings of a pinned summary, parsed the way the tool parses a
 * document -- from the pinned text rather than from a PDF.
 */
function parseText(text) {
  const readings = [];
  for (const section of splitSections(text)) {
    if (section.section === 'Stocks Holding Up / Under Watch'
      || section.section === 'Commodities & Crypto') {
      for (const entry of splitEntries(section.body, false)) {
        readings.push({ kind: 'holding', ...entry, section: section.section });
      }
      continue;
    }
    readings.push({ kind: 'market', section: section.section, subject: '', text: section.body });
  }
  return readings;
}

test('the fixtures are the summaries they claim to be', () => {
  const info = manifest();
  for (const entry of info.files) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, entry.file));
    assert.equal(crypto.createHash('md5').update(bytes).digest('hex'), entry.md5, entry.file);
  }
});

test('the title\'s own word "Summary" does not split the document', () => {
  // The title is "Julian Komar Weekend-Report Summary", and the last
  // section is called "Summary". A reader that searched the whole text
  // would cut the document at the TITLE's word.
  const text = fixture('20250816.txt');
  const sections = splitSections(text);
  const names = sections.map((section) => section.section);
  // The 16 August file has no "Additional Mentions" section -- the
  // 24 August file has it and the 16 August one does not.
  assert.deepEqual(names, [
    'Market Trend Analysis',
    'Commodities & Crypto',
    'Stocks Holding Up / Under Watch',
    'Summary',
  ]);
  assert.ok(names.every((name) => SUMMARY_SECTIONS.includes(name)));
});

test('the 16 August summary reads its holdings, their names and their verdicts', () => {
  const readings = parseText(fixture('20250816.txt'));
  const holdings = readings.filter((reading) => reading.section === 'Stocks Holding Up / Under Watch');
  assert.equal(holdings.length, 13);
  assert.deepEqual(
    holdings.map((holding) => holding.subject),
    ['VFF', 'TLRY', 'HIPO', 'LMND', 'AFRM', 'TREE', 'SOFI', 'LC', 'TEM', 'HNGE', 'LQDA', 'RSI', 'U']
  );
  // The names come from the brackets.
  assert.equal(holdings[0].name, 'Village Farms');
  assert.equal(holdings[0].verdict, 'Needs moreconsolidation.');
  // And the commentary is the line WITHOUT its subject.
  assert.match(holdings[0].text, /^Leading cannabis stock/);
  // The verdict is a stance.
  assert.equal(holdings[0].stance, 'neutral');
  assert.equal(holdings[3].stance, 'neutral');
  assert.equal(holdings[4].stance, 'bullish');
  assert.equal(holdings[1].stance, 'bearish');
});

test('the 24 August summary strips the square from its tickers', () => {
  const readings = parseText(fixture('20250824.txt'));
  const holdings = readings.filter((reading) => reading.section === 'Stocks Holding Up / Under Watch');
  assert.equal(holdings.length, 19);
  // "ISBET" is SBET, and "IBMNR" is BMNR -- the corpus's own trade
  // log carries BMNR.
  assert.deepEqual(
    holdings.map((holding) => holding.subject),
    ['DFDV', 'SBET', 'BMNR', 'UPXI', 'BTCM', 'VERB', 'BTCS', 'INVZ', 'LIDR',
      'OUST', 'NIO', 'XPEV', 'NIU', 'LI', 'VSAT', 'LASR', 'U', 'LMND', 'PGY']
  );
  // The raw form is kept beside the reading, so it can be checked.
  assert.equal(holdings[2].raw_subject, 'IBMNR');
  assert.equal(holdings[2].subject, 'BMNR');
  // This format has no verdict.
  assert.equal(holdings[0].verdict, '');
});

test('the commodities section is read as entries too', () => {
  const readings = parseText(fixture('20250816.txt'));
  const commodities = readings.filter((reading) => reading.section === 'Commodities & Crypto');
  assert.deepEqual(
    commodities.map((entry) => entry.subject),
    ['Oil', 'Gold', 'Silver', 'Platinum', 'Bitcoin', 'Ethereum']
  );
  assert.equal(commodities[4].stance, 'bearish');
  assert.equal(commodities[5].stance, 'bullish');
});

test('the prose sections are one reading each', () => {
  const readings = parseText(fixture('20250816.txt'));
  const prose = readings.filter((reading) => reading.kind === 'market');
  assert.equal(prose.length, 2);
  assert.match(prose[0].text, /NASDAQ remains in a strong uptrend/);
  assert.match(prose[1].text, /broader market remains favorable/);
});

test('a verdict is read whatever the extraction did to its spaces', () => {
  // The extraction dropped the space at a line break INSIDE the
  // verdict, so "Needs more consolidation" comes back as
  // "Needs moreconsolidation".
  assert.equal(stanceForVerdict('Needs more consolidation.'), 'neutral');
  assert.equal(stanceForVerdict('Needs moreconsolidation.'), 'neutral');
  assert.equal(stanceForVerdict('Needsmore consolidation.'), 'neutral');
  assert.equal(stanceForVerdict('Setting up and ready.'), 'bullish');
  assert.equal(stanceForVerdict('Too choppy.'), 'bearish');
  assert.equal(stanceForVerdict('Not favorable.'), 'bearish');
  // An unknown verdict has no stance rather than a made-up one.
  assert.equal(stanceForVerdict('Who knows.'), '');
  assert.equal(stanceForVerdict(''), '');
});

test('a document without the corpus is not read as a summary', () => {
  // The reader is only ever pointed at a summary, but the tool must
  // not invent readings from a document that has none.
  const parsed = parseSummaryDocument(path.join(FIXTURE_DIR, 'manifest.json'));
  assert.equal(parsed.readings.length, 0);
});
