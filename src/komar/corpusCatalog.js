'use strict';

/**
 * The Komar corpus: the two folders, and what each file in them is.
 *
 * WHY THIS MODULE EXISTS
 *
 * The corpus is 143 files with three different naming conventions and
 * one lie in them. A catalog that guesses produces a catalog that is
 * wrong in a way nobody can see, so the grammar is written down here and
 * the guesses it cannot make are recorded as guesses.
 *
 * THE THREE NAMING CONVENTIONS
 *
 *   documents   `komar_20260509.pdf`            a dated report
 *               `komar_20260504_biggest_losses.pdf`
 *               `20250125_weekend_report.pdf`    a dated report, older style
 *               `core_strategy_v2.pdf`           an undated document
 *               `Trades-August-2025.pdf`         an undated document
 *
 *   videos      `Weekend-Report 226 - Stocks Analysis.mp4`
 *               `Weekend-Report 197 MARKET UPDATE Premium-01.mp4`
 *               `Weekend Report 129 MARKET UPDATE Premium.mp4`
 *               `January 08 2023 Weekend-Report 50 MARKET UPDATE Premium.mp4`
 *               `April 15 2026 Mid-Week Update.mp4`
 *               `Member Webinar 4 Daily and Weekly Routine.mp4`
 *               `Position Sizing.mp4`
 *
 *   The archive  the `_finished` sub-folder holds 97 of the videos, and
 *               the name says NOTHING about the content: the root folder
 *               holds three videos from 2022 beside the newest ones.
 *
 * THE LIE
 *
 * `komar_20260408.pdf` is named 2026-04-08. Its own title says
 * "April 8, 2025 -- Mid-Week Update" and its own URL says
 * `april-8-2025-...`. Two independent sources inside the document agree
 * on 2025. So the filename is a HINT and the document is the truth, and
 * the catalog records both and says which one it used.
 *
 * WHY THE DATE IS NOT ALWAYS IN THE FILENAME
 *
 * A weekly session's videos are named after its REPORT NUMBER, not its
 * date: "Weekend-Report 226 - Stocks Analysis". The number is not
 * chronological either -- 50 is January 2023 and 51 is January 2022 --
 * so the number can never be turned into a date. Only the document that
 * describes the session carries the date.
 */

/**
 * A document's filename.
 *
 *   `komar_20260509.pdf`                  -> date 20260509, no slug
 *   `komar_20260504_biggest_losses.pdf`   -> date 20260504, slug biggest_losses
 *   `20250125_weekend_report.pdf`         -> date 20250125, slug weekend_report
 *   `core_strategy_v2.pdf`                -> no date, slug core_strategy_v2
 */
const DOCUMENT_NAME = /^(?:komar_)?(?:(\d{8})(?:_(.+))?|(.+))\.pdf$/i;

/**
 * A video's weekend-report name.
 *
 * The spelling varies: "Weekend-Report 226", "Weekend Report 129". Both
 * are the same series, and the corpus holds both.
 */
const VIDEO_WEEKEND = /Weekend[ -]Report\s+(\d+)(.*)$/i;

/** A member webinar. */
const VIDEO_WEBINAR = /Member\s+Webinar\s+(\d+)\s*(.*)$/i;

/** The weekly session's three named parts. */
const VIDEO_PART_LABELS = [
  ['market overview', 'market_overview'],
  ['my portfolio', 'my_portfolio'],
  ['stocks analysis', 'stocks_analysis'],
];

/** The publisher's own suffix, which is not part of a title. */
const PUBLISHER_SUFFIX = /\s*\|\s*MARKET UPDATE Premium\s*$/i;
const PUBLISHER_SUFFIX_PLAIN = /\s+MARKET UPDATE Premium\s*$/i;

/**
 * A trailing part number: "... Premium-01", "... mind -01".
 *
 * The number is the SESSION ORDER, so the three files of a weekly report
 * are part 1, part 2 and part 3 in the order they are numbered.
 */
const VIDEO_PART_INDEX = /[-–—]\s*(\d{2})$/;

/**
 * A date in a filename.
 *
 * The month name is required: it is what keeps "Trade Review July 2025"
 * dated and "1 5 hours chart analysis" not, and what keeps "My trading
 * goals for 2023" a title rather than a date.
 */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const MONTH_INDEX = new Map(MONTH_NAMES.map((name, index) => [name, index + 1]));

