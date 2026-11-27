'use strict';

/**
 * Score HariSeldon's OPTION actions as directional claims on the
 * underlying.
 *
 * WHAT THIS IS
 *
 * His equity actions are chained into position episodes. His OPTION
 * actions cannot be: the price he states is the SPREAD's premium and not
 * the underlying's, so an episode priced from the underlying's closes
 * would be priced from two different numbers.
 *
 * So they were recorded and never scored, and that left 544 option
 * opens -- a third of his trading -- outside the measurement.
 *
 * An option structure is a directional claim on the underlying, and his
 * vocabulary says which direction: "Short $ADBE using $407.5 Puts" is
 * bearish, "Long $OXY $50 Strike Calls" is bullish, and "Long Strangle on
 * $SPY" says nothing at all and is not scored.
 *
 * The derivation is `src/discord/hariseldon/optionDirection.js`, which is
 * the SOURCE's own module -- the option vocabulary is his, and it does not
 * belong in shared code.
 *
 * THE SCORING is `src/discord/readingsAnalysis.js`, which every Discord
 * reading source shares.
 *
 * THE CAVEAT IS STATED, NOT HIDDEN
 *
 * A spread is a BOUNDED bet: "Short $SPY PDS $730/$720" pays only below
 * 720. So this measurement asks whether the DIRECTION of his option
 * trades carries information about the underlying -- and the answer is
 * allowed to be "yes, and SPY did the same thing", which is what the
 * excess column says.
 *
 *   node tools/analyzeDiscordHariSeldonOptions.js
 *   node tools/analyzeDiscordHariSeldonOptions.js --json
 */

const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { analyseReadings } = require('../src/discord/readingsAnalysis');
const { readingsFromActions } = require('../src/discord/hariseldon/optionDirection');
const { SOURCE_NAME } = require('../src/discord/hariseldon/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const OUTCOME_COLUMNS = [
  'as_of_date', 'subject', 'proxy_ticker', 'scope', 'stance', 'claim_kind',
  'instrument', 'option_price', 'size_note', 'verb',
  'event_date', 'yahoo_symbol', 'bias',
  'entry_price', 'price_1w', 'price_1m',
  'return_1w', 'return_1m', 'aligned_return_1w', 'aligned_return_1m',
  'spy_return_1w', 'spy_same_call_hit_1w', 'excess_aligned_1w',
  'spy_return_1m', 'spy_same_call_hit_1m', 'excess_aligned_1m',
  'hit_1w', 'hit_1m', 'price_status', 'evidence_text',
];

const options = { json: process.argv.includes('--json') };

async function main() {
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  const actions = db.prepare(`
    SELECT id, message_id, posted_at, kind, action, ticker, price, size_note, verb, content
      FROM discord_trade_actions
     WHERE source_name = ? AND kind = 'option'
     ORDER BY posted_at, id
  `).all(SOURCE_NAME);

  if (!actions.length) {
    console.log('[hariseldon-options] no option actions -- run tools/buildDiscordHariSeldonPositions.js first');
    db.close();
    return;
  }

  const { readings, coverage } = readingsFromActions(actions);
  console.log(`[hariseldon-options] ${coverage.option_actions} option actions:`
    + ` ${coverage.opens} opens (${coverage.opens_with_a_direction} with a direction,`
    + ` ${coverage.opens_without_a_direction} directionless), ${coverage.exits} exits`);

  const payload = await analyseReadings({
    sourceName: SOURCE_NAME,
    logPrefix: '[hariseldon-options]',
    readings,
    coverage,
    entryRuleNote: "the close of the UNDERLYING on the day he opened the structure;"
      + " the price he states is the SPREAD's premium and is recorded with the claim, but it is not the entry",
    outputJson: path.join(OUTPUT_DIR, 'discord_hariseldon_options.json'),
    outputCsv: path.join(OUTPUT_DIR, 'discord_hariseldon_options_outcomes.csv'),
    csvColumns: OUTCOME_COLUMNS,
    rowFields: (reading) => ({
      instrument: reading.instrument,
      option_price: reading.option_price,
      size_note: reading.size_note,
      verb: reading.verb,
    }),
    extraSummary: () => ({
      what_is_measured: 'the DIRECTION of his option structures, on the underlying;'
        + ' a spread is a bounded bet, so this asks whether the direction carries information,'
        + ' not whether the spread was a good trade',
      excluded: 'the opens that state no direction (a strangle is a volatility position),'
        + ' and the exits, which are the resolution of a claim rather than a claim',
    }),
  });
  db.close();

  if (options.json && payload) console.log(JSON.stringify(payload, null, 2));
  else console.log('[hariseldon-options] wrote data/discord_hariseldon_options.json, data/discord_hariseldon_options_outcomes.csv');
}

main().catch((error) => {
  console.error(`[hariseldon-options] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
