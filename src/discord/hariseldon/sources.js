'use strict';

/**
 * HariSeldon on Discord -- a trade journal, in English.
 *
 * WHAT THIS SOURCE IS
 *
 * `verified-traders` in the `/r/RealDayTrading` server (1058604837467607100)
 * carries the posts of ONE account, and that account is the same person
 * under four names: `*HariSeldon*` (1,927 messages), `Twitter:
 * RealDayTrading` (637), `HSeldon2020` (416) and `OptionStalker` (20).
 * They are all one Discord user id -- 1058608380173889537 -- because the
 * Reddit and Twitter accounts are WEBHOOKS posting under his identity.
 *
 * So the channel posts the same trade more than once, with the mirrors
 * carrying less of it: his own post is "Exit $NKE `36.52` with .98 profit
 * per share" and the Twitter mirror is "Exit NKE with .98 profit per
 * share". **Measured: 97 of his 126 messages in the sample have a mirror
 * within 15 minutes.** The source therefore needs a DEDUPE, and the rule
 * is to keep the richer post -- the one with the price.
 *
 * WHAT HE POSTS
 *
 *   "Long $NKE `35.5322` $35.55 - 1,000 Shares"
 *   "Exit $RBLX `51.665` with $1.02 profit per share (1,000)"
 *   "Short $SPY PDS $730/$720 for $3.08 - 10 Contract - expires Friday"
 *   "Long $NVDA `165.96` Lottos CDS $167.5/$170 - for .83 - 20 Contracts"
 *   "I sold the $AMD $500 Calls (again) this time for $8.55"
 *   "Bought back the sold Calls for $4 profit per contract (5 Contract)"
 *   "I added to another 250 Shares, 750 Total now for an average price of $109.68"
 *
 * THE PRICE IS THE FIRST NUMBER AFTER THE TICKER, and that was MEASURED
 * rather than assumed. Over the entry/exit pairs that state a profit, the
 * first number after the ticker is within 5 % of the exit price in 101 of
 * 110 pairs (median 0.50 %); the second number is within 5 % in 124 of
 * 481, with a median distance of 78 %. So the second number is the SIZE
 * or a STRIKE, not a price.
 *
 * AND THE ONE EXCEPTION: an exit that states the profit and no price --
 * "Exit $MRNA with $1.5 profit per share" -- has no price at all, and
 * the number there is the profit. So the first number after the ticker
 * is the price UNLESS it is the stated profit.
 */

const PARSER_VERSION = 'hariseldon-trades-1';
const SOURCE_NAME = 'hariseldon';

const GUILD_ID = '1058604837467607100';
const CHANNEL_ID = '1058608221159440424';
const CHANNEL_LABEL = 'verified-traders';

/** The account, and the four names it posts under. */
const AUTHOR_ID = '1058608380173889537';
const AUTHOR_NAMES = ['*HariSeldon*', 'Twitter: RealDayTrading', 'HSeldon2020', 'OptionStalker'];

/** The name whose post carries the most detail, and so wins a dedupe. */
const PRIMARY_NAME = '*HariSeldon*';

/** How close two posts have to be to be the same trade. */
const DEDUPE_MINUTES = 20;

module.exports = {
  AUTHOR_ID,
  AUTHOR_NAMES,
  CHANNEL_ID,
  CHANNEL_LABEL,
  DEDUPE_MINUTES,
  GUILD_ID,
  PARSER_VERSION,
  PRIMARY_NAME,
  SOURCE_NAME,
};
