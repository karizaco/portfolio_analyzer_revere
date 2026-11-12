'use strict';

// Read the SECTOR TABLE out of the grabbed frames, and check the article
// against it.
//
// WHAT IT DOES
//
// 1. Parses every frame of every post into rows of
//    (sector, 1-month rate of change, % change).
//
// 2. Merges the frames of one post on the sector name, because the table
//    SCROLLS: no single frame shows all eleven sectors.
//
// 3. Checks the WRITTEN report against the table. The article names
//    sectors to focus on and sectors to avoid; the table gives the
//    numbers. So this can say, for every post, where the author's
//    "Primary focus" sectors actually RANKED by 1-month rate of change
//    among the eleven -- which is the first thing this source can be
//    checked against.
//
// THE MERGE POLICY
//
// The table's values are a LIVE reading -- the recording is made with the
// platform on screen, and the market moves while the author talks. So
// the same sector can read differently in different frames.
//
// The MEDIAN wins, because the OCR of a small number is fragile and the
// market moves while the author talks. The spread across the frames is
// reported so that a value that moves a lot is visible rather than
// silently averaged away.
//
// The OCR of each frame is CACHED, keyed by the frame's path, so a
// second run does not re-read 192 frames.
//
// Usage:
//   node tools/parseAsymSectors.js
//   node tools/parseAsymSectors.js --limit 2
//   node tools/parseAsymSectors.js --video-id asym_208954832
//   node tools/parseAsymSectors.js --json
//   node tools/parseAsymSectors.js --no-cache   // force every frame to be read again

const fs = require('node:fs');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  GICS_SECTORS,
  PARSER_VERSION,
  articleSector,
  closeSectorOcr,
  parseSectorPanel,
  reduceReadings,
} = require('../src/asym/sectorTable');
const { writeCsv } = require('../src/write/writeCsv');
const {
  cachedFrameOcr,
  ensureFrameOcrTable,
  frameOcrStats,
  storeFrameOcr,
} = require('../src/asym/frameOcrCache');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const OUTPUT_DIR = path.join(ROOT, 'data');

const CONSISTENCY_COLUMNS = [
  'upload_date', 'video_id', 'article_sector', 'gics_sector', 'tier',
  'rank_by_roc', 'of_sectors', 'roc_1mo', 'pct_change', 'roc_1yr',
  'article_rank_check', 'consistency',
];

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  json: argv.includes('--json'),
  // --no-cache forces every frame to be read again, which is what a
  // parser change needs; the cache invalidates itself when the parser
  // version moves, but this is the manual way to be sure.
  noCache: argv.includes('--no-cache'),
};

/**
 * Read a flag's value.
 *
 * @param {string[]} args
 * @param {string} name
 * @returns {string|null}
 */
function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] || '';
}

/**
 * Make sure the sector table has the columns this tool writes.
 *
 * `CREATE TABLE IF NOT EXISTS` does not add a column to a table that
 * already exists, so a catalog written before a column was added does
 * not have it. The ALTER is idempotent -- it fails, harmlessly, when
 * the column is already there -- which is the project's own idiom.
 *
 * @param {DatabaseSync} db
 * @returns {void}
 */
