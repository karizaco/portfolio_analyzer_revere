'use strict';

// The AsymTrading media layer: the embedded-video ids, the OCR cache, and
// the local-media reconcile.
//
// These tests run OFFLINE. The video-id tests read the captured fixtures
// under test/fixtures/asym/; the cache tests use a temp file and an
// in-memory database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const { asymMedia } = require('../src/asym/contentFilter');
const {
  cachedFrameOcr,
  ensureFrameOcrTable,
  frameOcrStats,
  storeFrameOcr,
} = require('../src/asym/frameOcrCache');
const { ensureAsymPostsMediaColumn } = require('../src/asym/mediaStore');

const ROOT = path.resolve(__dirname, '..');
const FREE_DIR = path.join(ROOT, 'test', 'fixtures', 'asym', 'free');

function freePosts() {
  return fs.readdirSync(FREE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(FREE_DIR, name), 'utf8')));
}

// ---------------------------------------------------------------------------
// The embedded-video ids
// ---------------------------------------------------------------------------

test('a post with no embed has no video id', () => {
  const media = asymMedia({ body_html: '<p>Words only.</p>' });
  assert.equal(media.hasMedia, false);
  assert.equal(media.mediaUploadId, '');
  assert.deepEqual(media.mediaUploadIds, []);
});

test('a post with no body_html has no video id', () => {
  assert.equal(asymMedia({}).hasMedia, false);
  assert.equal(asymMedia(null).hasMedia, false);
  assert.equal(asymMedia({ body_html: 42 }).hasMedia, false);
});

test('one video embed yields one id', () => {
  const body = '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;abc-123&quot;}"></div>';
  const media = asymMedia({ body_html: body });
  assert.equal(media.hasMedia, true);
  assert.equal(media.mediaUploadId, 'abc-123');
  assert.deepEqual(media.mediaUploadIds, ['abc-123']);
});

test('every video embed is collected, and the FIRST is still the primary one', () => {
  const body = [
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;first&quot;}"></div>',
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;second&quot;}"></div>',
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;third&quot;}"></div>',
  ].join('');
  const media = asymMedia({ body_html: body });
  assert.equal(media.hasMedia, true);
  assert.equal(media.mediaUploadId, 'first', 'the primary id does not move');
  assert.deepEqual(media.mediaUploadIds, ['first', 'second', 'third']);
});

test('an image or tweet embed is NOT a video', () => {
  const body = [
    '<div data-attrs="{&quot;src&quot;:&quot;https://bucket.s3.amazonaws.com/a.png&quot;}"></div>',
    '<div data-attrs="{&quot;symbol&quot;:&quot;$AI&quot;}"></div>',
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;real&quot;}"></div>',
  ].join('');
  const media = asymMedia({ body_html: body });
  assert.deepEqual(media.mediaUploadIds, ['real']);
});

test('a single-quoted embed is read too', () => {
  const body = "<div data-attrs='{&quot;mediaUploadId&quot;:&quot;sq-1&quot;}'></div>";
  assert.deepEqual(asymMedia({ body_html: body }).mediaUploadIds, ['sq-1']);
});

test('a data-attrs block that is not JSON is skipped, not fatal', () => {
  const body = [
    '<div data-attrs="not json at all"></div>',
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;good&quot;}"></div>',
  ].join('');
  assert.deepEqual(asymMedia({ body_html: body }).mediaUploadIds, ['good']);
});

test('the same id twice is collected once', () => {
  const body = [
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;dup&quot;}"></div>',
    '<div data-attrs="{&quot;mediaUploadId&quot;:&quot;dup&quot;}"></div>',
  ].join('');
  assert.deepEqual(asymMedia({ body_html: body }).mediaUploadIds, ['dup']);
});

test('over the captured corpus, the primary id is the first of the list', () => {
  const posts = freePosts();
  assert.ok(posts.length >= 42, 'the corpus is captured');
  let withMedia = 0;
  for (const post of posts) {
    const media = asymMedia(post);
    if (!media.hasMedia) {
      assert.deepEqual(media.mediaUploadIds, [], 'a post without media has no ids');
      continue;
    }
    withMedia += 1;
    assert.ok(media.mediaUploadIds.length >= 1);
    assert.equal(media.mediaUploadId, media.mediaUploadIds[0]);
    for (const id of media.mediaUploadIds) {
      assert.equal(typeof id, 'string');
      assert.ok(id.length > 0, 'no empty id');
    }
  }
  assert.equal(withMedia, 24, '24 of the free posts carry a video');
});

