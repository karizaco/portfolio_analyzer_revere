'use strict';

// Content classification for the martinlukkt channel.
//
// THE DATE IS IN THE TITLE
//
// Measured on the 113-stream listing (2026-11-18): the flat playlist returns
// no upload_date, and 112 of 113 titles end in "| D Mon YYYY" (one has a
// trailing space). That date is the SESSION date -- the day he is talking
// about -- which can be the day before YouTube's upload timestamp. A stream
// titled "25 Nov 2025" was uploaded on 2025-11-26. The title wins.
//
// THE SESSION KIND
//
// Most streams are live trading commentary. A few are a review of trades
// already taken ("Oct trades | 25 Nov 2025"): he walks old charts and says
// "I bought" about days that are not the session date. Those are stored,
// and they are not scored as calls made on the session date. "short" in a
// title ("SOXX short", "Pullback short") is a live theme, not a review.

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Titles that are a look back at trades already taken, not a live session. */
const REVIEW_TITLE = /\btrades\b/i;

/**
 * The session date in a title, as YYYYMMDD, or '' when the title has none.
 *
 * The date is the last "| D Mon YYYY", so a topic that itself contains a
 * date does not win. Trailing space is ignored.
 *
 * @param {string} title
 * @returns {string}
 */
function dateFromTitle(title) {
  const text = String(title || '').trim();
  const match = text.match(/\|\s*(\d{1,2})\s+([A-Za-z]{3})\s+(20\d{2})\s*$/);
  if (!match) return '';
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return '';
  const day = Number(match[1]);
  if (day < 1 || day > 31) return '';
  return `${match[3]}${month}${String(day).padStart(2, '0')}`;
}

/**
 * `review` when the title is a look back at finished trades, else `live`.
 *
 * @param {string} title
 * @returns {'live'|'review'}
 */
function sessionKind(title) {
  return REVIEW_TITLE.test(String(title || '')) ? 'review' : 'live';
}

/**
 * Uppercase ticker-shaped tokens in a title, excluding month names.
 *
 * Auto-captions rarely capitalise a ticker, so the title is the hint the
 * extractor gets for free. "SOXX short | 28 Oct 2026" yields ["SOXX"].
 * Mixed-case words ("LoD") are not taken: they are his abbreviations, not
 * symbols.
 *
 * @param {string} title
 * @returns {string[]}
 */
function titleTickers(title) {
  const head = String(title || '').split('|')[0];
  const found = head.match(/\b[A-Z]{2,5}\b/g) || [];
  const months = new Set(Object.keys(MONTHS).map((m) => m.toUpperCase()));
  return [...new Set(found.filter((token) => !months.has(token)))];
}

/**
 * Should this catalog row be skipped by the transcript and extract paths?
 *
 * Nothing on this channel is quarantined yet: every listed stream is
 * trading talk. The function exists so the fetch tool has the same shape
 * as the other channels, and so a later non-market series can be dropped
 * in one place.
 *
 * @param {{title?: string}} video
 * @returns {{quarantined: boolean, reason: string}}
 */
function martinlukktVideoQuarantine(video) {
  // The title is read so a later non-market series has a place to match.
  void (video && video.title);
  return { quarantined: false, reason: '' };
}

module.exports = {
  dateFromTitle,
  martinlukktVideoQuarantine,
  sessionKind,
  titleTickers,
};
