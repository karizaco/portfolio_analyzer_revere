'use strict';

/**
 * Parse OCR text from the LEFT half of a Clement Daily Market Plan.
 *
 * After vertical split, left half holds:
 *   1. Market Trend checklist (YES/NO)
 *   2. Primary Watchlist / Focus Themes / Focus List (Long:/Short:)
 *   3. Situational Awareness, Emotional Analysis, ...
 */

const { loadLexicon } = require('../symbols');
const { loadMarketTickers } = require('../../normalize/marketTickers');
const { normalizeTicker } = require('./parseCaption');
const { repairOcrTicker } = require('../shared/ocrConfusables');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const DATE_RE = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/;
const SIGNAL_DEFS = [
  { key: 'daily_buy_signal', re: /daily\s+buy\s+signal/i },
  { key: 'weekly_buy_signal', re: /weekly\s+buy\s+signal/i },
  { key: 'above_rising_5dma', re: /price\s+action\s+above\s+rising\s+5/i },
  { key: 'traction_last_5', re: /gained\s+traction\s+on\s+last\s+5/i },
  { key: 'net_52w_hl_positive', re: /net\s+52[- ]?week\s+high\/low/i },
];

/**
 * @param {string} mon
 */
function monthNum(mon) {
  return MONTHS[String(mon || '').toLowerCase()] || null;
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {Set<string>} [options.known]
 */
function parseDashboardLeft(text, options = {}) {
  const raw = String(text || '');
  const known = options.known || loadLexicon();
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let asOfDate = '';
  const dm = raw.match(DATE_RE);
  if (dm) {
    const d = Number(dm[1]);
    const m = monthNum(dm[2]);
    const y = Number(dm[3]);
    if (m && d && y) {
      asOfDate = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  /** @type {Record<string, boolean|null>} */
  const signals = {};
  for (const def of SIGNAL_DEFS) signals[def.key] = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const def of SIGNAL_DEFS) {
      if (!def.re.test(line)) continue;
      let yn = extractYesNo(line);
      // YES/NO often sits 1-3 lines below the label (label, formula, YES).
      for (let k = 1; k <= 3 && yn == null; k += 1) {
        yn = extractYesNo(lines[i + k] || '');
      }
      if (yn != null) signals[def.key] = yn;
    }
  }

  let technicalTheme = '';
  const themeLine = lines.find((l) => /technical\s+theme\s+of\s+the\s+market/i.test(l));
  if (themeLine) {
    technicalTheme = themeLine.replace(/.*technical\s+theme\s+of\s+the\s+market\s*:?\s*/i, '').trim();
    if (!technicalTheme) {
      const idx = lines.indexOf(themeLine);
      if (idx >= 0 && lines[idx + 1] && !/^\d+\.\s/.test(lines[idx + 1])) {
        technicalTheme = lines[idx + 1];
      }
    }
  }

  // Focus themes free text
  let focusThemes = '';
  for (let i = 0; i < lines.length; i += 1) {
    if (/^focus\s+themes?$/i.test(lines[i]) || /^focus\s+list$/i.test(lines[i])) {
      const bits = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
        if (/^\d+\.\s/.test(lines[j]) || /^(long|short)\s*:/i.test(lines[j])) break;
        if (/primary\s+watchlist|situational|emotional|market\s+trend/i.test(lines[j])) break;
        bits.push(lines[j]);
      }
      focusThemes = bits.join('; ');
      break;
    }
  }

  // Long: / Short: ticker lists
  const ideas = [];
  for (const line of lines) {
    const longM = line.match(/^long\s*:\s*(.+)$/i);
    const shortM = line.match(/^short\s*:\s*(.+)$/i);
    if (longM) {
      pushList(ideas, longM[1], 'long_idea', known, line);
    } else if (shortM) {
      const rest = shortM[1].trim();
      if (!/^(nil|none|-)\s*$/i.test(rest)) {
        pushList(ideas, rest, 'short_idea', known, line);
      }
    }
  }

  // Only explicit $ cashtags from the left half (not bare OCR prose words).
  // Full-text findTickers() was pulling THE/A/TO/FOR from commentary.
  for (const m of raw.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const t = repairOcrTicker(normalizeTicker(m[1]));
    if (!t) continue;
    if (!ideas.some((x) => x.ticker === t)) {
      ideas.push({
        ticker: t,
        role: 'watch',
        note: '',
        confidence: 'high',
        source: 'dashboard_left_ocr',
      });
    }
  }

  const situational = sliceSection(lines, /situational\s+awareness/i, /^\d+\.\s|emotional\s+analysis/i);
  const emotional = sliceSection(lines, /emotional\s+analysis/i, /^\d+\.\s|have a good/i);

  return {
    as_of_date: asOfDate,
    signals,
    signal_yes_count: Object.values(signals).filter((v) => v === true).length,
    signal_no_count: Object.values(signals).filter((v) => v === false).length,
    technical_theme: technicalTheme,
    focus_themes: focusThemes,
    ideas,
    situational_awareness: situational,
    emotional_analysis: emotional,
    raw_line_count: lines.length,
  };
}

/**
 * @param {string} s
 * @returns {boolean|null}
 */
function extractYesNo(s) {
  if (/\bYES\b/.test(s)) return true;
  if (/\bNO\b/.test(s)) return false;
  return null;
}

/**
 * @param {object[]} ideas
 * @param {string} listText
 * @param {string} role
 * @param {Set<string>} known
 * @param {string} note
 */
function pushList(ideas, listText, role, known, note) {
  const market = loadMarketTickers();
  const STOP = new Set([
    'NIL', 'NONE', 'THE', 'AND', 'FOR', 'TO', 'OF', 'ON', 'IN', 'AT', 'A', 'AN',
    'IS', 'IT', 'BE', 'OR', 'AS', 'BY', 'UP', 'SO', 'IF', 'MY', 'ME', 'WE', 'NO',
    'YES', 'ALL', 'NOT', 'OUT', 'NOW', 'DAY', 'LOW', 'HIGH', 'LATE', 'STAGE',
    'BASE', 'BASES', 'INTO', 'FROM', 'WITH', 'THIS', 'THAT', 'HAVE', 'HAS',
    'WANT', 'WATCH', 'LONG', 'SHORT', 'FOCUS', 'LIST', 'THEME', 'SETUP', 'VCP',
  ]);
  // tokens separated by space or comma; require \$ or lexicon/market hit
  const parts = String(listText).split(/[\s,/;]+/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const dollar = part.startsWith('$');
    let t = repairOcrTicker(part.replace(/^\$/, ''));
    if (!/^[A-Z]{1,5}$/.test(t)) continue;
    if (STOP.has(t)) continue;
    if (!dollar && !known.has(t) && !market.has(t)) continue;
    ideas.push({
      ticker: t,
      role,
      note: String(note || '').slice(0, 300),
      confidence: dollar || known.has(t) ? 'high' : 'medium',
      source: 'dashboard_left_ocr',
    });
  }
}


/**
 * @param {string[]} lines
 * @param {RegExp} start
 * @param {RegExp} stop
 */
function sliceSection(lines, start, stop) {
  const i = lines.findIndex((l) => start.test(l));
  if (i < 0) return '';
  const bits = [];
  for (let j = i + 1; j < lines.length; j += 1) {
    if (stop.test(lines[j])) break;
    bits.push(lines[j]);
  }
  return bits.join(' ').slice(0, 2000);
}

module.exports = {
  SIGNAL_DEFS,
  parseDashboardLeft,
};