// ---------------------------------------------------------------------------
// The OCR cache
// ---------------------------------------------------------------------------

function tempFrame() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asym-frame-'));
  const file = path.join(dir, 'frame.png');
  fs.writeFileSync(file, Buffer.from('not really a png'));
  return { dir, file };
}

test('a reading is remembered and read back', () => {
  const db = new DatabaseSync(':memory:');
  ensureFrameOcrTable(db);
  const { dir, file } = tempFrame();
  const rows = [{ sector: 'Information Technology', roc_1mo: 4.2, pct_change: 1.5 }];
  storeFrameOcr(db, file, 'v1', { rows, confidence: 88 });

  const cached = cachedFrameOcr(db, file, 'v1');
  assert.ok(cached, 'the reading is cached');
  assert.equal(cached.confidence, 88);
  assert.equal(cached.rows.length, 1);
  assert.equal(cached.rows[0].sector, 'Information Technology');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a frame that is not cached reads as null', () => {
  const db = new DatabaseSync(':memory:');
  ensureFrameOcrTable(db);
  assert.equal(cachedFrameOcr(db, 'no/such/frame.png', 'v1'), null);
  db.close();
});

test('a DIFFERENT parser version does not read the old reading', () => {
  const db = new DatabaseSync(':memory:');
  ensureFrameOcrTable(db);
  const { dir, file } = tempFrame();
  storeFrameOcr(db, file, 'v1', { rows: [{ sector: 'Health Care' }], confidence: 50 });
  assert.equal(cachedFrameOcr(db, file, 'v2'), null, 'a parser change invalidates the cache');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a CHANGED frame does not read the old reading', () => {
  const db = new DatabaseSync(':memory:');
  ensureFrameOcrTable(db);
  const { dir, file } = tempFrame();
  storeFrameOcr(db, file, 'v1', { rows: [{ sector: 'Health Care' }], confidence: 50 });

  // The file is written again, so it is a different file.
  fs.writeFileSync(file, Buffer.from('a different frame, longer'));
  assert.equal(cachedFrameOcr(db, file, 'v1'), null, 'a re-grabbed frame is read again');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cache reports how many entries are still valid', () => {
  const db = new DatabaseSync(':memory:');
  ensureFrameOcrTable(db);
  const { dir, file } = tempFrame();
  storeFrameOcr(db, file, 'v1', { rows: [], confidence: 0 });
  const stats = frameOcrStats(db, 'v1');
  assert.equal(stats.cached, 1);
  assert.equal(stats.valid, 1);
  assert.equal(stats.stale, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The posts column
// ---------------------------------------------------------------------------

test('the media-id column is added once and only once', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asym_posts (video_id TEXT PRIMARY KEY)');
  ensureAsymPostsMediaColumn(db);
  ensureAsymPostsMediaColumn(db);
  const columns = db.prepare('PRAGMA table_info(asym_posts)').all();
  const column = columns.find((c) => c.name === 'media_upload_ids');
  assert.ok(column, 'the column exists');
  assert.equal(column.notnull, 1);
  db.close();
});

test('the media-id column is added to a table that has no such column', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asym_posts (video_id TEXT PRIMARY KEY, media_upload_id TEXT)');
  db.prepare('INSERT INTO asym_posts (video_id, media_upload_id) VALUES (?, ?)').run('asym_1', 'abc');
  ensureAsymPostsMediaColumn(db);
  const row = db.prepare('SELECT media_upload_ids FROM asym_posts WHERE video_id = ?').get('asym_1');
  assert.equal(row.media_upload_ids, '', 'the default is empty, not null');
  db.close();
});

// ---------------------------------------------------------------------------
// The media table's key
// ---------------------------------------------------------------------------

test('the media table and the schema file agree on the DDL', () => {
  // The DDL is duplicated in data/db/schema.sql, and a migration that
  // rebuilds the table from a DIFFERENT shape than the schema file would
  // silently change the column order.
  const schema = fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8');
  const ddl = require('../src/asym/mediaStore').ASYM_MEDIA_DDL;
  const columns = (ddl.match(/^\s{4}(\w+)\s/gm) || []).map((line) => line.trim());
  for (const column of columns) {
    assert.ok(
      new RegExp('CREATE TABLE IF NOT EXISTS asym_media[\\s\\S]*?\\b' + column + '\\b').test(schema),
      'the schema file is missing the column ' + column
    );
  }
  assert.ok(/PRIMARY KEY \(video_id, kind\)/.test(ddl), 'the key is (video_id, kind)');
  assert.ok(/PRIMARY KEY \(video_id, kind\)/.test(schema), 'and so is the schema file');
});

test('a table with the OLD key is rebuilt with the new one', () => {
  // SQLite cannot change a primary key in place, so the migration has to
  // copy the table. The rows must survive the copy.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asym_posts (video_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO asym_posts (video_id) VALUES (?)').run('asym_1');
  db.exec(`
    CREATE TABLE asym_media (
      video_id TEXT PRIMARY KEY REFERENCES asym_posts(video_id),
      media_upload_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'video',
      file_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // The OLD key was video_id alone, so a post held exactly ONE row --
  // recording the audio erased the video row. The rebuild keeps what is
  // there.
  db.prepare(`
    INSERT INTO asym_media (video_id, media_upload_id, kind, file_path, status)
    VALUES ('asym_1', 'mid-1', 'video', 'a.mp4', 'downloaded')
  `).run();

  const { ensureAsymMediaSchema } = require('../src/asym/mediaStore');
  ensureAsymMediaSchema(db);

  const columns = db.prepare('PRAGMA table_info(asym_media)').all();
  const kind = columns.find((column) => column.name === 'kind');
  assert.ok(kind, 'the kind column is there');
  assert.ok(Number(kind.pk) > 0, 'and the key is composite');
  const rows = db.prepare('SELECT kind, file_path FROM asym_media').all();
  assert.equal(rows.length, 1, 'the row survives the rebuild');
  assert.equal(rows[0].kind, 'video');
  assert.equal(rows[0].file_path, 'a.mp4');

  // The NEW key lets the same post hold a second row.
  db.prepare(`
    INSERT INTO asym_media (video_id, media_upload_id, kind, file_path, status)
    VALUES ('asym_1', 'mid-1', 'audio', 'a.mp3', 'downloaded')
  `).run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM asym_media').get().c, 2);
  db.close();
});

test('a table with the NEW key is left alone', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asym_posts (video_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO asym_posts (video_id) VALUES (?)').run('asym_1');
  const { ensureAsymMediaSchema, ASYM_MEDIA_DDL } = require('../src/asym/mediaStore');
  db.exec(ASYM_MEDIA_DDL);
  db.prepare(`
    INSERT INTO asym_media (video_id, media_upload_id, kind, file_path, status)
    VALUES ('asym_1', 'mid-1', 'audio', 'a.mp3', 'downloaded')
  `).run();
  ensureAsymMediaSchema(db);
  const rows = db.prepare('SELECT kind FROM asym_media').all();
  assert.equal(rows.length, 1, 'the row is not duplicated by the rebuild');
  db.close();
});

test('a table with NO kind column at all is rebuilt as video rows', () => {
  // A catalog written by an older schema has no `kind` column, so the
  // migration cannot name it in the copy.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE asym_posts (video_id TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO asym_posts (video_id) VALUES (?)').run('asym_1');
  db.exec(`
    CREATE TABLE asym_media (
      video_id TEXT PRIMARY KEY REFERENCES asym_posts(video_id),
      media_upload_id TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare(`
    INSERT INTO asym_media (video_id, media_upload_id, file_path, status)
    VALUES ('asym_1', 'mid-1', 'a.mp4', 'downloaded')
  `).run();

  const { ensureAsymMediaSchema } = require('../src/asym/mediaStore');
  ensureAsymMediaSchema(db);

  const rows = db.prepare('SELECT kind, file_path FROM asym_media').all();
  assert.equal(rows.length, 1, 'the row survives');
  assert.equal(rows[0].kind, 'video', 'and it becomes a video row');
  assert.equal(rows[0].file_path, 'a.mp4');
  db.close();
});
