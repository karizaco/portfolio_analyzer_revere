'use strict';

/**
 * The taxonomy of the O'Connell corpus, and the classifier that assigns a
 * document to it.
 *
 * WHY A TAXONOMY AT ALL
 *
 * The corpus is not one kind of document. Measured over the 302 PDFs in
 * the folder on 2026-11-14:
 *
 *   market_analysis_watchlist ... 211   the trading-day newsletter
 *   weekend_watchlist .........  54   the Saturday one
 *   research_note .............   3   short "EDUCATIONAL CONTENT" notes
 *   special ...................  34   one-off posts: P&L reviews, Knowledge
 *                                      Hub guides, vacation notes, recaps
 *
 * The kinds matter because they carry DIFFERENT CONTENT, and a document
 * without a position log must be reported as ABSENCE rather than as zero
 * holdings. The trading-day newsletter carries an "EOD Trade Blotter &
 * Position Log" section; the weekend one usually does not; a research note
 * never does. A reader who sees "0 positions" for a research note has
 * been told a falsehood, and the coverage funnel is where that
 * distinction has to be made.
 *
 * HOW THE KIND IS FOUND
 *
 * From the masthead of page 1, which has a stable shape across the corpus:
 *
 *   size 24.0   the ARTICLE TITLE
 *   size 13.4   the SERIES line ("Market Analysis & Watchlist 8.3.26")
 *   size 8.3    the byline, and the date / PAID line
 *   size 10.0   the print header (title + source URL) and the print
 *               footer ("21 of 21" + the publish timestamp)
 *
 * The font SIZE is the signal, not the line ORDER -- the order changed
 * between the 2024 and the 2026 templates (the 2024 masthead puts the
 * series line first on some issues and the title first on others), so a
 * classifier that read "line 1 is the title" would be right about half
 * the corpus.
 *
 * EVERY DOCUMENT IS CLASSIFIED, EVEN THE ODD ONES
 *
 * A kind that is not recognised is `special`, not an error. The corpus
 * contains vacation notes, conference recaps and championship write-ups,
 * and none of them is an error condition -- they are simply documents
 * with a different shape. Treating them as failures would have made the
 * coverage funnel lie about how much of the corpus was actually read.
 */

/** The kinds a document can be. */
const ISSUE_KINDS = Object.freeze([
  'market_analysis_watchlist',
  'weekend_watchlist',
  'research_note',
  'training_note',
  'knowledge_hub',
  'special',
]);

/** The kinds whose documents normally carry an EOD blotter / position log. */
const KINDS_WITH_POSITION_LOG = Object.freeze(['market_analysis_watchlist', 'special']);

/**
 * The series markers, in the order they are tested.
 *
 * The order matters: "EDUCATIONAL CONTENT" is a PREFIX on the title in the
 * 2025 template ("EDUCATIONAL CONTENT2024 PnL Review"), and it must be
 * tested before anything else or the P&L review would be read as a title.
 */
const SERIES_MARKERS = [
  { kind: 'research_note', pattern: /EDUCATIONAL CONTENT/i, scope: 'title' },
  // "KNOWLEDGE HUB" is a small uppercase label above the title, not a
  // series line, so it is looked for in the whole page.
  { kind: 'knowledge_hub', pattern: /KNOWLEDGE HUB/i, scope: 'page' },
  // The three-page training posts. They are not notes about the market
  // at all, so they never carry a position log, and a reader counting
  // coverage wants them counted separately.
  { kind: 'training_note', pattern: /Training Session|Holy Grail of Trading/i, scope: 'any' },
  { kind: 'weekend_watchlist', pattern: /Weekend\s+Watchlist/i, scope: 'any' },
  { kind: 'market_analysis_watchlist', pattern: /Market\s+Analysis\s*&\s*Watchlist/i, scope: 'any' },
  { kind: 'special', pattern: /USIC\s+Positions?\s+Update/i, scope: 'any' },
];

/** The masthead font size that carries the article title. */
const TITLE_FONT_SIZE = 22;

/** The masthead font size that carries the series line. */
const SERIES_FONT_SIZE = 12;

/** The masthead font size of the byline / date line. */
const META_FONT_SIZE = 8;

/** The print header / footer font size. */
const CHROME_FONT_SIZE = 10;

/**
 * The publish timestamp, as it appears in the print footer.
 *
 * Two formats, because the templates changed:
 *
 *   "1 of 292026-11-13, 10:20"     2026 -- the ISO date, run together
 *   "1 of 1529/03/2025, 20:05"      2024-2025 -- DD/MM/YYYY
 */
