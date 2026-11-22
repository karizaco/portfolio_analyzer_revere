'use strict';

/**
 * Clement (cletibals) on Discord — caption-derived ideas, not position weights.
 *
 * The channel is mostly dated daily plans and multi-ticker idea writeups with
 * chart attachments. This parser version reads CAPTIONS only; OCR of the
 * Daily Market Plan dashboards is a later layer.
 */

const PARSER_VERSION = 'clement-captions-1';
const SOURCE_NAME = 'clement';

module.exports = {
  PARSER_VERSION,
  SOURCE_NAME,
};
