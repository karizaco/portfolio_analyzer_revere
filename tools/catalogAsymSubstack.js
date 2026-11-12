'use strict';

// Catalog the AsymTrading publication.
//
// WHAT IT DOES
//
// Walks the publication's archive, records EVERY post in `asym_posts` --
// free and paid alike -- and reads the body of the free ones into
// `asym_articles`.
//
// WHY THE PAID POSTS ARE CATALOGUED TOO
//
// A paid post is a post that exists. Recording it means the catalog says
// what the publication published, not only what the pipeline was allowed
// to read -- and it means a subscriber session added later has a work list
// to work through. The `access` column records which is which.
//
// It also means the coverage number is honest. "42 of 476 posts were
// read" is a fact about the source; "42 posts" would be a fact about the
// pipeline pretending to be a fact about the source.
//
// WHY THE ARCHIVE ENDPOINT AND NOT THE POSTS ENDPOINT
//
// `/api/v1/posts` returns the body of free posts, and `/api/v1/archive`
// does not. The catalog uses the POSTS endpoint because the body is what
// the whole source is for, and it uses the CURSOR because the API rejects
// `offset` outright.
//
// WHAT IT WRITES
//
//   asym_posts       every post, with its access state and its media id
//   asym_articles    the parsed report of every free post
//   catalog_runs     one audit row, like every other catalog run
//
// The catalog is IDEMPOTENT: a second run over the same corpus updates the
// rows in place and changes nothing else.
//
// Usage:
//   node tools/catalogAsymSubstack.js
//   node tools/catalogAsymSubstack.js --limit 5
//   node tools/catalogAsymSubstack.js --json
//   node tools/catalogAsymSubstack.js --dry-run

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  ASYM_ARCHIVE_URL,
  ASYM_CHANNEL,
  ASYM_PUBLICATION_URL,
  asymVideoId,
} = require('../src/asym/channel');
const { asymAccess, asymMedia, asymPostQuarantine, asymSeries } = require('../src/asym/contentFilter');
const { createAsymClient } = require('../src/asym/substackClient');
const { parseAsymArticle } = require('../src/asym/articleParse');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/**
 * The parser version written onto every article row.
 *
 * 1 (2026-11-11): the first version. It reads the report's market
 * readings by their LABELS rather than by a date, because the report's
 * format changed three times between 2024 and 2026.
 */
const PARSER_VERSION = 'asym-article-1';

const argv = process.argv.slice(2);
const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  maxPages: Number(readFlag(argv, '--max-pages')) || 0,
  json: argv.includes('--json'),
  dryRun: argv.includes('--dry-run'),
  pauseMs: Number(readFlag(argv, '--pause-ms')) || 1200,
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
 * The date the post is ABOUT, as YYYYMMDD.
 *
 * The author's own label is used when there is one, because it is the date
 * the post is about and the publication timestamp is not. 86 of the
 * corpus's posts are published after midnight UTC and so carry a UTC date
 * one day later than the label; for a market recap, the day the report
 * covers is the day that matters.
 *
 * @param {object} post
 * @returns {{uploadDate: string, label: string}}
 */
function postDate(post) {
  const source = post || {};
  const label = String(source.subtitle || '').trim();
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(label);
  if (match) {
    const [, month, day, year] = match;
    return {
      uploadDate: `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`,
      label,
    };
  }
  // No label to use: the UTC date of the timestamp is the best available.
  const iso = String(source.post_date || '').slice(0, 10);
  const compact = iso.replace(/-/g, '');
  return { uploadDate: compact, label };
}

/**
 * Open the catalog, applying the schema.
 *
 * @param {boolean} readOnly
 * @returns {DatabaseSync}
 */
function openCatalog(readOnly) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
  }
  const db = new DatabaseSync(DB_PATH, readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return db;
}

/**
 * The catalogued AsymTrading ids, or an empty set when the table is absent.
 *
 * @param {DatabaseSync} db
 * @returns {string[]}
 */
function readCataloguedIds(db) {
  try {
    return db.prepare('SELECT video_id FROM asym_posts').all().map((row) => row.video_id);
  } catch {
    return [];
  }
}

/**
 * Write one post's row.
 *
 * @param {DatabaseSync} db
 * @param {object} post
 * @returns {object} the row's fields
 */
