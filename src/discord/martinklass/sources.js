'use strict';

/**
 * Martin Klass on Discord -- calls about the market, in Czech.
 *
 * WHAT THIS SOURCE IS
 *
 * His own server ("Martin Klass - Real Trading, Prop Trading a
 * Investování", 1334510084231004202) with two channels of his own:
 *
 *   `trading`      1355565442550595594... no: 1335565442550595594
 *                   (1335565442550595594 is the id; see SOURCES below)
 *                   His own trading commentary. Mostly education, and
 *                   occasionally a call.
 *   `investování`  1338925744147140658
 *                   A DAILY digest of the earnings -- 938 messages, and
 *                   every one of them reports what ALREADY HAPPENED.
 *
 * The two channels are the two CLAIM KINDS the project already has:
 * `forward` (an expectation, scored) and `reported` (a result that has
 * already happened, recorded but NOT scored, because the price has
 * already moved by the time the claim is written).
 *
 * WHY A SOURCE-SPECIFIC MODULE
 *
 * He writes Czech, so the vocabulary is his: the commodities are in
 * Czech ("zlato", "stříbro", "ropa", "pšenice"), the direction words
 * are Czech ("rovnat", "prorazit", "klesat", "propad"), and the TENSE
 * is what tells a call from a report. The shared matcher resolves his
 * COMPANY names ("Ambarella", "CrowdStrike") through the market's own
 * registrant file, and that part is shared.
 */

const PARSER_VERSION = 'martinklass-readings-1';
const SOURCE_NAME = 'martinklass';

const GUILD_ID = '1334510084231004202';
const AUTHOR_ID = '966311894036131860';
const AUTHOR_NAME = 'martinklass';

/** The two channels, and what each one is. */
const SOURCES = {
  'martinklass-trading': {
    channel_id: '1335565442550595594',
    kind: 'trading',
    label: 'trading',
  },
  'martinklass-investing': {
    channel_id: '1338925744147140658',
    kind: 'investing',
    label: 'investování',
  },
};

module.exports = {
  AUTHOR_ID,
  AUTHOR_NAME,
  GUILD_ID,
  PARSER_VERSION,
  SOURCES,
  SOURCE_NAME,
};
