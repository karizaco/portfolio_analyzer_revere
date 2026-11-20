'use strict';

// The two rails read off the frames on 2026-11-18. The first tests use the
// lines as they are on the screen. The last test uses the EasyOCR words of
// the same crops, axis included, and pins which of those words are positions.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { parseWatchlistLines, parseWatchlistWords, matchSectionHeader } = require('../src/martinlukkt/watchlist');

const RAIL_2026 = [
  'INDEXES',
  'QQQ 689.62 0.63%',
  'SPY 763.97 1.28%',
  'IWM 285.71 2.12%',
  'LONGS',
  'SSPC 9.85 10.25%',
  'SOXS 57.00 6.26%',
  'SHORTS',
  'BMNR 20.92 1.90%',
  'DRAM 46.18 -3.06%',
  'AXTI 49.49 -3.58%',
  'SKHY 145.37 -3.59%',
  'FOCUS',
  'CRWD 239.89 -1.96%',
  'XYZ 86.47 13.78%',
  'TRACKING',
  'SOXX 455.46 -2.05%',
  'TSLA 377.85 -5.18%',
  'TSLA Tesla, Inc. NASDAQ',
  '377.85 USD -20.65 -5.18%',
  'Market open',
];

const RAIL_2025 = [
  'INDEXES',
  'QQQ 603.66 -0.78%',
  'HOLDINGS',
  'MP 57.27 -0.47%',
  'UUUU 16.08 3.88%',
  'CVNA 320.22 0.53%',
  'UVXY 11.49 2.24%',
  'IDEA',
  'CORZ 14.90 -1.75%',
  'LONGS',
  'AMD 243.84 -1.66%',
  'RIVN 15.67 -4.39%',
  'OPEN 8.60 0.47%',
  'SHORTS',
  'NVDA 186.58 -0.15%',
  'TSLA 395.29 -1.67%',
  'BE 109.39 5.63%',
  'WAITLIST',
  'Market open',
];

test('the 2026 book is LONGS and SHORTS, not the tracking list', () => {
  const parsed = parseWatchlistLines(RAIL_2026);
  assert.deepEqual(parsed.positions.map((row) => `${row.side}:${row.ticker}`), [
    'long:SSPC', 'long:SOXS',
    'short:BMNR', 'short:DRAM', 'short:AXTI', 'short:SKHY',
  ]);
  assert.deepEqual(parsed.sections.TRACKING, ['SOXX', 'TSLA']);
  assert.equal(parsed.positions.some((row) => row.ticker === 'QQQ'), false);
});

test('the 2025 book includes HOLDINGS, and IDEA is not a position', () => {
  const parsed = parseWatchlistLines(RAIL_2025);
  assert.deepEqual(parsed.sections.HOLDINGS, ['MP', 'UUUU', 'CVNA', 'UVXY']);
  assert.equal(parsed.positions.filter((row) => row.section === 'HOLDINGS').length, 4);
  assert.equal(parsed.positions.some((row) => row.ticker === 'CORZ'), false);
  assert.equal(parsed.positions.some((row) => row.side === 'short' && row.ticker === 'BE'), true);
});

test('a flat list with no section header is not a book', () => {
  const parsed = parseWatchlistLines(['MRNA 24.96 -1.44%', 'UPST 37.29 -1.45%']);
  assert.equal(parsed.flat, true);
  assert.equal(parsed.positions.length, 0);
});

test('an OCR header is the section, and a percent is not a price', () => {
  assert.equal(matchSectionHeader('shorTS'), 'SHORTS');
  assert.equal(matchSectionHeader('hCLDINGS'), 'HOLDINGS');
  assert.equal(matchSectionHeader('L0*G5'), 'LONGS');
  assert.equal(matchSectionHeader('choats'), 'SHORTS');
  assert.equal(matchSectionHeader('IREN'), '');
  const parsed = parseWatchlistLines(['LONGS', 'SSPC 9.85 10.25%', 'AXTI ~3.383']);
  assert.deepEqual(parsed.positions.map((row) => row.ticker), ['SSPC', 'AXTI']);
  assert.equal(parsed.positions[1].price, null);
});

test('the two OCR rails: the book, and not the list beside it', () => {
  // EasyOCR words from the rail crops, 2026-11-18. The 2026 panel's book is
  // SSPC/SOXS long and BMNR/DRAM/AXTI/SKHY short. The 2025 panel's book is
  // MP/UUUU/CVNA/UVXY held, AMD/RIVN/OPEN long, and NVDA/TSLA/GLXY/IREN/OKLO/
  // SNDK/BE/HOOD short. CORZ and CLSK are IDEA. The axis is in the crop.
  const rails = JSON.parse(require('node:fs').readFileSync(
    path.join(__dirname, 'fixtures/martinlukkt/rail_words.json'),
    'utf8',
  ));
  const byImage = Object.fromEntries(rails.map((rail) => [rail.image, parseWatchlistWords(rail.words)]));
  const book = (image) => byImage[image].positions.map((row) => `${row.side}:${row.ticker}`);

  assert.deepEqual(book('t600_rail.png'), [
    'long:SSPC', 'long:SOXS',
    'short:BMNR', 'short:DRAM', 'short:AXTI', 'short:SKHY',
  ]);
  assert.equal(byImage['t600_rail.png'].positions.some((row) => row.ticker === 'X'), false);
  assert.equal(byImage['t600_rail.png'].sections.FOCUS.includes('SOXX'), false);

  const held = book('t2700_rail.png');
  assert.deepEqual(held.filter((row) => row.startsWith('held:')), ['held:UUUU', 'held:CVNA', 'held:UVXY']);
  assert.equal(held.includes('held:CORZ') || held.includes('long:CORZ'), false);
  assert.equal(held.includes('short:HILST'), false);
  assert.equal(held.includes('short:NVDA'), true);
  assert.equal(held.includes('short:HOOD'), true);
  // GLXY was read as GLY, and MP and BE were not read. A miss, not a guess.
  assert.equal(held.includes('short:GLY'), true);
  assert.equal(held.includes('short:GLXY'), false);
  assert.equal(held.includes('held:MP'), false);
});
