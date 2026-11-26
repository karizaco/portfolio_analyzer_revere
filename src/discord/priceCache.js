'use strict';

/**
 * The daily closes of the symbols in the price cache.
 *
 * The cache is one JSON file per symbol under `data/price_cache/yahoo/`,
 * and it is what the episode builders price from. The builders do NOT
 * fetch: a fetch belongs to the analyze tool, which has a provider and a
 * cache of its own. This is the local reader both builders share, so the
 * two cannot drift apart on what a cached close is.
 *
 * @param {string[]} symbols
 * @param {string} cacheDirectory
 * @returns {Map<string, Map<string, number>>} symbol -> date -> close
 */
const fs = require('node:fs');
const path = require('node:path');

function loadCachedCloses(symbols, cacheDirectory) {
  const out = new Map();
  for (const symbol of symbols) {
    const file = path.join(cacheDirectory, `${symbol}.json`);
    if (!fs.existsSync(file)) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const closes = new Map();
    for (const point of entry.prices || []) {
      if (Number.isFinite(point.price)) closes.set(point.date, point.price);
    }
    if (closes.size) out.set(symbol, closes);
  }
  return out;
}

module.exports = { loadCachedCloses };
