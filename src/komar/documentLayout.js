'use strict';

/**
 * Reading the Komar documents: what each PDF IS, and what it says about
 * the session it describes.
 *
 * WHY THE KIND IS MEASURED, NOT GUESSED
 *
 * The corpus holds three kinds of PDF that all end in `.pdf` and all
 * come out of a browser print, and the filename does not say which is
 * which:
 *
 *   1. A WEB-PAGE PRINT. The browser's own furniture -- the title, the
 *      URL, the page number and the print timestamp -- is a real text
 *      layer, and the page body is drawn as VECTOR OUTLINES. Measured
 *      on `komar_20260509.pdf` page 2: 1,295 `l` operators and 1,930
 *      `c` operators against FOUR text spans.
 *
 *   2. A MACHINE-WRITTEN SUMMARY. One page, no images, a real text
 *      layer throughout, a title and a date and a set of sections.
 *
 *   3. A SLIDE DECK. 16:9 slides whose notes are a real text layer and
 *      whose tables and charts are images.
 *
 * The only honest way to tell them apart is to read the text layer and
 * see whether it carries the browser furniture, so that is what this
 * module does. A filename cannot do it: `core_strategy_v2.pdf` is a
 * web-page print and `Trades-August-2025.pdf` is a deck.
 *
 * WHY THE CHROME DATE WINS
 *
 * `komar_20260408.pdf` is named 2026-04-08. Its title says
 * "April 8, 2025 -- Mid-Week Update" and its URL says
 * `april-8-2025-...`. Two independent sources inside the document agree
 * on 2025 and only the filename says 2026, so the filename is recorded
 * as a HINT and the chrome date is the date the catalog uses.
 */

const { MONTH_NAMES, isValidDay } = require('./corpusCatalog');
const { isKomarSourceUrl } = require('./channel');

/** A URL, anywhere in a block of text. */
const URL_PATTERN = /https?:\/\/[^\s]+/;

/**
 * The browser's page furniture: "7 of 8".
 *
 * NO leading word boundary, and a four-digit cap on both numbers. The
 * browser prints the page label right after the URL with nothing
 * between them, so the page number can abut a word character; and the
 * label is read only from AFTER the URL, so a title that happens to
 * contain "7 of 8" cannot be mistaken for the page label.
 */
const PAGE_LABEL_PATTERN = /(\d{1,4})\s+of\s+(\d{1,4})\b/;

/**
 * The print timestamp, in the two formats the corpus carries.
 *
 * NO leading word boundary. The browser prints the page label and the
 * stamp with NOTHING between them -- "1 of 82026-05-10, 12:52" -- so
 * the page count and the year run together, and a `\b` before the year
 * never matches. The stamp is therefore found FIRST and cut out of the
 * text before the page label is read; see `readChrome`.
 */
const PRINT_STAMP_ISO = /(\d{4}-\d{2}-\d{2}),\s*(\d{2}):(\d{2})/;
const PRINT_STAMP_DMY = /(\d{2}\/\d{2}\/\d{4}),\s*(\d{2}):(\d{2})/;

/** A date written the way a person writes it: "May 9, 2026". */
const TITLE_DATE = new RegExp(
  `\\b(${MONTH_NAMES.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`,
  'i'
);

