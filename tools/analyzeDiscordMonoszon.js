'use strict';

/**
 * Score David's calls against what the price did next.
 *
 * WHAT IS SCORED
 *
 * His FORWARD calls on an instrument, against the instrument's proxy
 * (QQQ for the Nasdaq 100 future, SPY for the S&P 500 future, GLD for
 * gold) and against SPY.
 *
 * WHAT IS NOT SCORED, AND WHY
 *
 *   retrospective  "dnes byl krásný long na GC" -- a fact, not a call
 *   present        "dnes uzavírám třetinu BTAL longu" -- a position he
 *                  holds, which has already had its move
 *   mixed          a sentence that does not pick a side
 *
 * THE ENTRY IS THE CLOSE ON THE DAY HE WROTE IT
 *
 * He names a level ("abych změnil na bearish, potřeboval bych vidět
 * spx uzavírat pod 6550") and the level is recorded with the reading --
 * but the project's price model enters at the close, because the entry
 * model is close-to-close and a limit level is not a fill. A call made
 * intraday is therefore scored from the close of the day, which leaves
 * the day's own move out of the measured return. That is conservative,
 * and it is stated rather than hidden.
 *
 * THE HORIZONS ARE THE PROJECT'S
 *
 * +7 and +30 calendar days, the same as every other source here. A call
 * whose horizon has not elapsed yet is left unscored, never guessed.
 *
 * The SCORING lives in `src/discord/readingsAnalysis.js`, which every
 * Discord reading source shares -- so the copies cannot drift, which is
 * the lesson the Benzinga extractor taught this project.
 *
 * Usage:
 *   node tools/analyzeDiscordMonoszon.js
 *   node tools/analyzeDiscordMonoszon.js --json
 */

const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { analyseReadings } = require('../src/discord/readingsAnalysis');
const { SOURCE_NAME } = require('../src/discord/monoszon/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const OUTCOME_COLUMNS = [
  'as_of_date', 'subject', 'proxy_ticker', 'scope', 'stance', 'claim_kind', 'horizon',
  'level', 'confidence', 'event_date', 'yahoo_symbol', 'bias',
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
  const all = db.prepare(`
    SELECT id, as_of_date, posted_at, scope, subject, proxy_ticker, stance, claim_kind,
           horizon, horizon_text, level, confidence, evidence_text, message_id
      FROM monoszon_readings
     WHERE parser_version = (SELECT MAX(parser_version) FROM monoszon_readings)
  `).all();

  const coverage = {
    readings: all.length,
    by_kind: {},
    by_stance: {},
    forward: 0,
    forward_with_proxy: 0,
    unscored_no_proxy: 0,
  };
  for (const row of all) {
    coverage.by_kind[row.claim_kind] = (coverage.by_kind[row.claim_kind] || 0) + 1;
    coverage.by_stance[row.stance] = (coverage.by_stance[row.stance] || 0) + 1;
  }
  coverage.forward = all.filter((row) => row.claim_kind === 'forward').length;
  coverage.forward_with_proxy = all.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && row.proxy_ticker).length;
  coverage.unscored_no_proxy = all.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && !row.proxy_ticker).length;

  if (!coverage.forward_with_proxy) {
    console.log('[monoszon-outcomes] no forward readings with a proxy -- run tools/buildDiscordMonoszonReadings.js first');
    db.close();
    return;
  }

  const payload = await analyseReadings({
    sourceName: SOURCE_NAME,
    logPrefix: '[monoszon-outcomes]',
    readings: all.map((row) => ({
      id: row.message_id || row.id,
      date: row.as_of_date || row.posted_at,
      subject: row.subject,
      proxy_ticker: row.proxy_ticker,
      scope: row.scope,
      stance: row.stance,
      claim_kind: row.claim_kind,
      horizon: row.horizon,
      confidence: row.confidence,
      evidence_text: row.evidence_text,
      // The level he names, which is recorded with the reading and is
      // not the entry.
      level: row.level,
    })),
    coverage,
    entryRuleNote: 'close on the date he wrote it; the level he names is recorded but is not the entry',
    outputJson: path.join(OUTPUT_DIR, 'discord_monoszon.json'),
    outputCsv: path.join(OUTPUT_DIR, 'discord_monoszon_outcomes.csv'),
    csvColumns: OUTCOME_COLUMNS,
    rowFields: (reading) => ({ level: reading.level }),
    extraSummary: (outcomes) => {
      // The SPY-PROXIED CALLS ARE DEGENERATE AGAINST SPY, and that is said.
      //
      // A call on the S&P 500 future is scored on SPY, so "the same call
      // on SPY" IS the call, and the excess is zero by construction. The
      // numbers that carry information for those rows are the hit rate
      // and the average return -- not the edge.
      const spyProxied = outcomes.filter((row) => row.proxy_ticker === 'SPY');
      return {
        spy_proxied: {
          calls: spyProxied.length,
          note: 'scored on SPY, so the excess against SPY is zero by construction;'
            + ' the hit rate and the average return are the numbers that mean something',
        },
      };
    },
  });
  db.close();

  if (options.json && payload) console.log(JSON.stringify(payload, null, 2));
  else console.log('[monoszon-outcomes] wrote data/discord_monoszon.json, data/discord_monoszon_outcomes.csv');
}

main().catch((error) => {
  console.error(`[monoszon-outcomes] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