function upsertPost(db, post) {
  const source = post || {};
  const videoId = asymVideoId(source.id);
  const access = asymAccess(source);
  const quarantine = asymPostQuarantine(source);
  const media = asymMedia(source);
  const { uploadDate, label } = postDate(source);
  const series = asymSeries(source.slug);

  const row = {
    video_id: videoId,
    post_id: String(source.id || ''),
    slug: String(source.slug || ''),
    title: String(source.title || ''),
    post_label: label,
    post_date: String(source.post_date || ''),
    upload_date: uploadDate,
    audience: String(source.audience || ''),
    access: access.readable ? 'free' : access.reason,
    series,
    has_media: media.hasMedia ? 1 : 0,
    media_upload_id: media.mediaUploadId,
    media_upload_ids: JSON.stringify(media.mediaUploadIds || []),
    media_duration: null,
    spreadsheet_url: '',
    tc2000_url: '',
    word_count: Number(source.wordcount) || 0,
    quarantined: quarantine.quarantined ? 1 : 0,
    quarantine_reason: quarantine.reason,
    body_fetched_at: '',
  };

  db.prepare(`
    INSERT INTO asym_posts (
      video_id, post_id, slug, title, post_label, post_date, upload_date,
      audience, access, series, has_media, media_upload_id, media_upload_ids,
      media_duration,
      spreadsheet_url, tc2000_url, word_count, quarantined, quarantine_reason,
      body_fetched_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      post_id = excluded.post_id,
      slug = excluded.slug,
      title = excluded.title,
      post_label = excluded.post_label,
      post_date = excluded.post_date,
      upload_date = excluded.upload_date,
      audience = excluded.audience,
      access = excluded.access,
      series = excluded.series,
      has_media = excluded.has_media,
      media_upload_id = CASE
        WHEN excluded.media_upload_id <> '' THEN excluded.media_upload_id
        ELSE asym_posts.media_upload_id
      END,
      media_upload_ids = CASE
        WHEN excluded.media_upload_ids <> '' THEN excluded.media_upload_ids
        ELSE asym_posts.media_upload_ids
      END,
      media_duration = CASE
        WHEN excluded.media_duration IS NOT NULL THEN excluded.media_duration
        ELSE asym_posts.media_duration
      END,
      spreadsheet_url = CASE
        WHEN excluded.spreadsheet_url <> '' THEN excluded.spreadsheet_url
        ELSE asym_posts.spreadsheet_url
      END,
      tc2000_url = CASE
        WHEN excluded.tc2000_url <> '' THEN excluded.tc2000_url
        ELSE asym_posts.tc2000_url
      END,
      word_count = excluded.word_count,
      quarantined = excluded.quarantined,
      quarantine_reason = excluded.quarantine_reason,
      body_fetched_at = CASE
        WHEN excluded.body_fetched_at <> '' THEN excluded.body_fetched_at
        ELSE asym_posts.body_fetched_at
      END,
      updated_at = datetime('now')
  `).run(
    row.video_id, row.post_id, row.slug, row.title, row.post_label, row.post_date,
    row.upload_date, row.audience, row.access, row.series, row.has_media,
    row.media_upload_id, row.media_upload_ids, row.media_duration,
    row.spreadsheet_url, row.tc2000_url,
    row.word_count, row.quarantined, row.quarantine_reason, row.body_fetched_at,
  );

  return row;
}

/**
 * Write one post's parsed article.
 *
 * @param {DatabaseSync} db
 * @param {object} post
 * @param {object} row - the row written by upsertPost
 */
function upsertArticle(db, post, row) {
  const parsed = parseAsymArticle(post);
  db.prepare(`
    INSERT INTO asym_articles (
      video_id, backdrop, trend, breadth, momentum, cap_sizes, sectors,
      plan_sections, scenarios, bottom_line, index_tickers, paragraphs,
      parser_version, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET
      backdrop = excluded.backdrop,
      trend = excluded.trend,
      breadth = excluded.breadth,
      momentum = excluded.momentum,
      cap_sizes = excluded.cap_sizes,
      sectors = excluded.sectors,
      plan_sections = excluded.plan_sections,
      scenarios = excluded.scenarios,
      bottom_line = excluded.bottom_line,
      index_tickers = excluded.index_tickers,
      paragraphs = excluded.paragraphs,
      parser_version = excluded.parser_version,
      parsed_at = datetime('now')
  `).run(
    row.video_id,
    parsed.backdrop ? parsed.backdrop.state : '',
    parsed.trend ? parsed.trend.state : '',
    parsed.breadth ? parsed.breadth.state : '',
    parsed.momentum ? parsed.momentum.state : '',
    JSON.stringify(parsed.capSizes),
    JSON.stringify(parsed.sectors),
    JSON.stringify(parsed.planSections),
    JSON.stringify(parsed.scenarios),
    parsed.bottomLine,
    parsed.indexTickers.join(','),
    JSON.stringify(parsed.paragraphs),
    PARSER_VERSION,
  );

  return parsed;
}