/** A date written the way a person writes it, without the day. */
const TITLE_MONTH = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\s+(\\d{4})\\b`, 'i');

/** The report number in a title: "Weekend-Report #226". */
const REPORT_NUMBER = /Weekend[ -]Report\s*#\s*(\d+)/i;

/** The report number in a URL: "weekend-report-226". */
const REPORT_NUMBER_URL = /weekend-report-(\d+)/i;

/** A date inside a URL: "may-9-2026-weekend-report-226". */
const URL_DATE = new RegExp(
  `(${MONTH_NAMES.join('|')})-(\\d{1,2})-(\\d{4})(?:-|$)`,
  'i'
);

/** The chapter timestamps the site prints beside the video: "12:35 41:04". */
const CHAPTER_TIMESTAMPS = /((?:\d{1,2}:\d{2}\s*)+)/;

/** The membership site's sections, and what a document in each one is. */
const SECTION_KINDS = [
  ['/c/weekly-videos/', 'report'],
  ['/c/questions/', 'post'],
  ['/c/trading-rules/', 'rule'],
  ['/c/trading-lessons/', 'lesson'],
];

/** The summary document's own title. */
const SUMMARY_MARKER = 'Weekend-Report Summary';

/**
 * The month index, for turning "May" into 5.
 */
const MONTH_INDEX = new Map(MONTH_NAMES.map((name, index) => [name, index + 1]));

/**
 * @param {number} value
 * @returns {string}
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * The text of a page, with the blocks joined.
 *
 * @param {object} page - a page from the PDF helper
 * @returns {string}
 */
function pageText(page) {
  const blocks = (page && page.text_blocks) || [];
  return blocks.map((block) => block.text || '').join(' ');
}

/**
 * What KIND of page this is.
 *
 * @param {object} page
 * @returns {'chrome'|'native'|'outline'}
 */
function classifyPage(page) {
  const text = pageText(page);
  if (URL_PATTERN.test(text) && readPageLabel(text)) return 'chrome';
  const blocks = (page && page.text_blocks) || [];
  let maxSize = 0;
  for (const block of blocks) maxSize = Math.max(maxSize, Number(block.font_size) || 0);
  if (maxSize >= 12) return 'native';
  if (blocks.length >= 3) return 'native';
  return 'outline';
}

/**
 * The print stamp, cut out of a page's text.
 *
 * The browser prints the page label and the stamp with NOTHING between
 * them -- "1 of 82026-05-10, 12:52" -- so the page count and the year
 * run together. A page label read off the raw text reports EIGHT
 * THOUSAND AND TWENTY-SIX pages. So the stamp is found and cut out
 * FIRST, and the page label is read off what is left.
 *
 * @param {string} text
 * @returns {{printStamp: string, rest: string}}
 */
function stripPrintStamp(text) {
  const stampMatch = PRINT_STAMP_ISO.exec(text) || PRINT_STAMP_DMY.exec(text);
  if (!stampMatch) return { printStamp: '', rest: String(text || '') };
  return {
    printStamp: stampMatch[0],
    rest: `${text.slice(0, stampMatch.index)} ${text.slice(stampMatch.index + stampMatch[0].length)}`,
  };
}

/**
 * The browser's page label, read off a page's text.
 *
 * @param {string} text
 * @returns {RegExpExecArray|null}
 */
function readPageLabel(text) {
  return PAGE_LABEL_PATTERN.exec(stripPrintStamp(text).rest);
}

/**
 * The browser furniture on a page.
 *
 * @param {object} page
 * @returns {{title: string, url: string, pageNumber: number, pageCount: number, printStamp: string}|null}
 */
function readChrome(page) {
  const text = pageText(page);
  const urlMatch = URL_PATTERN.exec(text);
  if (!urlMatch) return null;

  const url = urlMatch[0];
  const title = text.slice(0, urlMatch.index).replace(CHAPTER_TIMESTAMPS, '').trim();

  const { printStamp, rest } = stripPrintStamp(text);

  // The label is read only from AFTER the URL, so a title that contains
  // "7 of 8" cannot be mistaken for the page furniture. If the print
  // put the URL and the label in one unbroken run, the URL swallows the
  // page number and the label has to be looked for in the whole of the
  // remaining text instead.
  const afterUrl = rest.slice(urlMatch.index + url.length);
  const labelMatch = PAGE_LABEL_PATTERN.exec(afterUrl) || PAGE_LABEL_PATTERN.exec(rest);
  if (!labelMatch) return null;

  return {
    pageCount: Number(labelMatch[2]),
    pageNumber: Number(labelMatch[1]),
    printStamp,
    title,
    url,
  };
}

/**
 * The chapter timestamps a page carries.
 *
 * The site prints them beside the video, and they are the session's own
 * chapter list -- a free index into the transcript for later phases.
 *
 * @param {object} page
 * @returns {string[]}
 */
function readChapters(page) {
  const text = pageText(page);
  const match = CHAPTER_TIMESTAMPS.exec(text);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/**
 * A date written the way a person writes it.
 *
 * @param {string} text
 * @returns {{date: string, precision: 'day'|'month'}|null}
 */
function parseWrittenDate(text) {
  const value = String(text || '');
  const day = TITLE_DATE.exec(value);
  if (day) {
    const month = MONTH_INDEX.get(day[1].toLowerCase());
    // A day the month does not have is a typo, and a typo is not a date.
    if (month && isValidDay(Number(day[3]), month, Number(day[2]))) {
      return { date: `${day[3]}${pad2(month)}${pad2(Number(day[2]))}`, precision: 'day' };
    }
  }
  const monthOnly = TITLE_MONTH.exec(value);
  if (monthOnly) {
    const month = MONTH_INDEX.get(monthOnly[1].toLowerCase());
    if (month) return { date: `${monthOnly[2]}${pad2(month)}01`, precision: 'month' };
  }
  return null;
}

/**
 * A date inside a URL.
 *
 * @param {string} url
 * @returns {{date: string, precision: 'day'}|null}
 */
function parseUrlDate(url) {
  const match = URL_DATE.exec(String(url || ''));
  if (!match) return null;
  const month = MONTH_INDEX.get(match[1].toLowerCase());
  if (!month || !isValidDay(Number(match[3]), month, Number(match[2]))) return null;
  return { date: `${match[3]}${pad2(month)}${pad2(Number(match[2]))}`, precision: 'day' };
}

/**
 * The report number a document describes.
 *
 * @param {string} title
 * @param {string} url
 * @returns {string}
 */
function readReportNumber(title, url) {
  const fromTitle = REPORT_NUMBER.exec(String(title || ''));
  if (fromTitle) return fromTitle[1];
  const fromUrl = REPORT_NUMBER_URL.exec(String(url || ''));
  return fromUrl ? fromUrl[1] : '';
}

/**
 * Which section of the membership site a document is from.
 *
 * @param {string} url
 * @returns {string} one of the document kinds
 */
function readSectionKind(url) {
  const value = String(url || '').toLowerCase();
  for (const [needle, kind] of SECTION_KINDS) {
    if (value.includes(needle)) return kind;
  }
  return 'unknown';
}

/**
 * The series a document belongs to.
 *
 * @param {string} title
 * @param {string} kind
 * @returns {string}
 */
function readSeries(title, kind) {
  const value = String(title || '');
  // The SUMMARY is checked FIRST, because its own title contains the
  // words "Weekend-Report" and would otherwise be read as a session.
  if (kind === 'summary' || /Weekend[ -]Report\s+Summary/i.test(value)) {
    return 'Weekend-Report Summary';
  }
  if (/Weekend[ -]Report/i.test(value)) return 'Weekend-Report';
  if (/Mid-Week Update/i.test(value)) return 'Mid-Week Update';
  if (/Daily Market Update/i.test(value)) return 'Daily Market Update';
  return '';
}

/**
 * What a document IS, and what it says about its session.
 *
 * @param {object} structure - the PDF helper's per-document result
 * @returns {object} the document's identity
 */
function classifyDocument(structure) {
  const pages = (structure && structure.pages) || [];
  const first = pages[0] || {};
  const blocks = first.text_blocks || [];
  const text = pageText(first);

  const chrome = readChrome(first);
  const chapters = [];
  for (const page of pages) {
    for (const stamp of readChapters(page)) {
      if (!chapters.includes(stamp)) chapters.push(stamp);
    }
  }

  if (chrome) {
    const titleDate = parseWrittenDate(chrome.title);
    const urlDate = parseUrlDate(chrome.url);
    // The section of the site says what the document IS, but only on
    // the site's own pages: a URL somewhere else that happens to have
    // the same path is not a document of this source.
    const kind = isKomarSourceUrl(chrome.url) ? readSectionKind(chrome.url) : 'unknown';
    return {
      chapters,
      hasChrome: true,
      kind,
      pageKind: 'chrome',
      printStamp: chrome.printStamp,
      reportNumber: readReportNumber(chrome.title, chrome.url),
      series: readSeries(chrome.title, kind),
      title: chrome.title,
      titleDate: titleDate ? titleDate.date : '',
      titleDatePrecision: titleDate ? titleDate.precision : '',
      url: chrome.url,
      urlDate: urlDate ? urlDate.date : '',
      urlDatePrecision: urlDate ? urlDate.precision : '',
    };
  }

  // No browser furniture. A document with no pages at all is a
  // document we could NOT read, and calling it a deck would count a
  // failure as a kind.
  if (!pages.length) {
    return {
      chapters,
      hasChrome: false,
      kind: 'unknown',
      pageKind: 'outline',
      printStamp: '',
      reportNumber: '',
      series: '',
      title: '',
      titleDate: '',
      titleDatePrecision: '',
      url: '',
      urlDate: '',
      urlDatePrecision: '',
    };
  }

  // A native document. The summary is a machine-written page of prose;
  // anything else is a slide deck.
  const titleBlock = blocks.find((block) => (block.font_size || 0) >= 14) || blocks[0] || null;
  const title = titleBlock ? String(titleBlock.text || '').trim() : '';
  const isSummary = text.includes(SUMMARY_MARKER);
  const written = parseWrittenDate(text);
  const bodyDate = parseWrittenDate(
    blocks
      .map((block) => block.text || '')
      .slice(1)
      .join(' ')
  );

  return {
    chapters,
    hasChrome: false,
    kind: isSummary ? 'summary' : 'deck',
    pageKind: classifyPage(first),
    printStamp: '',
    reportNumber: '',
    series: isSummary ? 'Weekend-Report Summary' : '',
    title,
    titleDate: bodyDate ? bodyDate.date : (written ? written.date : ''),
    titleDatePrecision: bodyDate ? bodyDate.precision : (written ? written.precision : ''),
    url: '',
    urlDate: '',
    urlDatePrecision: '',
  };
}

module.exports = {
  PAGE_LABEL_PATTERN,
  PRINT_STAMP_DMY,
  PRINT_STAMP_ISO,
  SECTION_KINDS,
  SUMMARY_MARKER,
  URL_PATTERN,
  classifyDocument,
  classifyPage,
  pageText,
  parseUrlDate,
  parseWrittenDate,
  readChapters,
  readChrome,
  readPageLabel,
  readReportNumber,
  readSectionKind,
  readSeries,
  stripPrintStamp,
};









