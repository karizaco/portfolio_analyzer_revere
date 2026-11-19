'use strict';

// The right-edge TradingView watchlist, read as lines.
//
// Measured on two streams (2026-11-18), both 1920x1080:
//
//   20261104 NUT6d6Hvbmw t=600   E_Main: INDEXES / LONGS / SHORTS / FOCUS / TRACKING
//   20251114 LcGmyo5ASt4 t=2700  E_Main: INDEXES / HOLDINGS / IDEA / LONGS / SHORTS / WAITLIST
//   20251114 LcGmyo5ASt4 t=900   E_Lagging: a flat list, no section headers
//
// LONGS, SHORTS and HOLDINGS are the book. INDEXES, FOCUS, TRACKING, IDEA
// and WAITLIST are not. A flat list with no header is not a book: publishing
// it would treat a lagging-names scan as positions. The company card under
// the list (the highlighted ticker, then "Inc" / "USD" / "Market open") is
// not another row.

/** Sections whose rows are positions. */
const BOOK_SECTIONS = {
  LONGS: 'long',
  SHORTS: 'short',
  HOLDINGS: 'held',
};

/** Sections that are on the same rail and are not positions. */
const OTHER_SECTIONS = new Set([
  'INDEXES', 'FOCUS', 'TRACKING', 'IDEA', 'WAITLIST',
]);

const SECTION_NAMES = [
  'INDEXES', 'HOLDINGS', 'IDEA', 'LONGS', 'SHORTS', 'FOCUS', 'TRACKING', 'WAITLIST',
];

const SECTION = /^(INDEXES|HOLDINGS|IDEA|LONGS|SHORTS|FOCUS|TRACKING|WAITLIST)$/;

/** Not a ticker, even when it sits in the symbol column. */
const NOT_A_ROW = new Set([
  'SYMBOL', 'LAST', 'CHG', 'EXT', 'FLAG', 'USD', 'NASDAQ', 'INC', 'THE',
]);

/** A symbol row. Exactly two decimals: a longer token is the % column, not the price. */
const SYMBOL_ROW = /^([A-Z]{1,5})\b.*?(-?\d+[.,]\d{2})(?!\d)/;

/** The detail card under the list. Reading past it republishes the highlighted ticker. */
const CARD = /Market open|Key facts|Key stats|\bUSD\b|\bInc\b|Volume/;

/**
 * A section header as OCR wrote it, or ''.
 *
 * Measured on the two rails: "shorTS", "FocuS", "hCLDINGS", "L0*G5", "choats".
 * Case and the digit substitutions (0/O, 5/S) are folded, then a unique edit
 * within 2 of a known header is that header. A ticker is not a header: the
 * match has to be unique, and a second header at the same distance loses.
 *
 * @param {string} text
 * @returns {string}
 */
function matchSectionHeader(text) {
  const folded = String(text || '')
    .toUpperCase()
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/5/g, 'S')
    .replace(/[^A-Z]/g, '');
  if (folded.length < 3) return '';
  if (SECTION.test(folded)) return folded;
  let best = '';
  let bestDistance = 99;
  let ties = 0;
  for (const header of SECTION_NAMES) {
    if (Math.abs(header.length - folded.length) > 2) continue;
    const distance = editDistance(folded, header);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = header;
      ties = 1;
    } else if (distance === bestDistance) {
      ties += 1;
    }
  }
  // Distance 2 is for a long garbled header ("choats"). A 4-letter ticker
  // is two edits from IDEA, and that is not a header.
  const limit = folded.length >= 6 ? 2 : 1;
  return ties === 1 && bestDistance <= limit ? best : '';
}

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) rows[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[left.length][right.length];
}

/**
 * Lines of the list, with the chart price axis removed.
 *
 * The rail crop includes the axis. Measured: axis words sit at left ~80 and
 * the symbol column at left ~153, with a gap between them. Words left of that
 * gap are not rows. Words are then grouped into lines by their top.
 *
 * @param {{text: string, left: number, top: number}[]} words
 * @returns {{text: string, top: number}[]}
 */
