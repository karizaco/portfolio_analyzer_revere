/**
 * What a positions-TABLE reading is allowed to publish, and which reader
 * produced a frame's holdings.
 *
 * These two decisions used to live inline in tools/scanVideoWithOcr.js, where
 * they could not be tested: the take-over path (the table reader finds
 * nothing, so the legacy crop reader has to run) and the failure path (the
 * table reader throws) are exactly the branches that are hardest to reach in
 * a scan, and a scan that hits either one silently produces fewer holdings.
 * Both are pure functions of their inputs, so they live here instead.
 */

/**
 * The holdings a table reading publishes, or null when it publishes nothing.
 *
 * A table is published only when it was POSITIVELY identified as the
 * positions table AND something in it decoded:
 *
 *   - `found` false — no table was located at all;
 *   - `verified` false — a table was located but not positively identified
 *     (an untitled lone table could be the watchlist);
 *   - no tickers — the table was identified but nothing in it decoded, so
 *     there are no holdings to publish.
 *
 * In every one of those cases the caller must fall back to the legacy crop
 * reader, so a scan never ends up with less than it had before the table
 * reader existed.
 *
 * @param {object|null|undefined} table a reading from readPositionTable()
 * @returns {string[]|null} the published holdings, or null for "publish nothing"
 */
function publishTableHoldings(table) {
  if (!table || typeof table !== 'object') return null;
  if (!table.found || !table.verified) return null;
  if (!Array.isArray(table.tickers) || !table.tickers.length) return null;
  return table.tickers.slice();
}

/**
 * Which reader produced a frame's holdings.
 *
 * 'position_table' — the lexicon-constrained table decoder published them.
 * 'chart_stream'   — the legacy crop reader ran, either because there was no
 *                    table reader, because it found nothing, or because it
 *                    failed. This is the only source the multi-frame
 *                    clusterer is allowed to repair.
 *
 * The vocabulary is deliberately two values: the field is published in every
 * probe log, and 'chart_stream' has always been the label for "not the table
 * reader", including on whiteboard scans.
 *
 * @param {object} options
 * @param {object|null} options.table the table reading, or null when the
 *   table reader did not run or threw
 * @returns {'position_table'|'chart_stream'}
 */
function readerForFrame({ table } = {}) {
  return publishTableHoldings(table) ? 'position_table' : 'chart_stream';
}

module.exports = {
  publishTableHoldings,
  readerForFrame,
};
