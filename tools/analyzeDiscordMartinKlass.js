'use strict';

/**
 * Score Martin Klass's calls against what the price did next.
 *
 * The same bookkeeping as `tools/analyzeDiscordMonoszon.js`, and the
 * scoring itself lives in `src/discord/readingsAnalysis.js` -- which
 * every Discord reading source shares, so the copies cannot drift.
 *
 * **ONLY THE FORWARD CLAIMS ARE SCORED.** His `investování` channel is a
 * daily digest of the earnings, and every one of those messages reports
 * what ALREADY HAPPENED: "📉 Ambarella se potýká s nedostatkem
 * paměťových čipů, akcie výrazně klesají". A result cannot be scored,
 * because the price has already moved by the time the claim is written.
 * Those readings are RECORDED -- they are the context that makes the
 * forward ones readable -- and they are not scored.
 *
 * The precision of the forward readings is measured and stated: **75.0 %**
 * of the 52 of them are a call on that instrument in that direction (the
 * hand-labelled sample is `test/fixtures/martinklass/`).
 *
 * Usage:
 *   node tools/analyzeDiscordMartinKlass.js
 *   node tools/analyzeDiscordMartinKlass.js --json
 */

const path = require('node:path');
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { analyseReadings } = require('../src/discord/readingsAnalysis');
const { SOURCE_NAME } = require('../src/discord/martinklass/sources');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUTPUT_DIR = path.join(ROOT, 'data');

const OUTCOME_COLUMNS = [
  'as_of_date', 'channel', 'subject', 'proxy_ticker', 'scope', 'stance', 'claim_kind',
  'horizon', 'confidence', 'event_date', 'yahoo_symbol', 'bias',
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
    SELECT id, as_of_date, posted_at, channel, scope, subject, proxy_ticker, stance,
           claim_kind, horizon, horizon_text, confidence, evidence_text, message_id
      FROM martinklass_readings
     WHERE parser_version = (SELECT MAX(parser_version) FROM martinklass_readings)
  `).all();

  const coverage = {
    readings: all.length,
    by_kind: {},
    by_channel: {},
    forward: 0,
    reported: 0,
    forward_with_proxy: 0,
  };
  for (const row of all) {
    coverage.by_kind[row.claim_kind] = (coverage.by_kind[row.claim_kind] || 0) + 1;
    coverage.by_channel[row.channel] = (coverage.by_channel[row.channel] || 0) + 1;
  }
  coverage.forward = all.filter((row) => row.claim_kind === 'forward').length;
  coverage.reported = all.filter((row) => row.claim_kind === 'reported').length;
  coverage.forward_with_proxy = all.filter((row) => row.claim_kind === 'forward'
    && (row.stance === 'bullish' || row.stance === 'bearish')
    && row.proxy_ticker).length;

  if (!coverage.forward_with_proxy) {
    console.log('[martinklass-outcomes] no forward readings -- run tools/buildDiscordMartinKlassReadings.js first');
    db.close();
    return;
  }

  const payload = await analyseReadings({
    sourceName: SOURCE_NAME,
    logPrefix: '[martinklass-outcomes]',
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
      channel: row.channel,
    })),
    coverage,
    entryRuleNote: 'close on the date he wrote it; his calls are published after the news that moved the name,'
      + ' so the entry is after the move the call is about -- which is late by construction',
    outputJson: path.join(OUTPUT_DIR, 'discord_martinklass.json'),
    outputCsv: path.join(OUTPUT_DIR, 'discord_martinklass_outcomes.csv'),
    csvColumns: OUTCOME_COLUMNS,
    rowFields: (reading) => ({ channel: reading.channel }),
    extraSummary: () => ({ measured_precision: 0.75 }),
  });
  db.close();

  if (options.json && payload) console.log(JSON.stringify(payload, null, 2));
  else console.log('[martinklass-outcomes] wrote data/discord_martinklass.json, data/discord_martinklass_outcomes.csv');
}

main().catch((error) => {
  console.error(`[martinklass-outcomes] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
