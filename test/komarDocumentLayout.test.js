'use strict';

// What a Komar document IS, and what it says about its session.
//
// THE RULES THAT NEED PINNING
//
// 1. THE KIND IS MEASURED, NOT GUESSED. The corpus holds three kinds of
//    PDF that all end in `.pdf`: a browser print (the body is vector
//    outlines and only the browser furniture is text), a machine-written
//    summary (one page, real text throughout) and a slide deck (16:9,
//    notes in text, tables in images). The filename does not say which:
//    `core_strategy_v2.pdf` is a print and `Trades-August-2025.pdf` is a
//    deck.
//
// 2. THE DOCUMENT'S OWN DATE BEATS THE FILENAME'S. Two documents in the
//    corpus are wrong about their own date:
//    `komar_20260408.pdf` is named 2026-04-08 and its title and URL
//    both say 2025-04-08; `Trades-August-2025.pdf` is named August and
//    its first slide says "July 2025 Trades".
//
// 3. THE CHAPTER LIST IS FREE. The site prints the video's chapter
//    timestamps next to the player, and they are the session's own
//    index -- the thing a transcript gets joined to later.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyDocument,
  classifyPage,
  parseUrlDate,
  parseWrittenDate,
  readChapters,
  readChrome,
  readReportNumber,
  readSectionKind,
  readSeries,
} = require('../src/komar/documentLayout');

/**
 * A page in the shape the PDF helper returns.
 */
function page(texts, options = {}) {
  return {
    height: 792,
    images: [],
    page: 1,
    text_blocks: texts.map((text, index) => ({
      bbox: [0, index * 10, 500, index * 10 + 9],
      font: options.font || 'CIDFont+F1',
      font_size: options.fontSize || 9.96,
      text,
    })),
    width: 612,
  };
}

test('a browser print is told by its own furniture', () => {
  const chrome = readChrome(page([
    'May 9, 2026 – Weekend-Report #226 | MARKET UPDATE Premiumhttps://members.julian-komar.com/c/weekly-videos/may-9-2026-weeke...',
    '1 of 82026-05-10, 12:52',
  ]));
  assert.ok(chrome);
  assert.equal(chrome.title, 'May 9, 2026 – Weekend-Report #226 | MARKET UPDATE Premium');
  assert.equal(chrome.pageNumber, 1);
  assert.equal(chrome.pageCount, 8);
  assert.equal(chrome.printStamp, '2026-05-10, 12:52');
});

test('the print timestamp is read in both of the formats the corpus carries', () => {
  const iso = readChrome(page([
    'Weekend-Report #226https://members.julian-komar.com/x1 of 82026-05-10, 12:52',
  ]));
  assert.equal(iso.printStamp, '2026-05-10, 12:52');
  const dmy = readChrome(page([
    'Weekend-Report #159https://members.julian-komar.com/x1 of 721/08/2025, 19:58',
  ]));
  assert.equal(dmy.printStamp, '21/08/2025, 19:58');
});

test('a page with no furniture is not a print', () => {
  assert.equal(readChrome(page(['July 2025 Trades', 'Before reviewAfter review'])), null);
  assert.equal(classifyPage(page(['July 2025 Trades'], { fontSize: 52 })), 'native');
});

test('a weekly report is a report, and it knows its number and its date', () => {
  const structure = {
    page_count: 8,
    pages: [page([
      'May 9, 2026 – Weekend-Report #226 | MARKET UPDATE Premiumhttps://members.julian-komar.com/c/weekly-videos/may-9-2026-weeke...',
      '1 of 82026-05-10, 12:52',
    ])],
  };
  const classified = classifyDocument(structure);
  assert.equal(classified.kind, 'report');
  assert.equal(classified.reportNumber, '226');
  assert.equal(classified.titleDate, '20260509');
  assert.equal(classified.urlDate, '20260509');
  assert.equal(classified.titleDatePrecision, 'day');
  assert.equal(classified.urlDatePrecision, 'day');
  assert.equal(classified.series, 'Weekend-Report');
  assert.equal(classified.hasChrome, true);
});

