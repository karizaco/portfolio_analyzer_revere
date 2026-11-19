'use strict';

// Pair FundedMind trade_signals into session setups / day books.
// Writes JSON under data/video_pipeline/fundedmind_setups/ and
// rows into derived.fundedmind_setups (replace-by-video).
//
// Usage:
//   node tools/pairFundedMindSetups.js --limit 50
//   node tools/pairFundedMindSetups.js --day 20261113 --json
//   node tools/pairFundedMindSetups.js --dry-run

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  attachDerived,
  ensureDerivedTable,
} = require('../src/db/derivedStore');
const { FUNDEDMIND_CHANNEL } = require('../src/fundedmind/channel');
const {
  dateFromTitle,
  hostFromTitle,
  sessionKind,
  FUNDEDMIND_KINDS,
} = require('../src/fundedmind/contentFilter');
const { PARSER_VERSION } = require('../src/fundedmind/signalExtractor');
const { groupSetupsByDay, pairSetupsForVideo } = require('../src/fundedmind/setupPairing');
const {
  applyRecapJudgments,
  weekWindowFromRecapDate,
} = require('../src/fundedmind/recapRead');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const OUT_DIR = path.join(ROOT, 'data', 'video_pipeline', 'fundedmind_setups');

const FUNDEDMIND_SETUPS_DDL = `
CREATE TABLE IF NOT EXISTS fundedmind_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  session_date TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  ticker TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  start_sec REAL,
  end_sec REAL,
  entry_price REAL,
  stop_price REAL,
  targets_json TEXT NOT NULL DEFAULT '[]',
  ticker_from TEXT NOT NULL DEFAULT '',
  claim_kind TEXT NOT NULL DEFAULT 'forward',
  score REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]',
  recap_verdict TEXT NOT NULL DEFAULT '',
  recap_evidence TEXT NOT NULL DEFAULT '',
  recap_video_id TEXT NOT NULL DEFAULT '',
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fundedmind_setups_video
  ON fundedmind_setups(video_id);
CREATE INDEX IF NOT EXISTS idx_fundedmind_setups_day
  ON fundedmind_setups(session_date);
CREATE INDEX IF NOT EXISTS idx_fundedmind_setups_parser
  ON fundedmind_setups(parser_version);
`;

const argv = process.argv.slice(2);
function readFlag(list, name) {
  const i = list.indexOf(name);
  if (i === -1) return '';
  return list[i + 1] || '';
}
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  day: readFlag(argv, '--day') || '',
  videoId: readFlag(argv, '--video-id') || '',
  parserVersion: readFlag(argv, '--parser-version') || PARSER_VERSION,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  noDb: argv.includes('--no-db'),
  minScore: Number(readFlag(argv, '--min-score')) || 0,
};

function fieldFromRationale(rationale, key) {
  const m = String(rationale || '').match(new RegExp(`${key}=([^;]+)`));
  return m ? m[1].trim() : '';
}

function ensureSchema(db) {
  ensureDerivedTable(db, 'fundedmind_setups', FUNDEDMIND_SETUPS_DDL);
}