/**
 * A date in a filename.
 *
 * The separator between the month and the year may be a space or a
 * hyphen: "April 15 2026", "August-2025", "Trade Review July 2025".
 * The day group is optional and is only taken when what follows it
 * really is a year, so "August-2025" reads as a MONTH and not as the
 * first and second digits of the year.
 */
const DATE_IN_NAME = new RegExp(
  `\\b(${MONTH_NAMES.join('|')})\\s*[-–—]?\\s*(\\d{1,2})?,?\\s*(\\d{4})\\b`,
  'i'
);

/**
 * A date in a filename, with the precision it carries.
 *
 * @param {string} name
 * @returns {{date: string, precision: 'day'|'month'}|null}
 */
function parseDateInName(name) {
  const match = DATE_IN_NAME.exec(String(name || ''));
  if (!match) return null;
  const month = MONTH_INDEX.get(match[1].toLowerCase());
  if (!month) return null;
  const year = Number(match[3]);
  if (match[2]) {
    const day = Number(match[2]);
    if (!isValidDay(year, month, day)) return null;
    return { date: `${year}${pad2(month)}${pad2(day)}`, precision: 'day' };
  }
  return { date: `${year}${pad2(month)}01`, precision: 'month' };
}

/**
 * @param {number} value
 * @returns {string}
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Is this day in this month?
 *
 * A date reader that accepts "February 31" stores 20260231, and a
 * session dated to the 31st of February is a session that never
 * happened. The corpus's own dates are all real, so a bad one is a
 * typo -- and a typo is not a date.
 *
 * @param {number} year
 * @param {number} month - 1..12
 * @param {number} day
 * @returns {boolean}
 */
function isValidDay(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let max = lengths[month - 1];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) max = 29;
  return day <= max;
}

/**
 * The parts of a document's filename.
 *
 * THE DATE IN THE NAME IS A HINT, AND IT HAS A PRECISION.
 *
 * `komar_20260509.pdf` carries a day. `Trades-August-2025.pdf` carries a
 * MONTH, and it carries the WRONG month -- its first slide says "July
 * 2025 Trades". So the name's date is recorded with the precision it
 * actually has, and it is recorded even when the document's own date
 * disagrees with it. A consumer that wants only exact dates can ask
 * for precision 'day'.
 *
 * @param {string} fileName
 * @returns {{fileDate: string, fileDatePrecision: string, slug: string, stem: string}|null}
 *   null when the name is not one of ours.
 */
function parseDocumentName(fileName) {
  const name = String(fileName || '');
  const match = DOCUMENT_NAME.exec(name);
  if (!match) return null;
  const stem = name.replace(/\.pdf$/i, '');
  const slug = match[2] || match[3] || '';
  let fileDate = match[1] || '';
  let fileDatePrecision = fileDate ? 'day' : '';
  if (!fileDate) {
    // No YYYYMMDD date: the name may still carry a month and a year.
    const written = parseDateInName(stem);
    if (written) {
      fileDate = written.date;
      fileDatePrecision = written.precision;
    }
  }
  return {
    fileDate,
    fileDatePrecision,
    slug: slug.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, ''),
    stem,
  };
}

/**
 * The parts of a video's filename.
 *
 * The kind is decided here, from the name, and it is the only place that
 * decides it: a weekly session is a weekly session whether or not a
 * document describes it.
 *
 * @param {string} fileName
 * @returns {{
 *   kind: string, reportNumber: string, part: string, partIndex: number,
 *   sessionDate: string, datePrecision: string, title: string, slug: string
 * }|null}
 */