test('the section of the site decides what a document IS', () => {
  assert.equal(readSectionKind('https://members.julian-komar.com/c/weekly-videos/x'), 'report');
  assert.equal(readSectionKind('https://members.julian-komar.com/c/questions/x'), 'post');
  assert.equal(readSectionKind('https://members.julian-komar.com/c/trading-rules/x'), 'rule');
  assert.equal(readSectionKind('https://members.julian-komar.com/c/trading-lessons/x'), 'lesson');
  assert.equal(readSectionKind('https://example.com/nothing/x'), 'unknown');
});

test('a document that is NOT on the membership site is not a document of this source', () => {
  // The path alone says what a document is, but the path is only
  // meaningful on the membership site itself.
  const classified = classifyDocument({
    page_count: 2,
    pages: [page([
      'Some Other Site Weekly Notehttps://example.com/c/weekly-videos/x',
      '1 of 22026-05-10, 12:52',
    ])],
  });
  assert.equal(classified.kind, 'unknown');
  assert.equal(classified.hasChrome, true);
});

test('a document whose OWN date disagrees with its name still gives its own date', () => {
  // The measured case: komar_20260408.pdf.
  const structure = {
    page_count: 4,
    pages: [page([
      'April 8, 2025 – Mid-Week Update | MARKET UPDATE Premiumhttps://members.julian-komar.com/c/questions/april-8-2025-mid-wee...',
      '1 of 42026-05-10, 12:38',
    ])],
  };
  const classified = classifyDocument(structure);
  assert.equal(classified.kind, 'post');
  assert.equal(classified.titleDate, '20250408');
  assert.equal(classified.urlDate, '20250408');
  // Both independent sources inside the document agree on 2025, which is
  // what makes the filename the outlier.
  assert.equal(classified.titleDate, classified.urlDate);
});

test('the report number is read from the title and from the URL', () => {
  assert.equal(readReportNumber('May 9, 2026 – Weekend-Report #226 | MARKET UPDATE Premium', ''), '226');
  assert.equal(readReportNumber('Weekend-Report #159', ''), '159');
  assert.equal(readReportNumber('', 'https://members.julian-komar.com/c/weekly-videos/weekend-report-159'), '159');
  assert.equal(readReportNumber('Daily Market Update: Strong indices', ''), '');
});

test('a machine-written summary is a summary and carries its own date', () => {
  const structure = {
    page_count: 1,
    pages: [page([
      'This is for MARKET UPDATE Premium members only, please do not share',
      'Julian Komar Weekend-Report Summary',
      'August 24, 2025',
      'Market Trend Analysis',
    ], { font: 'Helvetica', fontSize: 10 })],
  };
  const classified = classifyDocument(structure);
  assert.equal(classified.kind, 'summary');
  assert.equal(classified.hasChrome, false);
  assert.equal(classified.titleDate, '20250824');
});

test('a slide deck is a deck and its content date beats its filename', () => {
  // The measured case: Trades-August-2025.pdf contains JULY 2025 trades.
  const structure = {
    page_count: 67,
    pages: [page([
      'July 2025 Trades',
      'Before reviewAfter review',
      '5* setups78',
    ], { font: 'font000000002e5704bf', fontSize: 52 })],
  };
  const classified = classifyDocument(structure);
  assert.equal(classified.kind, 'deck');
  assert.equal(classified.hasChrome, false);
  assert.equal(classified.title, 'July 2025 Trades');
  assert.equal(classified.titleDate, '20250701');
  // A deck that names its month says so; a consumer that wants only
  // exact dates has to be able to tell the difference.
  assert.equal(classified.titleDatePrecision, 'month');
});

test('the chapter list is read out of the furniture', () => {
  const chapters = readChapters(page([
    '14:07 24:01 April 25, 2026 – Weekend-Report #224 | MARKET UPDATE Premiumhttps://members.julian-komar.com/c/weekly-videos/x',
    '7 of 82026-05-10, 12:43',
  ]));
  assert.deepEqual(chapters, ['14:07', '24:01']);
});

test('a date written the way a person writes it is understood', () => {
  assert.deepEqual(parseWrittenDate('May 9, 2026 – Weekend-Report #226'), { date: '20260509', precision: 'day' });
  assert.deepEqual(parseWrittenDate('January 25, 2026'), { date: '20260125', precision: 'day' });
  assert.deepEqual(parseWrittenDate('July 2025 Trades'), { date: '20250701', precision: 'month' });
  assert.equal(parseWrittenDate('No date here'), null);
});

