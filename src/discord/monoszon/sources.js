'use strict';

/**
 * David Monoszon on Discord -- an intraday index trader, read as IDEAS.
 *
 * WHAT THIS SOURCE IS, AND IS NOT
 *
 * `⚡｜indexy` (1057197663285678241) is his channel in the TradeCZ
 * server, and he is the dominant poster in it: **2,955 of the last 4,000
 * messages**, 2025-10-21 to 2026-11-25.
 *
 * He trades the INDEX FUTURES intraday -- NQ, ES, RTY -- and the sector
 * ETFs around them, and the channel is a live trade journal in Czech:
 *
 *   "vzal jsem mikrama long 24 774 opravdu malý size SL pod dnešním low"
 *   "ten long jsem vzal a první profit jsem vybral za 20 bodů. sl mám nyní
 *    na BE a cílím s dalším targetem 25400"
 *   "spekulativně dávám limit buy order na QQQ 645"
 *   "Vstupuji opět do zlata long CFD, se SL 4934"
 *
 * He does NOT publish a position list and he does not publish a size --
 * only "třetinovým size", "malý size". So this is NOT another position
 * source. What it is: a TAPE, and a stream of CALLS on indexes and
 * sector ETFs that can be scored.
 *
 * WHY THE CALLS AND NOT THE TRADES
 *
 * The trades are intraday, so the project's close-to-close model reads a
 * same-day trade as flat 0 % (it counts those apart), and the entry is
 * usually a chart level rather than a number. Measured over his 2,955
 * messages: **179** carry a direction word and only **27** carry a
 * direction AND a level in the TEXT -- the other levels live in the 133
 * chart screenshots.
 *
 * So the record is the CALL: what he expects of an index or a sector, and
 * when. Those are scored against the proxy and against SPY, exactly the
 * way the Benzinga readings are.
 *
 * THE AUTHOR IS A FILTER
 *
 * The channel is shared, and he is one of several posters in it. The
 * ingest filters by `discord_sources.author_id`, so the source is his
 * messages and nobody else's.
 */

const PARSER_VERSION = 'monoszon-readings-1';
const SOURCE_NAME = 'monoszon';
const AUTHOR_ID = '621658520491655176';
const AUTHOR_NAME = 'davidmonoszon';
const CHANNEL_ID = '1057197663285678241';
const GUILD_ID = '917782018992009256';
const CHANNEL_LABEL = 'indexy';

module.exports = {
  AUTHOR_ID,
  AUTHOR_NAME,
  CHANNEL_ID,
  CHANNEL_LABEL,
  GUILD_ID,
  PARSER_VERSION,
  SOURCE_NAME,
};
