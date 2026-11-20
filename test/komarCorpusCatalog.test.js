'use strict';

// The Komar corpus walk and the filename grammar.
//
// THE RULES THAT NEED PINNING
//
// 1. The `_finished` FOLDER IS PART OF THE CORPUS. Its name says what it
//    holds; it does not say the content is finished, and the root folder
//    holds three videos from 2022 beside the newest ones. A walker that
//    treated the root as "current" would mis-date a third of the corpus.
//
// 2. A WEEKLY SESSION IS NAMED AFTER ITS REPORT NUMBER, not its date,
//    and the number is not chronological either -- 50 is January 2023
//    and 51 is January 2022. So a date can never be derived from the
//    number, and the parser never tries.
//
// 3. The SESSION ORDER is in the name: the three files of a weekly
//    report are "Market Overview", "My Portfolio" and "Stocks Analysis",
//    or the older "Premium" / "Premium-01" / "Premium-02" naming. The
//    order is what a later phase needs to stitch a session back
//    together.
//
// 4. A DATE IS ONLY A DATE WITH A MONTH NAME. "Trade Review July 2025"
//    is dated and "1 5 hours chart analysis" is not, and the rule that
//    separates them is the month word -- not the digits.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cleanTitle,
  listCorpus,
  parseDateInName,
  parseDocumentName,
  parseVideoName,
} = require('../src/komar/corpusCatalog');

test('a weekly session is named after its report number', () => {
  const video = parseVideoName('Weekend-Report 226 - Stocks Analysis.mp4');
  assert.equal(video.kind, 'weekend');
  assert.equal(video.reportNumber, '226');
  assert.equal(video.part, 'stocks_analysis');
  assert.equal(video.partIndex, 3);
  assert.equal(video.sessionDate, '', 'a report number is not a date');
});

test('the three parts of a weekly session keep their order', () => {
  const overview = parseVideoName('Weekend-Report 226 - Market Overview.mp4');
  const portfolio = parseVideoName('Weekend-Report 226 - My Portfolio.mp4');
  const stocks = parseVideoName('Weekend-Report 226 - Stocks Analysis.mp4');
  assert.equal(overview.partIndex, 1);
  assert.equal(portfolio.partIndex, 2);
  assert.equal(stocks.partIndex, 3);
});

test('the older naming of the same three parts is understood', () => {
  const main = parseVideoName('Weekend-Report 197 MARKET UPDATE Premium.mp4');
  const second = parseVideoName('Weekend-Report 197 MARKET UPDATE Premium-01.mp4');
  const third = parseVideoName('Weekend-Report 197 MARKET UPDATE Premium-02.mp4');
  assert.equal(main.part, 'main');
  assert.equal(second.part, 'part_01');
  assert.equal(third.part, 'part_02');
  assert.equal(main.partIndex, 1);
  assert.equal(second.partIndex, 2);
  assert.equal(third.partIndex, 3);
});

test('the report number is not a date and is never turned into one', () => {
  // 50 is January 2023 and 51 is January 2022: the numbering is not
  // chronological, so a parser that derived a year from it would be
  // inventing data.
  const video = parseVideoName('January 08 2023 Weekend-Report 50 MARKET UPDATE Premium.mp4');
  assert.equal(video.kind, 'weekend');
  assert.equal(video.reportNumber, '50');
  assert.equal(video.sessionDate, '20230108');
  assert.equal(video.datePrecision, 'day');
});

test('a report named with a space instead of a hyphen is the same series', () => {
  const video = parseVideoName('Weekend Report 129 MARKET UPDATE Premium.mp4');
  assert.equal(video.kind, 'weekend');
  assert.equal(video.reportNumber, '129');
});

test('a part label without its dash is still a part label', () => {
  const video = parseVideoName('Weekend-Report 224 Market Overview.mp4');
  assert.equal(video.part, 'market_overview');
  assert.equal(video.partIndex, 1);
});

test('the mid-week, daily, webinar and lesson kinds are told apart', () => {
  assert.equal(parseVideoName('April 15 2026 Mid-Week Update.mp4').kind, 'midweek');
  assert.equal(parseVideoName('October 1 2025 Mid-Week Update MARKET UPDATE Premium.mp4').kind, 'midweek');
  assert.equal(parseVideoName('Member Webinar 4 Daily and Weekly Routine MARKET UPDATE Premium.mp4').kind, 'webinar');
  assert.equal(parseVideoName('EPS 1 What is your number 1 challenge as a trader MARKET UPDATE Premium.mp4').kind, 'lesson');
  assert.equal(parseVideoName('Position Sizing.mp4').kind, 'lesson');
});

test('a date needs a month name', () => {
  assert.deepEqual(parseDateInName('Trade Review July 2025'), { date: '20250701', precision: 'month' });
  assert.deepEqual(parseDateInName('April 15 2026'), { date: '20260415', precision: 'day' });
  assert.deepEqual(parseDateInName('January 08 2023'), { date: '20230108', precision: 'day' });
  assert.equal(parseDateInName('1 5 hours chart analysis'), null);
  assert.equal(parseDateInName('My trading goals for 2023'), null);
  assert.equal(parseDateInName('EPS 1 What is your number 1 challenge'), null);
});