const PUBLISH_ISO = /(\d{4}-\d{2}-\d{2}),\s*(\d{1,2}:\d{2})/;
const PUBLISH_DMY = /(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{1,2}:\d{2})/;

/**
 * The source URL, which the print header carries next to the title.
 */
const SOURCE_URL = /(https?:\/\/[^\s"']+)/;

/**
 * The masthead of a document, read off page 1.
 *
 * @param {Array<{bbox: number[], font_size: number, text: string}>} blocks
 *   the page's text blocks, in the helper's shape
 * @returns {object} the masthead fields
 */
function readMasthead(blocks) {
  const masthead = {
    access: 'unknown',
    pageText: '',
    publishDate: '',
    publishTime: '',
    series: '',
    sourceUrl: '',
    title: '',
  };
  if (!Array.isArray(blocks)) return masthead;

  const pageTextParts = [];

  for (const block of blocks) {
    const text = String(block.text || '').trim();
    if (!text) continue;
    const size = Number(block.font_size || 0);
    const y = Number(block.bbox && block.bbox[1]);

    pageTextParts.push(text);

    // The print header carries the title AND the source URL, run together.
    if (size >= CHROME_FONT_SIZE - 0.5 && size <= CHROME_FONT_SIZE + 0.5 && y < 20) {
      const url = SOURCE_URL.exec(text);
      if (url && !masthead.sourceUrl) masthead.sourceUrl = url[1];
      continue;
    }

    // The print footer carries "N of M" and the publish timestamp.
    if (size >= CHROME_FONT_SIZE - 0.5 && size <= CHROME_FONT_SIZE + 0.5 && y > 100) {
      const iso = PUBLISH_ISO.exec(text);
      const dmy = PUBLISH_DMY.exec(text);
      if (iso && !masthead.publishDate) {
        masthead.publishDate = iso[1];
        masthead.publishTime = iso[2];
      } else if (dmy && !masthead.publishDate) {
        masthead.publishDate = `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
        masthead.publishTime = dmy[4];
      }
      continue;
    }

    // The PAID marker sits on the small byline/date line.
    if (size >= META_FONT_SIZE - 0.5 && size <= META_FONT_SIZE + 0.5) {
      if (/PAID/i.test(text)) masthead.access = 'paid';
      else if (!/PAID/i.test(text) && masthead.access === 'unknown' && /[A-Z]{3}\s+\d{2},\s+\d{4}/.test(text)) {
        masthead.access = 'free';
      }
      continue;
    }

    if (size >= TITLE_FONT_SIZE && !masthead.title) {
      masthead.title = text;
      continue;
    }
    if (size >= SERIES_FONT_SIZE && !masthead.series) {
      masthead.series = text;
    }
  }

  masthead.pageText = pageTextParts.join('\n');
  return masthead;
}

/**
 * The kind of a document, from its masthead.
 *
 * @param {{title: string, series: string, pageText?: string}} masthead
 * @returns {string} one of ISSUE_KINDS
 */
function classifyIssue(masthead) {
  const title = String((masthead && masthead.title) || '');
  const series = String((masthead && masthead.series) || '');
  const pageText = String((masthead && masthead.pageText) || '');
  for (const marker of SERIES_MARKERS) {
    let scope;
    if (marker.scope === 'title') scope = title;
    else if (marker.scope === 'series') scope = series;
    else if (marker.scope === 'page') scope = pageText;
    else scope = `${title} ${series}`;
    if (marker.pattern.test(scope)) return marker.kind;
  }
  return 'special';
}

/**
 * Does a document of this kind normally carry a position log?
 *
 * This is a PRIOR, not a measurement: a document is counted as having a
 * position log only when the extractor actually found one. The prior is
 * what the coverage funnel compares the measurement against, so that
 * "the weekend newsletter has no position log" and "we failed to read the
 * position log" do not look the same.
 *
 * @param {string} kind
 * @returns {boolean}
 */
function kindExpectsPositionLog(kind) {
  return KINDS_WITH_POSITION_LOG.includes(String(kind));
}

module.exports = {
  CHROME_FONT_SIZE,
  ISSUE_KINDS,
  KINDS_WITH_POSITION_LOG,
  META_FONT_SIZE,
  SERIES_FONT_SIZE,
  SERIES_MARKERS,
  TITLE_FONT_SIZE,
  classifyIssue,
  kindExpectsPositionLog,
  readMasthead,
};
