'use strict';

/**
 * The Discord trader sources, and what each channel IS.
 *
 * The three channels are not three copies of one thing:
 *
 *   drendel      one trader, TWO accounts. His daily "Portfolio" post is a
 *                STATE snapshot (what he holds, and how large), and his other
 *                messages are trade ACTIONS on the trading account.
 *   ariel-long   one trader's LONG book, as trade actions.
 *   ariel-short  the same trader's SHORT book, as trade actions.
 *
 * DRENDEL'S ACCOUNTS (the user's statement, 2026-11-15)
 *
 * He has ONE account for trading -- longs and shorts both -- and ONE other
 * account he calls "Vibe". A position that is not listed under "Vibe Account"
 * is in the trading account.
 *
 * The posts also carry a "Shorts in small account" block (22 posts, Feb-Mar
 * 2026). By that rule it is the trading account; the label is kept as a
 * `sub_account` so the distinction the post drew is not lost.
 *
 * WHAT A "SHORT" IS, PER SOURCE
 *
 * Drendel's trading-account "Shorts" are instruments he BOUGHT -- inverse
 * ETFs. His own words: "Bought AVS (AVGO inverse)", "Short AVGO (Long AVS)".
 * So the P&L of such a row is the instrument's own return. Only the
 * "small account" shorts are real short sales (APP, CVNA, DASH ...).
 */

const PARSER_VERSION = 'discord-traders-1';

const SOURCES = {
  drendel: { book: 'trading', direction: 'long', trader: 'drendel' },
  'ariel-long': { book: 'long', direction: 'long', trader: 'ariel' },
  'ariel-short': { book: 'short', direction: 'short', trader: 'ariel' },
};

const ACCOUNT_TRADING = 'trading';
const ACCOUNT_VIBE = 'vibe';
const SUB_ACCOUNT_SMALL = 'small_account';

/**
 * Inverse products that are BOUGHT to express a bearish view.
 *
 * Used for ONE decision: a "short" of one of these in a short BOOK
 * (Ariel's "TZA short 3%") is ambiguous -- it may be a purchase of the
 * inverse product or a short sale of it, and the two have opposite P&L. Such
 * a trade is flagged and kept out of the headline numbers rather than guessed.
 *
 * The single-stock rows are the ones Drendel annotated himself.
 */
const INVERSE_INSTRUMENTS = new Set([
  // index / sector
  'SQQQ', 'SOXS', 'TZA', 'SPXS', 'SPXU', 'SDS', 'SH', 'PSQ', 'SARK', 'DUST', 'JDST', 'ZSL', 'SSG',
  // single-stock, from Drendel's own annotations
  'AVS', 'PLTD', 'PLTZ', 'MUD', 'IREZ', 'CBRZ', 'ASTN', 'RGTZ', 'MSTZ', 'AAOZ', 'IONZ', 'BEZ', 'CORD',
  'TSLQ', 'HIMZ',
]);

module.exports = {
  ACCOUNT_TRADING,
  ACCOUNT_VIBE,
  INVERSE_INSTRUMENTS,
  PARSER_VERSION,
  SOURCES,
  SUB_ACCOUNT_SMALL,
};