/**
 * Record the run in `catalog_runs`, like every other catalog run.
 *
 * @param {DatabaseSync} db
 * @param {object} summary
 * @returns {number} the run id
 */
function recordRun(db, summary) {
  const result = db.prepare(`
    INSERT INTO catalog_runs (
      source_url, channel, command_json, raw_output_path, row_count,
      inserted_count, updated_count, missing_upload_dates, malformed_rows,
      created_at, kind, not_listed_count, listing_complete, row_count_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'live', ?, ?, ?)
  `).run(
    ASYM_ARCHIVE_URL,
    ASYM_CHANNEL,
    JSON.stringify(summary.command || []),
    '',
    summary.rowCount,
    summary.inserted,
    summary.updated,
    0,
    0,
    summary.notListed,
    summary.complete ? 1 : 0,
    'listing_rows',
  );
  return Number(result.lastInsertRowid);
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }

  const client = createAsymClient({
    pageSize: 25,
    pauseMs: options.pauseMs,
    log: (line) => { if (!options.json) console.log(line); },
  });

  const walk = await client.listAllPosts({
    maxPages: options.maxPages,
    maxPosts: options.limit,
  });

  const posts = walk.posts;
  if (!posts.length) {
    console.error('The archive returned no posts. Nothing was written.');
    process.exit(1);
  }

  const summary = {
    command: ['catalogAsymSubstack.js', ...argv],
    rowCount: posts.length,
    inserted: 0,
    updated: 0,
    notListed: 0,
    complete: walk.complete,
    free: 0,
    paid: 0,
    withMedia: 0,
    articles: 0,
  };

  // A dry run reports what WOULD be written and writes nothing --
  // not the posts, not the articles, not the audit row. A dry run that
  // half-writes is worse than no dry run, because the catalog then holds
  // rows the run never claimed to have written.
  const db = openCatalog(options.dryRun);
  try {
    // The Asym tables may not exist yet -- a fresh clone runs 'video:init'
    // first, but a dry run must not depend on that having happened. A
    // missing table means "nothing catalogued", not a failure.
    const existing = new Set(readCataloguedIds(db));

    for (const post of posts) {
      const videoId = asymVideoId(post.id);
      if (existing.has(videoId)) summary.updated += 1; else summary.inserted += 1;

      const access = asymAccess(post);
      const media = asymMedia(post);
      if (media.hasMedia) summary.withMedia += 1;

      if (options.dryRun) {
        // Still parse the body, so a dry run reports what a real run would
        // find. Parsing writes nothing.
        if (access.readable) {
          summary.free += 1;
          parseAsymArticle(post);
          summary.articles += 1;
        } else {
          summary.paid += 1;
        }
        continue;
      }

      const row = upsertPost(db, post);
      if (access.readable) {
        summary.free += 1;
        const parsed = upsertArticle(db, post, row);
        summary.articles += 1;
        if (parsed.spreadsheetUrl) {
          db.prepare('UPDATE asym_posts SET spreadsheet_url = ? WHERE video_id = ?')
            .run(parsed.spreadsheetUrl, videoId);
        }
        if (parsed.tc2000Url) {
          db.prepare('UPDATE asym_posts SET tc2000_url = ? WHERE video_id = ?')
            .run(parsed.tc2000Url, videoId);
        }
        db.prepare("UPDATE asym_posts SET body_fetched_at = datetime('now') WHERE video_id = ?")
          .run(videoId);
      } else {
        summary.paid += 1;
      }
    }

    // How many catalogued posts this run did NOT see. A post that used to
    // be in the catalog and is not in the listing may have been deleted,
    // made private, or turned into a different kind of post -- so this is
    // an OBSERVATION, not proof of deletion.
    const seen = new Set(posts.map((post) => asymVideoId(post.id)));
    summary.notListed = [...existing].filter((videoId) => !seen.has(videoId)).length;

    if (!options.dryRun) {
      summary.runId = recordRun(db, summary);
    }
    db.close();
  } catch (error) {
    db.close();
    throw error;
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`[asym-catalog] posts=${summary.rowCount} free=${summary.free} paid=${summary.paid}`
    + ` withMedia=${summary.withMedia} articles=${summary.articles}`
    + ` inserted=${summary.inserted} updated=${summary.updated}`
    + ` notListed=${summary.notListed} complete=${summary.complete}`);
  if (options.dryRun) console.log('[asym-catalog] dry run: nothing was written.');
}

main().catch((error) => {
  console.error(`[asym-catalog] ${error.message}`);
  process.exit(1);
});