test('a document filename gives its date and its slug', () => {
  assert.deepEqual(parseDocumentName('komar_20260509.pdf'), {
    fileDate: '20260509',
    fileDatePrecision: 'day',
    slug: '',
    stem: 'komar_20260509',
  });
  assert.deepEqual(parseDocumentName('komar_20260504_biggest_losses.pdf'), {
    fileDate: '20260504',
    fileDatePrecision: 'day',
    slug: 'biggest_losses',
    stem: 'komar_20260504_biggest_losses',
  });
  assert.deepEqual(parseDocumentName('20250125_weekend_report.pdf'), {
    fileDate: '20250125',
    fileDatePrecision: 'day',
    slug: 'weekend_report',
    stem: '20250125_weekend_report',
  });
  assert.equal(parseDocumentName('core_strategy_v2.pdf').fileDate, '');
  assert.equal(parseDocumentName('core_strategy_v2.pdf').slug, 'core_strategy_v2');
});

test("a document's filename date carries the precision it actually has", () => {
  // "Trades-August-2025.pdf" names a MONTH, and it is the wrong month:
  // the deck's own first slide says "July 2025 Trades". So the name's
  // date is recorded with a month precision, and the catalog can see
  // that the name and the content disagree.
  const deck = parseDocumentName('Trades-August-2025.pdf');
  assert.equal(deck.fileDate, '20250801');
  assert.equal(deck.fileDatePrecision, 'month');
  assert.equal(deck.slug, 'Trades-August-2025');
  // And a name with no month word has no date at all.
  const undated = parseDocumentName('core_strategy_v2.pdf');
  assert.equal(undated.fileDate, '');
  assert.equal(undated.fileDatePrecision, '');
});

test("a video's filename date carries its precision too", () => {
  assert.equal(parseVideoName('April 15 2026 Mid-Week Update.mp4').datePrecision, 'day');
  assert.equal(parseVideoName('April 2026 - Screening routine.mp4').datePrecision, 'month');
  assert.equal(parseVideoName('Position Sizing.mp4').datePrecision, '');
});

test('the corpus walk reads BOTH folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-corpus-'));
  try {
    fs.writeFileSync(path.join(root, 'komar_20260509.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'Weekend-Report 226 - Stocks Analysis.mp4'), 'x');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    const archive = path.join(root, '_finished');
    fs.mkdirSync(archive);
    fs.writeFileSync(path.join(archive, 'Weekend_Report_Summary_Corrected.pdf'), 'x');
    fs.writeFileSync(path.join(archive, 'Position Sizing.mp4'), 'x');

    const corpus = listCorpus(root);
    assert.equal(corpus.documents.length, 2);
    assert.equal(corpus.videos.length, 2);
    // The archive is read, so its files are in the corpus, not skipped.
    assert.equal(corpus.videos.filter((video) => video.folder === '_finished').length, 1);
    assert.equal(corpus.documents.filter((doc) => doc.folder === '_finished').length, 1);
    // An unsupported extension is reported; a DIRECTORY is not, because
    // a sub-folder is a corpus folder and not a skipped file.
    assert.equal(corpus.skipped.length, 1);
    assert.equal(corpus.skipped[0].name, 'notes.txt');
    assert.equal(corpus.skipped[0].reason, 'unsupported_extension');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// The walker's edges: what it refuses, and what it does when the folder
// is not there.
// ---------------------------------------------------------------------------

test('a file the grammar does not recognise is skipped with a reason', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-corpus-'));
  try {
    // A name with nothing in front of the extension.
    fs.writeFileSync(path.join(root, '.pdf'), 'x');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    const corpus = listCorpus(root);
    assert.equal(corpus.documents.length, 0);
    assert.equal(corpus.videos.length, 0);
    const reasons = corpus.skipped.map((entry) => entry.reason).sort();
    assert.deepEqual(reasons, ['unrecognised_document_name', 'unsupported_extension']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corpus folder that is not there is empty, not an exception', () => {
  // The catalog checks the folder exists before it walks it, but a
  // walker that threw would take the whole run down over one missing
  // folder, and a missing folder is a fact worth reporting as an empty
  // corpus.
  const corpus = listCorpus(path.join(os.tmpdir(), 'komar-does-not-exist-xyz'));
  assert.deepEqual(corpus.documents, []);
  assert.deepEqual(corpus.videos, []);
  assert.deepEqual(corpus.skipped, []);
});

test('a title is cleaned of the publisher suffix and a leading dash', () => {
  assert.equal(cleanTitle('Weekend-Report 226 | MARKET UPDATE Premium'), 'Weekend-Report 226');
  assert.equal(cleanTitle('- Market Overview'), 'Market Overview');
  assert.equal(cleanTitle('  Position   Sizing  '), 'Position Sizing');
  assert.equal(cleanTitle(''), '');
});

test('the walker keeps the archive folder name on the row', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-corpus-'));
  try {
    fs.mkdirSync(path.join(root, '_finished'));
    fs.writeFileSync(path.join(root, '_finished', 'Position Sizing.mp4'), 'x');
    fs.writeFileSync(path.join(root, 'Weekend-Report 226 - Stocks Analysis.mp4'), 'x');
    const corpus = listCorpus(root);
    const byName = new Map(corpus.videos.map((video) => [video.fileName, video]));
    assert.equal(byName.get('Position Sizing.mp4').folder, '_finished');
    // The root's own files carry an EMPTY folder, not the root's path.
    assert.equal(byName.get('Weekend-Report 226 - Stocks Analysis.mp4').folder, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

