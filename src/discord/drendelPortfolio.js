'use strict';

/**
 * Drendel's "Portfolio" post -- a STATE snapshot, not a message about tickers.
 *
 * The post is the one place in the three channels where the trader says what
 * he HOLDS and how large it is, once a day:
 *
 *   **Portfolio June 4th 2026:**
 *   New positions **Bold**
 *
 *   __**Longs: 36% **__
 *   **INTC - 10%**
 *   DOCN - 5%
 *
 *   __**Shorts: 10%**__
 *   SOXS - 10%
 *
 *   Vibe Account Longs: NBIS, HUT, **WULF**
 *
 * WHAT IS READ
 *
 *   the date        from the header ("June 4th 2026"), cross-checked against
 *                   the post's own timestamp
 *   the account     "Vibe Account" is the Vibe account; EVERYTHING ELSE is
 *                   the trading account (the user's rule)
 *   the side        Longs / Shorts
 *   the weight      "INTC - 10%" -- percent of the account. The Vibe list
 *                   and the small-account list carry NO weights
 *   what is new     the post marks new positions in bold, so the bold state
 *                   is tracked through the markdown rather than stripped
 *
 * THE FORMAT CHANGED, so the reader switches on the LABELS, not on a date:
 *
 *   2025-09 .. 2026-02   "Updated Portfolio:" with "Long Exposure: 49.2%",
 *                        "Short Exposure: 13.5%" and "Cash - 37.3%"
 *   2026-02 .. 2026-03   "Longs: NBIS, BTU, **BE**" -- inline, no weights
 *   2026-04 onwards      "Longs: 71%" and one "TICKER - N%" line per position
 */

const {
  ACCOUNT_TRADING,
  ACCOUNT_VIBE,
  SUB_ACCOUNT_SMALL,
} = require('./sources');

const HEADER = /^(?:updated\s+)?portfolio\b/i;
const HEADER_DATE = /portfolio\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

/** The section labels, most specific first. */
const SECTIONS = [
  { account: ACCOUNT_VIBE, pattern: /^vibe\s+account(?:\s+longs)?\s*:?/i, side: 'long', sub: '' },
  { account: ACCOUNT_TRADING, pattern: /^shorts?\s+in\s+(?:my\s+)?small(?:er)?\s+account\s*:?/i, side: 'short', sub: SUB_ACCOUNT_SMALL },
  // "Other positions in smaller account - Short SNDK, DASH, QUBT" (2026-02-07)
  { account: ACCOUNT_TRADING, pattern: /^other\s+positions?\s+in\s+small(?:er)?\s+account\s*[-:]?\s*short\b/i, side: 'short', sub: SUB_ACCOUNT_SMALL },
  { account: ACCOUNT_TRADING, pattern: /^long(?:s|\s+exposure)\s*:?/i, side: 'long', sub: '', total: 'long' },
  { account: ACCOUNT_TRADING, pattern: /^short(?:s|\s+exposure)\s*:?/i, side: 'short', sub: '', total: 'short' },
];

const CASH = /^cash\s*[-:]?\s*(\d+(?:\.\d+)?)\s*%/i;
const LEGEND = /^new\s+positions?\b/i;

/** "INTC - 10%", "TER -10%", "SARK (ARKK Inverse): 8.3%", "AA - $58.40". */
const ENTRY = /^([A-Z]{1,5})\s*(?:\(([^)]*)\))?\s*[-:]\s*(.+)$/;

/** A ticker inside an inline list, with its optional "(ARKK)" annotation. */
const LIST_ITEM = /(?<![A-Za-z0-9])([A-Z]{1,5})(?![A-Za-z0-9])(?:\s*\(([^)]*)\))?/g;

/**
 * Remove the markdown, keeping which characters were bold.
 *
 * @param {string} content
 * @returns {{bold: boolean[], clean: string}}
 */