function replaceSetupsForVideo(db, videoId, setups, parserVersion) {
  db.prepare(
    'DELETE FROM fundedmind_setups WHERE video_id = ? AND parser_version = ?',
  ).run(videoId, parserVersion);

  const insert = db.prepare(
    `INSERT INTO fundedmind_setups (
      video_id, session_date, host, kind, title, ticker, side, status,
      start_sec, end_sec, entry_price, stop_price, targets_json, ticker_from,
      claim_kind, score, evidence_json, events_json,
      recap_verdict, recap_evidence, recap_video_id, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const s of setups) {
    insert.run(
      s.video_id,
      s.session_date || '',
      s.host || '',
      s.kind || '',
      s.title || '',
      s.ticker,
      s.side || '',
      s.status || '',
      s.start_sec,
      s.end_sec,
      s.entry_price,
      s.stop_price,
      JSON.stringify(s.targets || []),
      s.ticker_from || '',
      s.claim_kind || 'forward',
      s.score || 0,
      JSON.stringify(s.evidence || []),
      JSON.stringify(s.events || []),
      s.recap_verdict || '',
      s.recap_evidence || '',
      s.recap_video_id || '',
      parserVersion,
    );
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureSchema(db);

  let sql =
    `SELECT s.video_id, s.ticker, s.action, s.bias, s.claim_kind, s.event_time_sec,
            s.entry_price, s.stop_price, s.target_price_low, s.evidence_text,
            s.rationale, s.horizon_text, s.parser_version, v.title, v.upload_date
     FROM trade_signals s
     JOIN videos v ON v.video_id = s.video_id
     WHERE v.channel = ? AND s.parser_version = ?`;
  const params = [FUNDEDMIND_CHANNEL, options.parserVersion];
  if (options.videoId) {
    sql += ' AND s.video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY v.upload_date DESC, s.event_time_sec ASC';

  const rows = db.prepare(sql).all(...params);

  const byVideo = new Map();
  for (const row of rows) {
    if (!byVideo.has(row.video_id)) byVideo.set(row.video_id, []);
    byVideo.get(row.video_id).push(row);
  }

  let setups = [];
  let videoCount = 0;
  const recapByVideo = new Map();

  for (const [videoId, signals] of byVideo.entries()) {
    const title = signals[0].title || '';
    const kind = sessionKind(title);
    const meta = {
      session_date: dateFromTitle(title, { uploadDate: signals[0].upload_date || '' }) || signals[0].upload_date || '',
      host: hostFromTitle(title),
      kind,
      title,
    };
    if (options.day && meta.session_date !== options.day) continue;

    if (kind === FUNDEDMIND_KINDS.WEEK_RECAP) {
      recapByVideo.set(videoId, { meta, signals });
      continue;
    }

    // Live path only for pairing opens.
    const liveSignals = signals.filter((s) => s.claim_kind !== 'retrospective');
    videoCount += 1;
    if (options.limit && videoCount > options.limit) break;
    setups = setups.concat(pairSetupsForVideo(liveSignals, meta));
  }

  // Attach week-recap confirm/deny onto setups in that calendar week.
  let recapApplied = 0;
  for (const [recapVideoId, pack] of recapByVideo.entries()) {
    const week = weekWindowFromRecapDate(pack.meta.session_date);
    const judgments = pack.signals.map((s) => ({
      video_id: recapVideoId,
      ticker: s.ticker === 'MARKET' ? '' : s.ticker,
      side: fieldFromRationale(s.rationale, 'side'),
      verdict: fieldFromRationale(s.rationale, 'recap_verdict'),
      evidence_text: s.evidence_text,
      rationale: s.rationale,
    }));
    const { applied } = applyRecapJudgments(setups, judgments, week);
    recapApplied += applied;
  }

  setups = setups.filter((s) => s.score >= options.minScore);
  const days = groupSetupsByDay(setups);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(
    OUT_DIR,
    `setups_${options.parserVersion}${options.day ? `_${options.day}` : ''}.json`,
  );
  const payload = {
    parser_version: options.parserVersion,
    videos: videoCount,
    recap_videos: recapByVideo.size,
    recap_applied: recapApplied,
    setups: setups.length,
    days: days.length,
    actionable: setups.filter((s) => s.score >= 2).length,
    with_recap: setups.filter((s) => s.recap_verdict).length,
    by_status: setups.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1;
      return acc;
    }, {}),
    by_recap: setups.reduce((acc, s) => {
      const k = s.recap_verdict || '(none)';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    day_books: days,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  let dbRows = 0;
  if (!options.dryRun && !options.noDb) {
    db.exec('BEGIN');
    try {
      const byVid = new Map();
      for (const s of setups) {
        if (!byVid.has(s.video_id)) byVid.set(s.video_id, []);
        byVid.get(s.video_id).push(s);
      }
      // Clear this parser version entirely when doing a full channel pair
      // (no video/day filter), so deleted videos do not leave orphans.
      if (!options.videoId && !options.day && !options.limit) {
        db.prepare(
          'DELETE FROM fundedmind_setups WHERE parser_version = ?',
        ).run(options.parserVersion);
      }
      for (const [videoId, list] of byVid.entries()) {
        if (options.videoId || options.day || options.limit) {
          replaceSetupsForVideo(db, videoId, list, options.parserVersion);
        } else {
          // already wiped parser version; plain insert
          replaceSetupsForVideo(db, videoId, list, options.parserVersion);
        }
        dbRows += list.length;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  db.close();

  if (options.json) {
    console.log(JSON.stringify({ ...payload, db_rows: dbRows, outPath }, null, 2));
  } else {
    console.error(
      `[fundedmind-setups] videos=${videoCount} setups=${setups.length} days=${days.length} `
      + `actionable>=2=${payload.actionable} recap_videos=${recapByVideo.size} recap_applied=${recapApplied} `
      + `with_recap=${payload.with_recap} db_rows=${dbRows}`,
    );
    console.error(`[fundedmind-setups] wrote ${outPath}`);
    for (const day of days.slice(0, 8)) {
      const top = day.setups
        .slice(0, 3)
        .map((s) => `${s.ticker}/${s.side || '?'}@${s.score}:${s.status}${s.recap_verdict ? '/' + s.recap_verdict : ''}`)
        .join(' ');
      console.error(`  ${day.session_date} n=${day.setup_count} [${day.hosts.join(', ')}] ${top}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