test('a date inside a URL is understood', () => {
  assert.deepEqual(parseUrlDate('https://members.julian-komar.com/c/weekly-videos/may-9-2026-weeke...'), {
    date: '20260509',
    precision: 'day',
  });
  assert.deepEqual(parseUrlDate('https://members.julian-komar.com/c/questions/april-8-2025-mid-wee'), {
    date: '20250408',
    precision: 'day',
  });
  assert.equal(parseUrlDate('https://members.julian-komar.com/c/weekly-videos/weekend-report-159'), null);
});




// ---------------------------------------------------------------------------
// The edges of the reader: what a page is, what a document with no
// readable structure does, and what the reader refuses.
// ---------------------------------------------------------------------------

test('a page is classified by what its text layer carries', () => {
  // The browser furniture.
  assert.equal(
    classifyPage(page([
      'May 9, 2026 - Weekend-Report #226https://members.julian-komar.com/x',
      '1 of 82026-05-10, 12:52',
    ])),
    'chrome'
  );
  // Real text, set large.
  assert.equal(classifyPage(page(['July 2025 Trades'], { fontSize: 52 })), 'native');
  // Real text, set small but in several blocks.
  assert.equal(classifyPage(page(['a', 'b', 'c'], { fontSize: 10 })), 'native');
  // Nothing but a stray glyph: the prose is drawn as outlines.
  assert.equal(classifyPage(page(['x'], { fontSize: 10 })), 'outline');
  // A page with no text at all.
  assert.equal(classifyPage({ text_blocks: [] }), 'outline');
});

test('a document with no readable structure does not throw', () => {
  // The catalog passes the helper's result straight through, and a
  // result can be an error object rather than a document.
  const classified = classifyDocument({ error: 'cannot open' });
  assert.equal(classified.kind, 'unknown');
  assert.equal(classified.hasChrome, false);
  assert.equal(classified.chapters.length, 0);
  assert.equal(classifyDocument({}).kind, 'unknown');
  assert.equal(classifyDocument(null).kind, 'unknown');
});

test('the series of a document is told by its title', () => {
  assert.equal(readSeries('May 9, 2026 - Weekend-Report #226', 'report'), 'Weekend-Report');
  assert.equal(readSeries('April 15, 2026 - Mid-Week Update', 'post'), 'Mid-Week Update');
  assert.equal(readSeries('Daily Market Update: Strong indices', 'post'), 'Daily Market Update');
  assert.equal(readSeries('Julian Komar Weekend-Report Summary', 'summary'), 'Weekend-Report Summary');
  assert.equal(readSeries('Core Strategy v2', 'rule'), '');
});

test('a page with no chapters returns none', () => {
  assert.deepEqual(readChapters(page(['July 2025 Trades', 'Before review'])), []);
});

test('a date with an impossible day is refused', () => {
  // A month name with a day that the month does not have is a typo,
  // not a date, and a date reader that accepts it invents one.
  assert.equal(parseWrittenDate('February 31, 2026'), null);
  assert.equal(parseWrittenDate('April 31, 2026'), null);
  assert.deepEqual(parseWrittenDate('February 28, 2026'), { date: '20260228', precision: 'day' });
});

test('the chapter list does not repeat across the pages of a document', () => {
  const structure = {
    page_count: 3,
    pages: [
      page([
        '14:07 April 25, 2026 - Weekend-Report #224https://members.julian-komar.com/x',
        '1 of 32026-05-10, 12:43',
      ]),
      page([
        '24:01 April 25, 2026 - Weekend-Report #224https://members.julian-komar.com/x',
        '2 of 32026-05-10, 12:43',
      ]),
      page([
        '14:07 April 25, 2026 - Weekend-Report #224https://members.julian-komar.com/x',
        '3 of 32026-05-10, 12:43',
      ]),
    ],
  };
  const classified = classifyDocument(structure);
  assert.deepEqual(classified.chapters, ['14:07', '24:01']);
});