function ensureAsymSectorsSchema(db) {
  const columns = [
    ["readings", "INTEGER NOT NULL DEFAULT 0"],
    ["complete_readings", "INTEGER NOT NULL DEFAULT 0"],
    ["approximate", "INTEGER NOT NULL DEFAULT 0"],
    ["change_spread", "REAL NOT NULL DEFAULT 0"],
    ["roc_1yr", "REAL"],
    ["roc1yr_spread", "REAL NOT NULL DEFAULT 0"],
  ];
  for (const [name, type] of columns) {
    try {
      db.exec(`ALTER TABLE asym_sectors ADD COLUMN ${name} ${type}`);
    } catch {
      // The column is already there.
    }
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  ensureFrameOcrTable(db);
  ensureAsymSectorsSchema(db);

  const frames = selectFrames(db);
  if (!frames.length) {
    console.log('[asym-sectors] no frames yet. Run node tools/extractAsymFrames.js first.');
    db.close();
    return;
  }
  console.log(`[asym-sectors] frames=${frames.length}`);

  // The parsed rows, per post.
  //
  // The OCR of a frame is the slow part, and a frame does not change, so
  // the reading is cached: the cache is keyed by the frame's path and is
  // only used when the file is the same file (same size, same mtime) and
  // the parser is the same version.
  const byPost = new Map();
  let readFromCache = 0;
  let readFromDisk = 0;
  let fallbackFrames = 0;
  let clippedYearCells = 0;
  for (const frame of frames) {
    let parsed = null;
    if (!options.noCache) {
      parsed = cachedFrameOcr(db, frame.file_path, PARSER_VERSION);
    }
    if (parsed) {
      readFromCache += 1;
    } else {
      try {
        parsed = await parseSectorPanel(path.join(ROOT, frame.file_path));
      } catch (error) {
        console.error(`[asym-sectors] ${frame.video_id} frame ${frame.frame_index} failed: ${error.message}`);
        continue;
      }
      readFromDisk += 1;
      try {
        storeFrameOcr(db, frame.file_path, PARSER_VERSION, parsed);
      } catch (error) {
        console.error(`[asym-sectors] ${frame.file_path} not cached: ${error.message}`);
      }
    }
    if (parsed.warnings && parsed.warnings.includes('geometry_fallback')) {
      fallbackFrames += 1;
    }
    for (const row of parsed.rows) {
      if (row.roc1yr_clipped) clippedYearCells += 1;
    }
    if (!byPost.has(frame.video_id)) {
      byPost.set(frame.video_id, { frames: [], rows: new Map() });
    }
    const post = byPost.get(frame.video_id);
    post.frames.push(frame);

    for (const row of parsed.rows) {
      if (!post.rows.has(row.sector)) {
        post.rows.set(row.sector, { sector: row.sector, readings: [], spoken: row.spoken_name });
        post.rows.get(row.sector).readings.push({ ...row, frame });
        continue;
      }
      post.rows.get(row.sector).readings.push({ ...row, frame });
    }
  }

  const insert = db.prepare(`
    INSERT INTO asym_sectors (video_id, sector, roc_1mo, pct_change, roc_1yr,
      sign_source, frame_path, frame_timestamp_sec, readings, complete_readings,
      approximate, change_spread, roc1yr_spread, confidence, parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, sector) DO UPDATE SET
      roc_1mo = excluded.roc_1mo,
      pct_change = excluded.pct_change,
      roc_1yr = excluded.roc_1yr,
      sign_source = excluded.sign_source,
      frame_path = excluded.frame_path,
      frame_timestamp_sec = excluded.frame_timestamp_sec,
      readings = excluded.readings,
      complete_readings = excluded.complete_readings,
      approximate = excluded.approximate,
      change_spread = excluded.change_spread,
      roc1yr_spread = excluded.roc1yr_spread,
      confidence = excluded.confidence,
      parser_version = excluded.parser_version,
      parsed_at = datetime('now')
  `);

  let written = 0;
  db.exec('BEGIN');
  for (const [videoId, post] of byPost.entries()) {
    for (const row of post.rows.values()) {
      const reduced = reduceReadings(row.readings);
      if (!reduced) continue;
      // The frame the value is ATTRIBUTED to is the frame that supplied
      // it -- the % Change's frame when there is one, because the sign
      // comes from that frame's glyph colour.
      const source = reduced.change_frame || reduced.roc_frame || {};
      insert.run(
        videoId,
        reduced.sector,
        reduced.roc_1mo,
        reduced.pct_change,
        reduced.roc_1yr,
        reduced.sign_source,
        source.file_path || '',
        source.timestamp_sec || 0,
        reduced.readings || 0,
        reduced.complete_readings || 0,
        reduced.approximate ? 1 : 0,
        reduced.change_spread || 0,
        reduced.roc1yr_spread || 0,
        reduced.confidence,
        PARSER_VERSION,
      );
      written += 1;
    }
  }
  db.exec('COMMIT');

  const consistency = buildConsistency(db, byPost);
  await writeCsv(path.join(OUTPUT_DIR, 'asym_sector_consistency.csv'), CONSISTENCY_COLUMNS, consistency);

  const payload = {
    generated_at: new Date().toISOString(),
    parser_version: PARSER_VERSION,
    posts: byPost.size,
    sectors_written: written,
    consistency_rows: consistency.length,
    consistency,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'asym_sectors.json'), JSON.stringify(payload, null, 2), 'utf8');

  await closeSectorOcr();
  db.close();

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`[asym-sectors] frames read: ${readFromDisk} from disk, ${readFromCache} from the cache`);
  console.log(`[asym-sectors] geometry: fallback frames=${fallbackFrames}, clipped 1yr cells=${clippedYearCells}`);
  console.log(`[asym-sectors] posts=${byPost.size} sector rows=${written}`
    + ` consistency rows=${consistency.length}`);
  console.log('[asym-sectors] wrote data/asym_sector_consistency.csv and data/asym_sectors.json');
}

