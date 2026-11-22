'use strict';

/**
 * Shared OCR / ticker confusions for Discord sources.
 * Additive hygiene — does not replace the lexicon; only repairs known garble.
 */

const CONFUSIONS = [
  // leading S glued by OCR on watchlist lines
  [/^S(PLTR|TSLA|COIN|MSTR|BITI|HOOD|NVDA|AMD|QQQ|IWM|TNA)$/i, (_, a) => a.toUpperCase()],
  [/^S(GDX|GLD|UGL|ALAB|HIMS|LUNR|TXRH|FUTU|HSAI|CHYM|HNGE|OFI)$/i, (_, a) => a.toUpperCase()],
  // common letter swaps
  [/^NVA$/i, 'NVDA'],
  [/^SCRDO$/i, 'CRDO'],
  [/^SGLW$/i, 'GLW'],
  [/^SEOSE$/i, 'EOSE'],
  [/^SPLTR$/i, 'PLTR'],
  [/^STSLA$/i, 'TSLA'],
  [/^STSLQ$/i, 'TSLQ'],
  [/^SBITI$/i, 'BITI'],
  [/^SMSTR$/i, 'MSTR'],
  [/^SCOIN$/i, 'COIN'],
  [/^SHIMS$/i, 'HIMS'],
  [/^SALAB$/i, 'ALAB'],
  [/^SGDX$/i, 'GDX'],
  [/^SGLD$/i, 'GLD'],
  [/^SUGL$/i, 'UGL'],
  [/^SHNGE$/i, 'HNGE'],
  [/^SFUTU$/i, 'FUTU'],
  [/^SHSAI$/i, 'HSAI'],
  [/^SLUNR$/i, 'LUNR'],
  [/^STXRH$/i, 'TXRH'],
  [/^SSOFI$/i, 'SOFI'],
  [/^SMOD$/i, 'MOD'],
  [/^SJOBY$/i, 'JOBY'],
  [/^SINCY$/i, 'INCY'],
  [/^SCHYM$/i, 'CHYM'],
  [/^SCLBR$/i, 'CLBR'],
  [/^SCRCL$/i, 'CRCL'],
  [/^SFNV$/i, 'FNV'],
  [/^SJNUG$/i, 'JNUG'],
  [/^SGDXU$/i, 'GDXU'],
  [/^SSHOP$/i, 'SHOP'],
];

/**
 * @param {string} raw
 * @returns {string}
 */
function repairOcrTicker(raw) {
  let t = String(raw || '').trim().toUpperCase().replace(/^\$/, '');
  if (!t) return '';
  for (const [re, repl] of CONFUSIONS) {
    if (!re.test(t)) continue;
    t = typeof repl === 'function' ? t.replace(re, repl) : repl;
    break;
  }
  return t;
}

module.exports = {
  CONFUSIONS,
  repairOcrTicker,
};
