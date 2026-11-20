'use strict';

/**
 * The untracked X post index: data/x_pipeline/x_index.sqlite.
 *
 * Fast to query, never the record. Every row is rebuildable from the tracked
 * archive (src/x/archive.js) and the media folder -- `rebuildIndex()` drops
 * the post tables and reloads them, keeping the media download state and
 * the OCR cache (those are expensive to redo and keyed by content).
 */

const fs = require('node:fs');
const path = require('node:path');

const { iterateArchive } = require('./archive');
const { eventSession } = require('./marketTime');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_INDEX_PATH = path.join(ROOT, 'data', 'x_pipeline', 'x_index.sqlite');
const INDEX_SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema_x_index.sql');

/**
 * Open (and create) the index.
 *
 * @param {object} [options]
 * @param {string} [options.path]
 * @returns {import('node:sqlite').DatabaseSync}
 */
function openIndex(options = {}) {
  // eslint-disable-next-line global-require
  const { DatabaseSync } = require('node:sqlite');
  const file = options.path || DEFAULT_INDEX_PATH;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(fs.readFileSync(INDEX_SCHEMA_PATH, 'utf8'));
  migrateIndex(db);
  return db;
}

/**
 * Bring an index that was written by an older schema up to date.
 *
 * `CREATE TABLE IF NOT EXISTS` does NOT add a column to a table that
 * already exists, so a column added to the schema file is missing from
 * an index that was created before it. The column is added here, guarded
 * by the table's own definition -- the same rule the Python worker's
 * migrations follow.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function migrateIndex(db) {
  const columns = db.prepare('PRAGMA table_info(x_posts)').all().map((row) => String(row.name));
  if (!columns.includes('deleted_detected_at')) {
    db.exec("ALTER TABLE x_posts ADD COLUMN deleted_detected_at TEXT NOT NULL DEFAULT ''");
  }
}

/**
 * Upsert one canonical record and its media.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} record
 * @param {object} [options]
 * @param {string} [options.archivePath]
 * @param {string} [options.seenAt]
 */
function upsertPost(db, record, options = {}) {
  const seenAt = options.seenAt || new Date().toISOString();
  db.prepare(`INSERT INTO x_posts (post_id, user_id, handle, created_at, event_session, kind, text, text_source,
      lang, conversation_id, in_reply_to_post_id, in_reply_to_user_id, self_thread, quoted_post_id,
      reposted_post_id, cashtags_json, urls_json, referenced_json, media_count, edit_earliest_id,
      is_earliest_version, fetched_via, fidelity, first_seen_at, last_seen_at, archive_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET user_id = excluded.user_id, handle = excluded.handle,
      created_at = excluded.created_at, event_session = excluded.event_session, kind = excluded.kind,
      text = excluded.text, text_source = excluded.text_source, lang = excluded.lang,
      conversation_id = excluded.conversation_id, in_reply_to_post_id = excluded.in_reply_to_post_id,
      in_reply_to_user_id = excluded.in_reply_to_user_id, self_thread = excluded.self_thread,
      quoted_post_id = excluded.quoted_post_id, reposted_post_id = excluded.reposted_post_id,
      cashtags_json = excluded.cashtags_json, urls_json = excluded.urls_json,
      referenced_json = excluded.referenced_json, media_count = excluded.media_count,
      edit_earliest_id = excluded.edit_earliest_id, is_earliest_version = excluded.is_earliest_version,
      fetched_via = excluded.fetched_via, fidelity = excluded.fidelity,
      first_seen_at = MIN(x_posts.first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(x_posts.last_seen_at, excluded.last_seen_at),
      archive_path = excluded.archive_path`).run(
    record.post_id,
    record.user_id,
    record.handle,
    record.created_at,
    eventSession(record.created_at),
    record.kind,
    record.text,
    record.text_source,
    record.lang || '',
    record.conversation_id || '',
    record.in_reply_to_post_id || '',
    record.in_reply_to_user_id || '',
    record.self_thread ? 1 : 0,
    record.quoted_post_id || '',
    record.reposted_post_id || '',
    JSON.stringify(record.entities.cashtags || []),
    JSON.stringify(record.entities.urls || []),
    JSON.stringify(record.referenced || []),
    (record.media || []).length,
    (record.edit && record.edit.history_ids && record.edit.history_ids[0]) || record.post_id,
    record.edit && record.edit.is_earliest === false ? 0 : 1,
    record.fetched_via,
    record.fidelity,
    record.first_seen_at || seenAt,
    seenAt,
    options.archivePath || '',
  );

  const insertMedia = db.prepare(`INSERT INTO x_post_media (media_key, post_id, idx, type, url, preview_url, width,
      height, alt_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id, media_key) DO UPDATE SET idx = excluded.idx, type = excluded.type,
      url = excluded.url, preview_url = excluded.preview_url, width = excluded.width,
      height = excluded.height, alt_text = excluded.alt_text`);
  // A page-scraped placeholder key is replaced once a real key is known.
  if ((record.media || []).length && !(record.media || []).some((m) => String(m.media_key).startsWith('dom_'))) {
    db.prepare("DELETE FROM x_post_media WHERE post_id = ? AND media_key LIKE 'dom\\_%' ESCAPE '\\'").run(record.post_id);
  }
  (record.media || []).forEach((item, idx) => {
    insertMedia.run(item.media_key, record.post_id, idx, item.type, item.url || '', item.preview_url || '',
      item.width, item.height, item.alt_text || '');
  });
}