/**
 * The frames to parse.
 *
 * @param {DatabaseSync} db
 * @returns {Array<object>}
 */
function selectFrames(db) {
  const params = [];
  let sql = `SELECT f.video_id, f.frame_index, f.timestamp_sec, f.file_path,
                    p.upload_date, p.series
               FROM asym_frames f
               JOIN asym_posts p ON p.video_id = f.video_id`;
  if (options.videoId) {
    sql += ' WHERE f.video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY f.video_id ASC, f.frame_index ASC';

  let rows = db.prepare(sql).all(...params);
  if (options.limit) rows = rows.slice(0, options.limit);
  return rows;
}

/**
 * Check the article's sector picks against the table's numbers.
 *
 * For every sector the article names, this says where that sector
 * RANKED among the eleven by 1-month rate of change -- and whether the
 * author picked it from the top of the table or against it.
 *
 * @param {DatabaseSync} db
 * @param {Map} byPost
 * @returns {Array<object>}
 */
function buildConsistency(db, byPost) {
  const rows = [];
  const articles = db.prepare(`
    SELECT a.video_id, a.sectors, p.upload_date
      FROM asym_articles a JOIN asym_posts p ON p.video_id = a.video_id
     WHERE a.sectors IS NOT NULL AND length(a.sectors) > 2
     ORDER BY p.upload_date DESC
  `).all();

  for (const article of articles) {
    let named = [];
    try {
      named = JSON.parse(article.sectors);
    } catch {
      continue;
    }
    const post = byPost.get(article.video_id);
    if (!post) continue;

    // The ranking, by the 1-month rate of change.
    const flat = [...post.rows.values()]
      .map((entry) => reduceReadings(entry.readings))
      .filter(Boolean);
    const ranked = flat
      .filter((row) => row.roc_1mo !== null)
      .sort((a, b) => b.roc_1mo - a.roc_1mo);
    const rankOf = new Map(ranked.map((row, index) => [row.sector, index + 1]));
    const bySector = new Map(flat.map((row) => [row.sector, row]));

    for (const entry of named) {
      const gics = articleSector(entry.sector);
      if (!gics) continue;
      const row = bySector.get(gics);
      const rank = rankOf.get(gics) || '';
      const total = ranked.length;
      const tier = entry.tier || '';

      // "Is the author picking from the top?" -- a primary focus sector
      // that is in the top half is consistent with the table; one in the
      // bottom half is not. An "avoid" sector is the mirror image.
      let check = 'unknown';
      if (rank && total) {
        const inTopHalf = rank <= total / 2;
        if (tier === 'primary' || tier === 'secondary') {
          check = inTopHalf ? 'consistent' : 'contradicts';
        } else if (tier === 'avoid') {
          check = inTopHalf ? 'contradicts' : 'consistent';
        }
      }
      rows.push({
        upload_date: article.upload_date,
        video_id: article.video_id,
        article_sector: entry.sector,
        gics_sector: gics,
        tier,
        rank_by_roc: rank,
        of_sectors: total,
        roc_1mo: row && row.roc_1mo !== null ? row.roc_1mo : '',
        pct_change: row && row.pct_change !== null ? row.pct_change : '',
        roc_1yr: row && row.roc_1yr !== null ? row.roc_1yr : '',
        article_rank_check: check,
        consistency: check,
      });
    }
  }
  return rows;
}

main().catch((error) => {
  console.error(`[asym-sectors] failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});