function listLinesFromWords(words) {
  const rows = (words || []).filter((word) => word && String(word.text || '').trim()
    && Number.isFinite(Number(word.left)) && Number.isFinite(Number(word.top)));
  if (!rows.length) return [];
  const lefts = rows.map((word) => Number(word.left)).sort((a, b) => a - b);
  const maxLeft = lefts[lefts.length - 1];
  let split = null;
  let bestGap = 0;
  for (let i = 0; i < lefts.length - 1; i += 1) {
    const gap = lefts[i + 1] - lefts[i];
    const mid = (lefts[i] + lefts[i + 1]) / 2;
    if (mid < maxLeft * 0.15 || mid > maxLeft * 0.55) continue;
    if (gap > bestGap) {
      bestGap = gap;
      split = mid;
    }
  }
  const kept = bestGap >= 20 ? rows.filter((word) => Number(word.left) >= split) : rows;
  const sorted = [...kept].sort((a, b) => Number(a.top) - Number(b.top) || Number(a.left) - Number(b.left));
  const lines = [];
  for (const word of sorted) {
    const top = Number(word.top);
    const last = lines[lines.length - 1];
    if (last && Math.abs(top - last.top) <= 12) {
      last.words.push(word);
    } else {
      lines.push({ top, words: [word] });
    }
  }
  return lines.map((line) => ({
    text: line.words
      .sort((a, b) => Number(a.left) - Number(b.left))
      .map((word) => String(word.text).trim())
      .join(' '),
    top: line.top,
  }));
}

/**
 * Parse watchlist lines into sections and the book.
 *
 * @param {string[]} lines
 * @param {{tops?: number[]}} [options]
 * @returns {{positions: object[], sections: Object<string, string[]>, flat: boolean}}
 */
function parseWatchlistLines(lines, options) {
  const tops = (options && options.tops) || [];
  const pitch = rowPitch(tops);
  const sections = {};
  const positions = [];
  let section = '';
  let sawSection = false;
  let previousTop = null;
  const list = lines || [];
  for (let index = 0; index < list.length; index += 1) {
    const line = String(list[index] || '').trim();
    if (!line) continue;
    if (CARD.test(line)) break;
    const top = Number.isFinite(tops[index]) ? tops[index] : null;
    if (top !== null && previousTop !== null && pitch && top - previousTop > pitch * 1.8) {
      // A header the OCR did not read. The rows after it are not the section
      // above: on the 2025 rail that gap is IDEA, and reading through it
      // would publish CORZ as a holding.
      section = '';
    }
    if (top !== null) previousTop = top;
    const tokens = line.split(/\s+/).filter(Boolean);
    const header = tokens.length === 1 ? matchSectionHeader(tokens[0]) : '';
    if (header) {
      section = header;
      sawSection = true;
      if (!sections[section]) sections[section] = [];
      continue;
    }
    if (tokens.length === 1 && header === '' && tokens[0].replace(/[^A-Za-z]/g, '').length >= 5) {
      // A header the matcher could not read ("TpecHG", "hiLST"). The rows
      // under it are not the section above, and the header is not a ticker.
      section = '';
      sawSection = true;
      continue;
    }
    const normalized = line.toUpperCase().replace(/,/g, '.');
    const leftmost = tokens[0].toUpperCase().replace(/[^A-Z]/g, '');
    const row = SYMBOL_ROW.exec(normalized);
    // The ticker is the symbol column, which is the leftmost word. A letter
    // in the change column ("~OL" for a percent) is not a row.
    const ticker = /^[A-Z]{1,5}$/.test(leftmost) ? leftmost : '';
    if (!ticker || !section || NOT_A_ROW.has(ticker) || SECTION.test(ticker)) continue;
    if (!sections[section]) sections[section] = [];
    if (!sections[section].includes(ticker)) sections[section].push(ticker);
    if (BOOK_SECTIONS[section]) {
      const priceText = row ? row[2].replace(',', '.') : '';
      positions.push({
        price: priceText ? Number(priceText) : null,
        section,
        side: BOOK_SECTIONS[section],
        ticker,
      });
    }
  }
  return { flat: !sawSection, positions, sections };
}

function rowPitch(tops) {
  const gaps = [];
  for (let i = 1; i < tops.length; i += 1) {
    if (!Number.isFinite(tops[i]) || !Number.isFinite(tops[i - 1])) continue;
    const gap = tops[i] - tops[i - 1];
    if (gap >= 10 && gap <= 36) gaps.push(gap);
  }
  if (!gaps.length) return 22;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The book, from OCR words rather than from already-split lines.
 *
 * @param {{text: string, left: number, top: number}[]} words
 * @returns {{positions: object[], sections: Object<string, string[]>, flat: boolean, lines: string[]}}
 */
function parseWatchlistWords(words) {
  const lines = listLinesFromWords(words);
  const parsed = parseWatchlistLines(lines.map((line) => line.text), {
    tops: lines.map((line) => line.top),
  });
  return { ...parsed, lines: lines.map((line) => line.text) };
}

module.exports = {
  BOOK_SECTIONS,
  OTHER_SECTIONS,
  listLinesFromWords,
  matchSectionHeader,
  parseWatchlistLines,
  parseWatchlistWords,
};
