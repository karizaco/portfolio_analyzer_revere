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
// The FIRST frame wins, because it is deterministic and reproducible, and
// the spread across the frames is reported so that a value that moves a
// lot is visible rather than silently averaged away.
//
// Usage:
//   node tools/parseAsymSectors.js
//   node tools/parseAsymSectors.js --limit 2
//   node tools/parseAsymSectors.js --video-id asym_208954832
//   node tools/parseAsymSectors.js --json

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
} = require('../src/asym/sectorTable');
const { writeCsv } = require('../src/write/writeCsv');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const OUTPUT_DIR = path.join(ROOT, 'data');

const CONSISTENCY_COLUMNS = [
  'upload_date', 'video_id', 'article_sector', 'gics_sector', 'tier',
  'rank_by_roc', 'of_sectors', 'roc_1mo', 'pct_change',
  'article_rank_check', 'consistency',
];

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  json: argv.includes('--json'),
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

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  const frames = selectFrames(db);
  if (!frames.length) {
    console.log('[asym-sectors] no frames yet. Run node tools/extractAsymFrames.js first.');
    db.close();
    return;
  }
  console.log(`[asym-sectors] frames=${frames.length}`);

  // The parsed rows, per post.
  const byPost = new Map();
  for (const frame of frames) {
    let parsed = { rows: [], confidence: 0 };
    try {
      parsed = await parseSectorPanel(path.join(ROOT, frame.file_path));
    } catch (error) {
      console.error(`[asym-sectors] ${frame.video_id} frame ${frame.frame_index} failed: ${error.message}`);
      continue;
    }
    if (!byPost.has(frame.video_id)) {
      byPost.set(frame.video_id, { frames: [], rows: new Map() });
    }
    const post = byPost.get(frame.video_id);
    post.frames.push(frame);

    for (const row of parsed.rows) {
      if (!post.rows.has(row.sector)) {
        post.rows.set(row.sector, {
          ...row,
          frame,
          roc_frame: row.roc_1mo === null ? null : frame,
          change_frame: row.pct_change === null ? null : frame,
          spread: 0,
        });
        continue;
      }
      // Each FIELD takes the value from the EARLIEST frame that has one.
      //
      // A single frame can miss a cell -- the OCR does not always read
      // the % Change of every row -- and a later frame of the same video
      // usually does. Filling each field from the earliest frame that
      // HAS it keeps the result deterministic and stops a missed cell
      // from becoming a missing value.
      const existing = post.rows.get(row.sector);
      if (existing.roc_1mo === null && row.roc_1mo !== null) {
        existing.roc_1mo = row.roc_1mo;
        existing.roc_raw = row.roc_raw;
        existing.roc_frame = frame;
      }
      if (existing.pct_change === null && row.pct_change !== null) {
        existing.pct_change = row.pct_change;
        existing.change_raw = row.change_raw;
        existing.change_frame = frame;
      }
      // The spread: how much the value moved across the frames.
      if (row.roc_1mo !== null && existing.roc_1mo !== null) {
        existing.spread = Math.max(existing.spread, Math.abs(row.roc_1mo - existing.roc_1mo));
      }
    }
  }

  const insert = db.prepare(`
    INSERT INTO asym_sectors (video_id, sector, roc_1mo, pct_change, sign_source,
      frame_path, frame_timestamp_sec, confidence, parser_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, sector) DO UPDATE SET
      roc_1mo = excluded.roc_1mo,
      pct_change = excluded.pct_change,
      sign_source = excluded.sign_source,
      frame_path = excluded.frame_path,
      frame_timestamp_sec = excluded.frame_timestamp_sec,
      confidence = excluded.confidence,
      parser_version = excluded.parser_version,
      parsed_at = datetime('now')
  `);

  let written = 0;
  db.exec('BEGIN');
  for (const [videoId, post] of byPost.entries()) {
    for (const row of post.rows.values()) {
      insert.run(
        videoId,
        row.sector,
        row.roc_1mo,
        row.pct_change,
        row.sign_source,
        row.frame.file_path,
        row.frame.timestamp_sec,
        row.confidence,
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
    const ranked = [...post.rows.values()]
      .filter((row) => row.roc_1mo !== null)
      .sort((a, b) => b.roc_1mo - a.roc_1mo);
    const rankOf = new Map(ranked.map((row, index) => [row.sector, index + 1]));

    for (const entry of named) {
      const gics = articleSector(entry.sector);
      if (!gics) continue;
      const row = post.rows.get(gics);
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