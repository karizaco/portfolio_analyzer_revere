'use strict';

// Which Sevcik streams are market talk vs education/bootcamp noise.
//
// The Jul 2026 "14 dni" challenge streams are long and almost empty of
// ticker predictions. Spending Deepgram budget and parser time on them
// dilutes the ledger without improving outcome stats.

/**
 * Title patterns that mark non-market / educational series.
 * Matching is case-insensitive on ASCII-folded text.
 */
const NON_MARKET_TITLE_PATTERNS = [
  /\bden\s*\d+\s*(ze|z)\s*\d+\b/i, // "DEN 5 ze 14"
  /\b\d+\s*dn[iíuůy]\w*\b/i, // "14 dní naživo"
  /\bstartujeme\s+\d+\s*dn/i,
  /\bpunt[ií]ky,?\s*platformy\b/i,
  /\bsvat[yý]\s+gr[aá]l\s+obchod/i,
  /\bco\s+je\s+p[aá]ka\b/i, // leverage tutorial
  /\bjeden\s+pattern,?\s+kter/i,
  /\briziko\s+vs\.?\s+potenci[aá]l\b/i,
];

/**
 * Fold diacritics so ASR/title spelling variants still match.
 * @param {string} value
 * @returns {string}
 */
function foldText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * @param {string} title
 * @returns {boolean}
 */
function isNonMarketSevcikTitle(title) {
  const raw = String(title || '');
  if (!raw.trim()) return false;
  if (NON_MARKET_TITLE_PATTERNS.some((re) => re.test(raw))) return true;
  const folded = foldText(raw);
  // folded variants without diacritics
  if (/\bden\s*\d+\s*(ze|z)\s*\d+\b/.test(folded)) return true;
  if (/\b\d+\s*dn[iuy]\w*\b/.test(folded)) return true; // 14 dni / 14 dnu series
  if (/\bpuntiky/.test(folded) && /\bplatformy/.test(folded)) return true;
  return false;
}

/**
 * Should this catalog row be skipped by default extract/score paths?
 * @param {{title?: string, upload_date?: string, video_id?: string}} video
 * @returns {{quarantined: boolean, reason: string}}
 */
function sevcikVideoQuarantine(video) {
  const title = video && video.title ? video.title : '';
  if (isNonMarketSevcikTitle(title)) {
    return { quarantined: true, reason: 'non_market_series' };
  }
  return { quarantined: false, reason: '' };
}

module.exports = {
  NON_MARKET_TITLE_PATTERNS,
  foldText,
  isNonMarketSevcikTitle,
  sevcikVideoQuarantine,
};