function stripMarkdown(content) {
  const source = String(content || '');
  const bold = [];
  let clean = '';
  let on = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*' && source[index + 1] === '*') {
      on = !on;
      index += 1;
      continue;
    }
    if (char === '*' || char === '_' || char === '`') continue;
    clean += char;
    bold.push(on);
  }
  return { bold, clean };
}

/**
 * The calendar date a post is ABOUT, in New York.
 *
 * A snapshot posted before the open describes the previous session.
 *
 * @param {string} postedAt  ISO timestamp, UTC
 * @returns {string} YYYY-MM-DD, or ''
 */
function sessionDateOf(postedAt) {
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'America/New_York',
    year: 'numeric',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const iso = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 9 * 60 + 30) return iso;
  const previous = new Date(`${iso}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/**
 * The date in the header, when it has one.
 *
 * @param {string} header
 * @returns {string} YYYY-MM-DD, or ''
 */
function headerDateOf(header) {
  const match = HEADER_DATE.exec(header);
  if (!match) return '';
  const month = MONTHS.findIndex((name) => name.startsWith(match[1].toLowerCase().slice(0, 3)));
  if (month < 0) return '';
  const day = Number(match[2]);
  if (!(day >= 1 && day <= 31)) return '';
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * Is this message a portfolio snapshot?
 *
 * @param {string} content
 * @returns {boolean}
 */
function isPortfolioPost(content) {
  const { clean } = stripMarkdown(content);
  const first = clean.split('\n').map((line) => line.trim()).find(Boolean) || '';
  return HEADER.test(first);
}

/**
 * Parse one portfolio post.
 *
 * @param {string} content
 * @param {string} postedAt  ISO timestamp
 * @returns {object|null} null when the message is not a snapshot
 */
function parsePortfolioPost(content, postedAt) {
  const { bold, clean } = stripMarkdown(content);
  const lines = [];
  let offset = 0;
  for (const raw of clean.split('\n')) {
    lines.push({ offset, text: raw });
    offset += raw.length + 1;
  }
  const headerLine = lines.find((line) => line.text.trim());
  if (!headerLine || !HEADER.test(headerLine.text.trim())) return null;

  const notes = [];
  const header = headerLine.text.trim();
  const posted = sessionDateOf(postedAt);
  const stated = headerDateOf(header);
  let asOf = stated || posted;
  let asOfSource = stated ? 'header' : 'posted_at';
  // A header date is typed by hand. One that is far from the post's own
  // timestamp is a typo, and the timestamp is the better witness.
  if (stated && posted && Math.abs(daysBetween(stated, posted)) > 4) {
    notes.push(`header date ${stated} is ${daysBetween(stated, posted)} days from the post (${posted})`);
    asOf = posted;
    asOfSource = 'posted_at';
  }

  const snapshot = {
    as_of_date: asOf,
    as_of_source: asOfSource,
    cash_pct: null,
    header,
    long_exposure_pct: null,
    notes,
    positions: [],
    short_exposure_pct: null,
  };

  const seen = new Set();
  const push = (section, ticker, index, extra = {}) => {
    const key = `${section.account}|${section.sub}|${section.side}|${ticker}`;
    if (seen.has(key)) return;
    seen.add(key);
    snapshot.positions.push({
      account: section.account,
      annotation: extra.annotation || '',
      is_new: Boolean(bold[index]),
      note: extra.note || '',
      side: section.side,
      stated_price: extra.price ?? null,
      sub_account: section.sub,
      ticker,
      weight_pct: extra.weight ?? null,
    });
  };

  const readList = (section, text, base) => {
    LIST_ITEM.lastIndex = 0;
    let match;
    while ((match = LIST_ITEM.exec(text)) !== null) {
      push(section, match[1], base + match.index, { annotation: match[2] || '' });
    }
  };

  let section = null;
  for (const line of lines) {
    if (line === headerLine) continue;
    const indent = line.text.length - line.text.trimStart().length;
    const text = line.text.trim();
    if (!text || LEGEND.test(text)) continue;

    const cash = CASH.exec(text);
    if (cash) {
      snapshot.cash_pct = Number(cash[1]);
      section = null;
      continue;
    }

    const label = SECTIONS.find((entry) => entry.pattern.test(text));
    if (label) {
      section = label;
      let rest = text.replace(label.pattern, '');
      const total = /^\s*(\d+(?:\.\d+)?)\s*%/.exec(rest);
      if (total) {
        if (label.total === 'long') snapshot.long_exposure_pct = Number(total[1]);
        if (label.total === 'short') snapshot.short_exposure_pct = Number(total[1]);
        rest = rest.slice(total[0].length);
      }
      const base = line.offset + indent + (text.length - rest.length);
      readList(section, rest, base);
      continue;
    }

    if (!section) continue;

    const entry = ENTRY.exec(text);
    if (entry) {
      const value = entry[3];
      const weight = /(\d+(?:\.\d+)?)\s*%/.exec(value);
      const price = /\$\s*(\d+(?:\.\d+)?)/.exec(value);
      const remark = /\(([^)]*)\)/.exec(value);
      push(section, entry[1], line.offset + indent, {
        annotation: entry[2] || '',
        note: remark ? remark[1].trim() : (!weight && !price ? value.trim() : ''),
        price: price ? Number(price[1]) : null,
        weight: weight ? Number(weight[1]) : null,
      });
      continue;
    }

    // A continuation of an inline list (the Vibe list wraps), but not prose.
    if (!/[a-z]{3,}/.test(text.replace(/\([^)]*\)/g, ''))) {
      readList(section, text, line.offset + indent);
    }
  }

  // The post states its own totals, so a reading can be checked against them.
  for (const side of ['long', 'short']) {
    const stated2 = snapshot[`${side}_exposure_pct`];
    if (stated2 === null) continue;
    const rows = snapshot.positions.filter((row) => row.account === ACCOUNT_TRADING
      && !row.sub_account && row.side === side && row.weight_pct !== null);
    const sum = rows.reduce((total, row) => total + row.weight_pct, 0);
    if (rows.length && Math.abs(sum - stated2) > 1.5) {
      notes.push(`${side} weights sum to ${Number(sum.toFixed(1))}%, the post says ${stated2}%`);
    }
  }

  return snapshot;
}

/**
 * Give every snapshot of a series its own date.
 *
 * The header date is typed by hand, and twice in the corpus he typed the
 * PREVIOUS post's date again (two posts say "March 17th"; the second was
 * posted the evening of the 18th). Two snapshots cannot describe one session
 * differently, so the later of a colliding pair takes the date of its own
 * timestamp -- and when that does not separate them either, the later post
 * supersedes the earlier one (he re-posted a correction).
 *
 * @param {object[]} snapshots  each with `as_of_date`, `posted_at`, `notes`
 * @returns {object[]} one snapshot per date, in date order
 */
function resolveSnapshotDates(snapshots) {
  const ordered = [...snapshots].sort((a, b) => String(a.posted_at).localeCompare(String(b.posted_at)));
  const byDate = new Map();
  for (const snapshot of ordered) {
    const holder = byDate.get(snapshot.as_of_date);
    if (holder) {
      const own = sessionDateOf(snapshot.posted_at);
      if (own && own !== snapshot.as_of_date && !byDate.has(own)) {
        snapshot.notes.push(`header repeats ${snapshot.as_of_date}; dated ${own} by its own timestamp`);
        snapshot.as_of_date = own;
        snapshot.as_of_source = 'posted_at';
      } else {
        snapshot.notes.push(`supersedes an earlier post for ${snapshot.as_of_date}`);
      }
    }
    byDate.set(snapshot.as_of_date, snapshot);
  }
  return [...byDate.values()].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
}

module.exports = {
  headerDateOf,
  resolveSnapshotDates,
  isPortfolioPost,
  parsePortfolioPost,
  sessionDateOf,
  stripMarkdown,
};
