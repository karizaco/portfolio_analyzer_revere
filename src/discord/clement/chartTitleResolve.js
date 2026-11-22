'use strict';

/**
 * Map chart title / black-name OCR lines to tickers (Phase 4 light path).
 * Gray-on-gray ticker glyphs stay untrusted; use names + caption cashtags.
 */

const NAME_RULES = [
  { re: /\bethereum\b|\beth\b.*\btether|\bethusdt\b/i, ticker: 'ETH' },
  { re: /\bbitcoin\b|\bbtc\b.*\btether|\bbtcusdt\b/i, ticker: 'BTC' },
  { re: /\brussell\b|\biwm\b/i, ticker: 'IWM' },
  { re: /\btempus\b|\btem\b/i, ticker: 'TEM' },
  { re: /\bnvidia\b/i, ticker: 'NVDA' },
  { re: /\bpalantir\b/i, ticker: 'PLTR' },
  { re: /\bmicrostrategy\b|\bmstr\b/i, ticker: 'MSTR' },
  { re: /\bcoinbase\b/i, ticker: 'COIN' },
  { re: /\btsla\b|\btesla\b/i, ticker: 'TSLA' },
  { re: /\bamd\b|\badvanced micro\b/i, ticker: 'AMD' },
  { re: /\bsmci\b|\bsuper micro\b/i, ticker: 'SMCI' },
  { re: /\barm holdings\b|\b\barm\b/i, ticker: 'ARM' },
  { re: /\bsoxx\b|\bsemiconductor/i, ticker: 'SOXX' },
  { re: /\bqqq\b|\binvesco qqq\b/i, ticker: 'QQQ' },
  { re: /\bspy\b|\bs&p 500\b|\bspdr s&p/i, ticker: 'SPY' },
];

/**
 * @param {string} titleText
 * @returns {{ticker: string, rule: string}[]}
 */
function resolveChartTitle(titleText) {
  const text = String(titleText || '');
  const out = [];
  const seen = new Set();
  for (const rule of NAME_RULES) {
    if (!rule.re.test(text)) continue;
    if (seen.has(rule.ticker)) continue;
    seen.add(rule.ticker);
    out.push({ ticker: rule.ticker, rule: String(rule.re) });
  }
  // bare ETHUSDT / BTCUSDT tokens
  for (const m of text.toUpperCase().matchAll(/\b([A-Z]{2,5})USDT\b/g)) {
    const base = m[1];
    if (!seen.has(base)) {
      seen.add(base);
      out.push({ ticker: base, rule: 'USDT_suffix' });
    }
  }
  return out;
}

module.exports = {
  NAME_RULES,
  resolveChartTitle,
};