function parseVideoName(fileName) {
  const name = String(fileName || '').replace(/\.mp4$/i, '');
  if (!name) return null;

  // The part number is stripped FIRST, because it is a suffix on the
  // name and not part of the title: "Premium-01" is part 2 of a session
  // and "Premium" is not in the title at all.
  let working = name;
  let partIndex = 0;
  const partMatch = VIDEO_PART_INDEX.exec(working);
  if (partMatch) {
    partIndex = Number(partMatch[1]);
    working = working.slice(0, partMatch.index).trim();
  }

  const date = parseDateInName(working);
  const datePart = date ? date.date : '';
  const datePrecision = date ? date.precision : '';

  // The publisher's suffix goes next, for the same reason.
  working = working.replace(PUBLISHER_SUFFIX_PLAIN, '').trim();

  let kind = 'lesson';
  let reportNumber = '';
  let part = '';
  let webinarNumber = '';

  // The series is matched ANYWHERE in the name, not only at the start:
  // "January 08 2023 Weekend-Report 50 ..." is a weekly session whose
  // name happens to start with its date.
  const weekend = VIDEO_WEEKEND.exec(working);
  if (weekend) {
    kind = 'weekend';
    reportNumber = weekend[1];
  } else {
    const webinar = VIDEO_WEBINAR.exec(working);
    if (webinar) {
      kind = 'webinar';
      webinarNumber = webinar[1];
    } else if (/mid[-\s]week/i.test(working)) {
      kind = 'midweek';
    } else if (/daily market update/i.test(working)) {
      kind = 'daily';
    }
  }

  // The part label, if the name carries one.
  const lowered = working.toLowerCase();
  for (const [needle, label] of VIDEO_PART_LABELS) {
    if (lowered.includes(needle)) {
      part = label;
      break;
    }
  }
  // A weekly session's FIRST file carries no part label at all -- it is
  // just "Weekend-Report 197 MARKET UPDATE Premium". That is part one of
  // three, and calling it "main" says so without pretending to know
  // which of the three roles it plays.
  if (kind === 'weekend' && !part && partIndex) {
    part = `part_${String(partIndex).padStart(2, '0')}`;
  } else if (kind === 'weekend' && !part) {
    part = 'main';
  }

  // The session order. The named parts are 1/2/3 in session order, and
  // the numbered suffix is 2/3 for the "Premium-01"/"Premium-02" naming.
  let order = 0;
  if (part === 'market_overview') order = 1;
  else if (part === 'my_portfolio') order = 2;
  else if (part === 'stocks_analysis') order = 3;
  else if (part === 'main') order = 1;
  else if (partIndex) order = partIndex + 1;

  const title = cleanTitle(working);
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return {
    datePrecision,
    kind,
    part,
    partIndex: order,
    reportNumber,
    sessionDate: datePart,
    slug,
    title,
    webinarNumber,
  };
}

/**
 * A readable title out of the leftovers of a filename.
 *
 * @param {string} value
 * @returns {string}
 */
function cleanTitle(value) {
  return String(value || '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s*\|\s*MARKET UPDATE Premium\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The files in the corpus, split by what they are.
 *
 * BOTH the root folder and its sub-folders are read. The `_finished`
 * name is not a signal about the content: the root holds three videos
 * from 2022 beside the newest ones, so a walker that treated the root as
 * "current" would mis-date a third of the corpus.
 *
 * @param {string} sourceDir
 * @returns {{documents: object[], videos: object[], skipped: object[]}}
 */
function listCorpus(sourceDir) {
  const fs = require('node:fs');
  const path = require('node:path');

  const root = String(sourceDir || '');
  const folders = [''];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { documents: [], skipped: [], videos: [] };
  }
  for (const entry of entries) {
    if (entry.isDirectory()) folders.push(entry.name);
  }

  const documents = [];
  const videos = [];
  const skipped = [];

  for (const folder of folders) {
    const dir = folder ? path.join(root, folder) : root;
    let listing = [];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listing) {
      if (!entry.isFile()) {
        // A sub-folder is not a skipped file: it is read as a corpus
        // folder of its own, and reporting it as skipped would put a
        // false entry in the catalog's summary.
        continue;
      }
      const name = entry.name;
      if (/\.pdf$/i.test(name)) {
        const parsed = parseDocumentName(name);
        if (!parsed) {
          skipped.push({ folder, name, reason: 'unrecognised_document_name' });
          continue;
        }
        documents.push({ ...parsed, folder, fileName: name });
        continue;
      }
      if (/\.mp4$/i.test(name)) {
        const parsed = parseVideoName(name);
        if (!parsed) {
          skipped.push({ folder, name, reason: 'unrecognised_video_name' });
          continue;
        }
        videos.push({ ...parsed, folder, fileName: name });
        continue;
      }
      skipped.push({ folder, name, reason: 'unsupported_extension' });
    }
  }

  const byName = (a, b) => (a.folder === b.folder
    ? a.fileName.localeCompare(b.fileName)
    : a.folder.localeCompare(b.folder));
  documents.sort(byName);
  videos.sort(byName);

  return { documents, skipped, videos };
}

module.exports = {
  DOCUMENT_NAME,
  MONTH_NAMES,
  VIDEO_PART_LABELS,
  VIDEO_WEEKEND,
  cleanTitle,
  isValidDay,
  listCorpus,
  parseDateInName,
  parseDocumentName,
  parseVideoName,
};






