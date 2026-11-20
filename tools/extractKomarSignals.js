'use strict';

/**
 * Extract the SETUPS from the Komar transcripts.
 *
 * WHAT THIS STAGE DOES
 *
 * A SETUP is what the author SAID he was watching: a ticker, an
 * action, a direction where he states one, and the words it was read
 * from. The transcripts are the corpus's primary text (Phase 4), and
 * this stage reads them with the SHARED engine --
 * `src/sevcik/signalExtractor.js`, the same one the Sevcik, T3Live and
 * Benzinga extractors use -- with the English name finder and the
 * Komar lexicon.
 *
 * The rows go into `komar_setups`, the source's own table, because
 * `trade_signals` is a YouTube table: its rows carry a NOT NULL
 * `transcript_id` that REFERENCES `video_transcripts(id)`, and this
 * corpus has no YouTube identity at all.
 *
 * THE LEXICON IS THE SOURCE'S OWN
 *
 * Measured on 2026-11-17: the corpus names 105 tickers and only 32 of
 * them are in the shared seed lexicon, so the lexicon here is the seed
 * plus `config/ticker_lexicon_komar.csv` (the other 73), and the
 * capitalised tokens that are the LESSON rather than a holding (EMA,
 * MMTS, "the US market", ...) are stopped -- see `src/komar/lexicon.js`.
 *
 * Usage:
 *   node tools/extractKomarSignals.js --dry-run
 *   node tools/extractKomarSignals.js --limit 10
 *   node tools/extractKomarSignals.js --video-id komar_vid_weekend_226_stocks
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived } = require('../src/db/derivedStore');
const { extractSignals } = require('../src/sevcik/signalExtractor');
const { normalizeTranscript } = require('../src/transcript/transcriptNormalize');
const {
  KOMAR_SYMBOL_STOPLIST,
  findKomarCompanyNames,
  loadKomarLexicon,
} = require('../src/komar/lexicon');
const { rejoinBrokenTickers } = require('../src/komar/transcriptRepair');
const { ensureKomarSchema } = require('../src/komar/schema');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

/** The parser version written onto every row. */
const PARSER_VERSION = 'komar-signals-2';

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  // The repair joins a ticker the provider split across a boundary.
  // It is ON by default and can be turned OFF, so the before and after
  // can be measured with the same command.
  rejoin: !argv.includes('--no-rejoin'),
};

/**
 * Open the catalog with the derived file attached.
 *
 * @returns {object}
 */
function openDatabase() {
  const db = new DatabaseSync(CATALOG_DB_PATH);
  attachDerived(db);
  ensureKomarSchema(db);
  return db;
}

/**
 * The transcripts to read.
 *
 * @param {object} db
 * @returns {object[]}
 */