/**
 * Record that X no longer has a post.
 *
 * A deleted post never reaches the archive -- it is an entry in the
 * API's errors[], not a missing row -- so without this the fact that it
 * was deleted is lost. A post we DID archive and that X later withdrew is
 * marked on its own row too.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} postId
 * @param {object} [options]
 * @param {string} [options.detectedAt]
 * @param {number|null} [options.runId]
 * @param {string} [options.source]
 * @param {string} [options.detail]
 */
function markDeleted(db, postId, options = {}) {
  const id = String(postId || '');
  if (!id) return;
  const detectedAt = options.detectedAt || new Date().toISOString();
  db.prepare(`INSERT INTO x_post_deletions (post_id, detected_at, run_id, source, detail)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(post_id) DO UPDATE SET detected_at = excluded.detected_at,
      run_id = excluded.run_id, source = excluded.source, detail = excluded.detail`).run(
    id, detectedAt, options.runId ?? null, options.source || '', options.detail || '',
  );
  db.prepare('UPDATE x_posts SET deleted_detected_at = ? WHERE post_id = ? AND deleted_detected_at = ?')
    .run(detectedAt, id, '');
}

/**
 * Record one observation of a post's engagement.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} postId
 * @param {object|null} metrics - {likes, reposts, replies, quotes, views, bookmarks, observed_at}
 * @param {string} via
 */
function addMetrics(db, postId, metrics, via) {
  if (!metrics || !metrics.observed_at) return;
  db.prepare(`INSERT OR IGNORE INTO x_post_metrics (post_id, observed_at, likes, reposts, replies, quotes, views,
      bookmarks, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    postId, metrics.observed_at, metrics.likes ?? null, metrics.reposts ?? null, metrics.replies ?? null,
    metrics.quotes ?? null, metrics.views ?? null, metrics.bookmarks ?? null, via || '',
  );
}

/**
 * Rebuild the post tables from the archive.
 *
 * Media download state and the OCR cache survive: they are keyed by content
 * and expensive to redo.
 *
 * @param {object} [options]
 * @param {string} [options.archiveRoot]
 * @param {string} [options.indexPath]
 * @returns {{posts: number}}
 */
function rebuildIndex(options = {}) {
  const db = openIndex({ path: options.indexPath });
  let posts = 0;
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM x_posts');
    for (const { record, archive_path: archivePath } of iterateArchive({ archiveRoot: options.archiveRoot })) {
      upsertPost(db, record, { archivePath, seenAt: record.first_seen_at || record.created_at });
      if (record.metrics_first_seen) addMetrics(db, record.post_id, record.metrics_first_seen, record.fetched_via);
      posts += 1;
    }
    // Media rows whose post is gone from the archive are orphans.
    db.exec('DELETE FROM x_post_media WHERE post_id NOT IN (SELECT post_id FROM x_posts)');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  } finally {
    db.close();
  }
  return { posts };
}

module.exports = {
  DEFAULT_INDEX_PATH,
  INDEX_SCHEMA_PATH,
  addMetrics,
  markDeleted,
  migrateIndex,
  openIndex,
  rebuildIndex,
  upsertPost,
};
