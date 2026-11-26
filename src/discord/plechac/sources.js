'use strict';

/**
 * Plechac (petrplechactradecz) on Discord -- a Czech private investor.
 *
 * THE SOURCE IS TWO CHANNELS IN A SHARED SERVER
 *
 *   guild 917782018992009256 ("TradeCZ"), 80 channels, ~40 members each.
 *   977152752838918144  "realizované investice" -- the TRADE channel: what
 *                       he actually did. 233 of his messages, 2025-12-29 ..
 *                       2026-11-25.
 *   928591421500428319  "akcie-a-etf" -- the TALK channel: commentary on
 *                       stocks and ETFs. 1,607 of his messages, but only a
 *                       handful are realized trades.
 *
 * BOTH CHANNELS ARE SHARED, so THE AUTHOR IS A FILTER AND NOT A GIVENER.
 * Every other source in this project is effectively single-author, so the
 * ingest had never needed to say "and only his messages". This one does, and
 * the filter is a property of the SOURCE: `discord_sources.author_id` says
 * whose messages the channel is about, and the ingest skips the rest. The
 * two channels carry ~14,100 messages between them and only 1,840 are his,
 * so the filter is also what keeps the catalog small.
 *
 * THE MEASURED CORPUS
 *
 *   trade channel   233 messages, 68 % of them carry a trade verb
 *   talk channel  1,607 messages, ~24 carry one
 *
 * The trade channel is the canonical one and the talk channel is
 * complementary: their overlap is ONE message, so the second is not a
 * restatement of the first.
 *
 * TWO BOOKS
 *
 * He keeps a main book and a "RISKY" book, and says so in the message:
 * "Dobral jsem na RISKY portfoliu minimální pozice HOOD a CRCL",
 * "Nová pozice v risky portfoliu je Rheinmetall". 27 of his trade
 * messages name the risky book, 4 name both. The book is a property of
 * the STATEMENT, not of the message: "Dobírám na risky portfoliu Uber a
 * Circle | Na hlavním jsem kosmeticky doplnil" puts one name in each.
 *
 * WHAT HE DOES NOT PUBLISH
 *
 * No stops (0 mentions of "stop" or "zastav" in the corpus), no ATR
 * multiples, no weights -- only qualitative sizes ("trochu", "kousek",
 * "celé pozice") and 9 percentages. So a position's size is mostly
 * unknown, and the episodes are priced from closes like every other
 * source here.
 */

const PARSER_VERSION = 'plechac-trades-1';
const SOURCE_NAME = 'plechac';

const GUILD_ID = '917782018992009256';
const AUTHOR_ID = '882261479036973126';
const AUTHOR_NAME = 'petrplechactradecz';

const ACCOUNT_MAIN = 'main';
const ACCOUNT_RISKY = 'risky';

/**
 * The channels, and what each one is.
 *
 * `kind` decides how strictly the parser reads the channel: the trade
 * channel states what he did, so its present-tense verbs ("beru") ARE
 * trades; the talk channel is commentary, where "beru" is usually an
 * opinion and only a realized past-tense verb counts.
 */
const CHANNELS = {
  'plechac-trades': {
    channel_id: '977152752838918144',
    kind: 'trades',
    label: 'realizované investice',
  },
  'plechac-talk': {
    channel_id: '928591421500428319',
    kind: 'talk',
    label: 'akcie-a-etf',
  },
  // He CREATED this channel (2023-05-07) to talk about the composition of
  // the portfolio, and it is where the portfolio STATE lives: eight
  // screenshot posts of the broker's own positions screen, and the text
  // around them naming the holdings and what they are worth.
  'plechac-portfolia': {
    channel_id: '1104753899610583050',
    kind: 'talk',
    label: 'portfolia',
  },
  // The commodities channel is where his commodity trades are, and it
  // reaches back to 2023 -- two years before the trades channel starts.
  'plechac-komodity': {
    channel_id: '987078000426237982',
    kind: 'commodity',
    label: 'komodity',
  },
};

/** The source names, in the order the builder reads them. */
const SOURCE_NAMES = Object.keys(CHANNELS);

module.exports = {
  ACCOUNT_MAIN,
  ACCOUNT_RISKY,
  AUTHOR_ID,
  AUTHOR_NAME,
  CHANNELS,
  GUILD_ID,
  PARSER_VERSION,
  SOURCE_NAME,
  SOURCE_NAMES,
};