function listTranscripts(db) {
  let sql = `
    SELECT id, video_id, transcript_path, segment_count, language
    FROM komar_transcripts
  `;
  const params = [];
  if (options.videoId) {
    sql += ' WHERE video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY video_id';
  if (options.limit > 0) sql += ` LIMIT ${Math.max(1, options.limit)}`;
  return db.prepare(sql).all(...params);
}

/**
 * The segments of one transcript.
 *
 * The JSON file is the RECORD (it is tracked, and the segments are
 * rebuilt from it), so it is read from there and not from a cache.
 *
 * @param {object} transcript
 * @returns {object[]}
 */
function loadSegments(transcript) {
  const file = path.isAbsolute(transcript.transcript_path)
    ? transcript.transcript_path
    : path.join(ROOT, transcript.transcript_path);
  if (!fs.existsSync(file)) return [];
  let body;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  // The normalizer INFERRED the shape: the file is the canonical
  // transcript JSON (`segments`), not the provider's raw response.
  // (Passing `body.provider` would send it down the Deepgram path,
  // which understands only the raw payload and would return nothing.)
  return normalizeTranscript(body);
}

/**
 * Write one video's setups, replacing whatever was there before.
 *
 * @param {object} db
 * @param {string} videoId
 * @param {object[]} setups
 */
function writeSetups(db, videoId, setups) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM komar_setups WHERE video_id = ?').run(videoId);
    const statement = db.prepare(`
      INSERT INTO komar_setups (
        video_id, transcript_id, ticker, spoken_name, action, bias, strength,
        claim_kind, confidence_label, confidence_score, entry_price,
        target_price_low, target_price_high, stop_price, horizon_text,
        rationale, evidence_text, segment_start_index, segment_end_index,
        event_time_sec, parser_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const setup of setups) {
      statement.run(
        videoId,
        setup.transcript_id || 0,
        setup.ticker,
        setup.spoken_name || '',
        setup.action || '',
        setup.bias || '',
        Number(setup.strength || 0),
        setup.claim_kind || '',
        setup.confidence_label || '',
        Number(setup.confidence_score || 0),
        setup.entry_price === undefined ? null : setup.entry_price,
        setup.target_price_low === undefined ? null : setup.target_price_low,
        setup.target_price_high === undefined ? null : setup.target_price_high,
        setup.stop_price === undefined ? null : setup.stop_price,
        setup.horizon_text || '',
        setup.rationale || '',
        setup.evidence_text || '',
        Number(setup.segment_start_index || 0),
        Number(setup.segment_end_index || 0),
        Number(setup.event_time_sec || 0),
        setup.parser_version || PARSER_VERSION
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function main() {
  const db = openDatabase();
  const transcripts = listTranscripts(db);
  const lexicon = loadKomarLexicon();

  const summary = {
    lexicon: lexicon.size,
    parser_version: PARSER_VERSION,
    repairs: [],
    setups: 0,
    transcripts: transcripts.length,
    tickers: {},
    videos_with_setups: 0,
  };

  for (const transcript of transcripts) {
    const stored = loadSegments(transcript);
    if (!stored.length) continue;
    // THE REPAIR. The provider's tokenisation split a holding across a
    // boundary ("I bought into DF," | "DV. I see..."), and the split
    // halves are two words the provider wrote, so no join in the
    // segmenter could have repaired it. The rule is the Komar's own
    // (it needs the corpus's tickers to decide) and it cannot invent
    // anything: the joined form has to BE a ticker the corpus knows.
    const { repairs, segments } = options.rejoin
      ? rejoinBrokenTickers(stored, { lexicon })
      : { repairs: [], segments: stored };
    for (const repair of repairs) {
      summary.repairs.push({ ...repair, video_id: transcript.video_id });
    }
    const setups = extractSignals({
      segments,
      parserVersion: PARSER_VERSION,
      lexicon,
      // The CAPS rule is the gate: a spoken ticker is written in
      // capitals and an ordinary word is not, and the corpus is full of
      // capitalised chart terms.
      confirmedSymbols: null,
      requireCapsSymbols: true,
      symbolStoplist: KOMAR_SYMBOL_STOPLIST,
      nameFinderFn: findKomarCompanyNames,
      videoId: transcript.video_id,
      transcriptId: transcript.id,
    });
    summary.setups += setups.length;
    if (setups.length) summary.videos_with_setups += 1;
    for (const setup of setups) {
      summary.tickers[setup.ticker] = (summary.tickers[setup.ticker] || 0) + 1;
    }
    if (!options.dryRun) writeSetups(db, transcript.video_id, setups);
  }

  db.close();

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const top = Object.entries(summary.tickers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ticker, count]) => `${ticker}:${count}`)
    .join(' ');
  console.log(
    `${summary.setups} setups over ${summary.videos_with_setups} of ${summary.transcripts} transcripts `
    + `(lexicon ${summary.lexicon} tickers, ${summary.repairs.length} ticker(s) rejoined)\n  ${top}`
  );
  for (const repair of summary.repairs) {
    console.log(`  rejoined ${repair.was} -> ${repair.joined} in ${repair.video_id}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  PARSER_VERSION,
  listTranscripts,
  loadSegments,
  writeSetups,
};
