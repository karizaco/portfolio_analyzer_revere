'use strict';

// The AsymTrading MEDIA, SIGNAL and AGGREGATION path.
//
// These tests run OFFLINE. They use a scratch SQLite built from the real
// `data/db/schema.sql`, so the schema the tests exercise is the schema the
// pipeline uses.
//
// THE TEST THAT MATTERS MOST
//
// `the other sources' aggregators are not contaminated by AsymTrading`.
//
// Every other aggregator in this project filters its signals with
// `WHERE v.channel = '...'` over a LEFT JOIN on `videos`. An AsymTrading
// signal has NO `videos` row -- the project keeps the Substack catalog
// and the YouTube catalog apart on purpose -- so `v.channel` is NULL and
// the row has to be excluded. If that were ever wrong, every Sevcik and
// T3Live number in the project would be quietly wrong.
//
// So the test runs the REAL query -- the SQL text is read out of the
// aggregator's own source, so the test cannot pass against a stale copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  ASYM_MEDIA_DIR,
  ASYM_MEDIA_STATUS,
  asymMediaFileName,
  checkResolution,
  ensureFreeSpace,
  mediaWorkList,
  portablePath,
} = require('../src/asym/mediaStore');
const { toAsymClaims } = require('../src/asym/claims');
const { loadSevcikLexicon } = require('../src/sevcik/lexicon');
const { extractSignals } = require('../src/sevcik/signalExtractor');
const { findEnglishCompanyNames, ENGLISH_SYMBOL_STOPLIST } = require('../src/t3live/englishNames');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/**
 * A scratch catalog with the real schema.
 *
 * @returns {{db: DatabaseSync, dir: string}}
 */
function scratchDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asym-pipeline-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return { db, dir };
}

/**
 * The SQL a tool prepares, read out of the tool's own source.
 *
 * The expression is a concatenation of string literals, which is checked
 * before it is evaluated: anything with a template literal or an
 * interpolation in it is refused rather than run.
 *
 * @param {string} toolName - the file under tools/
 * @param {string} marker - a substring the query must contain
 * @returns {string}
 */
function preparedSql(toolName, marker) {
  const source = fs.readFileSync(path.join(ROOT, 'tools', toolName), 'utf8');

  // The query is a concatenation of string literals passed to
  // db.prepare(). A regex cannot find its end, because the SQL itself
  // contains parentheses -- `COUNT(*)` would close the match early -- so
  // the argument is found by matching parentheses while skipping the
  // quoted regions.
  const markerAt = source.indexOf(marker);
  if (markerAt === -1) {
    throw new Error(`No query containing "${marker}" in ${toolName}`);
  }
  const prepareAt = source.lastIndexOf('db.prepare(', markerAt);
  if (prepareAt === -1) {
    throw new Error(`The query containing "${marker}" in ${toolName} is not a db.prepare()`);
  }

  const open = source.indexOf('(', prepareAt);
  let depth = 0;
  let quote = null;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) {
    throw new Error(`Could not find the end of the db.prepare() argument in ${toolName}`);
  }

  // The slice ends with the argument's trailing comma, which is not a
  // valid expression on its own.
  const expression = source.slice(open + 1, close).replace(/,\s*$/, '');
  // A template literal is fine -- it is a string. What is NOT fine is an
  // interpolation, because that would evaluate something.
  assert.ok(!expression.includes('${'), `${toolName}: the query must not interpolate`);
  // eslint-disable-next-line no-eval
  return eval(expression);
}

/**
 * Insert a video, a transcript and a signal.
 *
 * @param {DatabaseSync} db
 * @param {object} row
 */
function insertSignal(db, row) {
  // An AsymTrading signal has NO row in `videos`. That is the whole
  // reason the isolation works, so the flag has to model it: a signal
  // with a `videos` row would be excluded by its CHANNEL, not by its
  // absence, which is a weaker thing to have proved.
  if (row.withVideoRow !== false) {
    db.prepare(`
      INSERT INTO videos (video_id, source_url, video_url, title, upload_date, status, created_at, updated_at, channel)
      VALUES (?, '', '', ?, ?, 'done', datetime('now'), datetime('now'), ?)
    `).run(row.video_id, row.title || '', row.upload_date || '', row.channel || '');
  }

  db.prepare(`
    INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, checksum, fetched_at)
    VALUES (?, ?, 'en', ?, 1, 'x', datetime('now'))
  `).run(row.video_id, row.provider || 'deepgram', `data/video_pipeline/transcripts/${row.video_id}.json`);

  const transcriptId = Number(
    db.prepare('SELECT id FROM video_transcripts WHERE video_id = ?').get(row.video_id).id,
  );

  db.prepare(`
    INSERT INTO trade_signals (video_id, transcript_id, segment_start_index, segment_end_index,
      event_time_sec, ticker, action, bias, confidence_label, confidence_score,
      rationale, evidence_text, parser_version)
    VALUES (?, ?, 0, 0, 0, ?, 'buy', ?, 'medium', 0.5, '', '', 'test-1')
  `).run(row.video_id, transcriptId, row.ticker || 'NVDA', row.bias || 'bullish');
}

test('an AsymTrading signal does not contaminate the other sources\' aggregators', () => {
  const { db, dir } = scratchDb();
  try {
    // A Sevcik video with a signal, and an AsymTrading signal with the
    // same ticker. If the Asym row leaked into the Sevcik aggregate, the
    // Sevcik ticker count would be 2 instead of 1.
    insertSignal(db, { video_id: 'sevcikvideo1', channel: 'davidsevcik', ticker: 'NVDA' });
    insertSignal(db, { video_id: 'asym_222466781', ticker: 'NVDA', withVideoRow: false });

    const sevcikSql = preparedSql('aggregateSevcikSignals.js', 'FROM trade_signals s');
    const t3liveSql = preparedSql('aggregateT3liveSignals.js', 'FROM trade_signals s');

    const sevcikRows = db.prepare(sevcikSql).all();
    const t3liveRows = db.prepare(t3liveSql).all();

    assert.equal(sevcikRows.length, 1, 'the Sevcik aggregator must see only its own row');
    assert.equal(sevcikRows[0].video_id, 'sevcikvideo1');
    assert.equal(t3liveRows.length, 0, 'the T3Live aggregator must not see an AsymTrading row');

    // And the reason, stated: the Asym row has no `videos` row, so the
    // channel filter cannot match it.
    const asymChannels = db.prepare(
      'SELECT v.channel FROM trade_signals s LEFT JOIN videos v ON v.video_id = s.video_id WHERE s.video_id = ?',
    ).all('asym_222466781');
    assert.equal(asymChannels[0].channel, null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the AsymTrading aggregate finds its own signals and articles', () => {
  const { db, dir } = scratchDb();
  try {
    db.prepare(`
      INSERT INTO asym_posts (video_id, post_id, slug, title, post_label, post_date, upload_date,
        audience, access, series, has_media, media_upload_id, word_count, created_at, updated_at)
      VALUES ('asym_222466781', '222466781', 'market-pulse-2d2', 'Market Pulse', '10/28/2026',
        '2026-10-28T12:00:00Z', '20261028', 'everyone', 'free', 'market_pulse', 1, 'mid-1', 1200,
        datetime('now'), datetime('now'))
    `).run();

    db.prepare(`
      INSERT INTO asym_articles (video_id, backdrop, trend, breadth, momentum, bottom_line, parser_version)
      VALUES ('asym_222466781', 'Positive', 'Uptrend', 'Positive', 'Positive', 'Keep buying dips.', 'asym-article-1')
    `).run();

    insertSignal(db, { video_id: 'asym_222466781', ticker: 'AAPL', withVideoRow: false });

    const signalsSql = preparedSql('aggregateAsymSignals.js', 'FROM trade_signals s');
    const signals = db.prepare(signalsSql).all();
    assert.equal(signals.length, 1);
    assert.equal(signals[0].ticker, 'AAPL');
    assert.equal(signals[0].upload_date, '20261028');
    assert.equal(signals[0].series, 'market_pulse');

    const articlesSql = preparedSql('aggregateAsymSignals.js', 'FROM asym_articles a');
    const articles = db.prepare(articlesSql).all();
    assert.equal(articles.length, 1);
    assert.equal(articles[0].backdrop, 'Positive');
    assert.equal(articles[0].bottom_line, 'Keep buying dips.');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the English extractor finds a CAPS ticker in an AsymTrading transcript', () => {
  const lexicon = loadSevcikLexicon();
  const segments = [{
    start_sec: 0,
    end_sec: 12,
    text: 'NVDA is setting up nicely here, I think the first target is around 180 and I am bullish on it.',
    confidence: 0.9,
  }];

  const signals = extractSignals({
    segments,
    lexicon,
    confirmedSymbols: null,
    requireCapsSymbols: true,
    symbolStoplist: ENGLISH_SYMBOL_STOPLIST,
    nameFinderFn: findEnglishCompanyNames,
    videoId: 'asym_222466781',
    transcriptId: 1,
  });

  assert.ok(signals.length > 0, 'a CAPS ticker with a bullish word must produce a signal');
  const signal = signals.find((row) => row.ticker === 'NVDA');
  assert.ok(signal, `NVDA must be found, got ${JSON.stringify(signals.map((s) => s.ticker))}`);
  assert.equal(signal.bias, 'bullish');
  assert.equal(signal.video_id, 'asym_222466781');
});

test('a transcript with no ticker produces no signal', () => {
  const lexicon = loadSevcikLexicon();
  const segments = [{
    start_sec: 0,
    end_sec: 9,
    text: 'We had quite a slippery week last week and the market melted down off the highs.',
    confidence: 0.9,
  }];

  const signals = extractSignals({
    segments,
    lexicon,
    confirmedSymbols: null,
    requireCapsSymbols: true,
    symbolStoplist: ENGLISH_SYMBOL_STOPLIST,
    nameFinderFn: findEnglishCompanyNames,
    videoId: 'asym_222466781',
    transcriptId: 1,
  });

  assert.equal(signals.length, 0, 'a market mood with no ticker is not a call');
});

test('the media file name carries the post date and the post id', () => {
  assert.equal(
    asymMediaFileName({ upload_date: '20261028', post_id: '222466781' }),
    '20261028_asym_222466781.mp4',
  );
  // A post with no date still gets a name -- an undated file, not a crash.
  assert.equal(
    asymMediaFileName({ upload_date: '', post_id: '222466781' }),
    'undated_asym_222466781.mp4',
  );
});

test('the resolution gate rejects a video under 720p', () => {
  assert.equal(checkResolution({ width: 1920, height: 1080 }).ok, true);
  assert.equal(checkResolution({ width: 1280, height: 720 }).ok, true);
  assert.equal(checkResolution({ width: 854, height: 480 }).ok, false);
  assert.equal(checkResolution({ width: 1920, height: 600 }).ok, false);
  assert.equal(checkResolution(null).ok, false);
  assert.equal(checkResolution({ width: 0, height: 0 }).ok, false);
});

test('the free-space check refuses a download that does not fit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asym-space-'));
  try {
    // A number no disk will have.
    const result = ensureFreeSpace(dir, 10 * 1024 * 1024 * 1024 * 1024);
    assert.equal(result.ok, false);
    assert.match(result.reason, /insufficient_space/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the media work list tolerates a catalog without the media table', () => {
  const { db, dir } = scratchDb();
  try {
    db.exec('DROP TABLE asym_media');
    db.prepare(`
      INSERT INTO asym_posts (video_id, post_id, upload_date, access, series, has_media, media_upload_id)
      VALUES ('asym_1', '1', '20260101', 'free', 'market_pulse', 1, 'mid-1')
    `).run();

    const rows = mediaWorkList(db);
    assert.equal(rows.length, 1, 'the post must still be found');
    assert.equal(rows[0].media_status, '', 'and it must read as not yet downloaded');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the media work list skips what is already downloaded', () => {
  const { db, dir } = scratchDb();
  try {
    db.prepare(`
      INSERT INTO asym_posts (video_id, post_id, upload_date, access, series, has_media, media_upload_id)
      VALUES ('asym_1', '1', '20260101', 'free', 'market_pulse', 1, 'mid-1')
    `).run();
    db.prepare(`
      INSERT INTO asym_media (video_id, media_upload_id, status, file_path)
      VALUES ('asym_1', 'mid-1', ?, 'data/video_pipeline/downloads_asym/20260101_asym_1.mp4')
    `).run(ASYM_MEDIA_STATUS.DOWNLOADED);

    assert.equal(mediaWorkList(db).length, 0);
    assert.equal(mediaWorkList(db, { includeDone: true }).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('one post and one ticker is one claim, and a conflict is not scored', () => {
  const signals = [
    { video_id: 'asym_1', ticker: 'NVDA', bias: 'bullish', confidence_score: 0.8 },
    { video_id: 'asym_1', ticker: 'NVDA', bias: 'bullish', confidence_score: 0.4 },
    { video_id: 'asym_1', ticker: 'AAPL', bias: 'bullish', confidence_score: 0.5 },
    { video_id: 'asym_1', ticker: 'TSLA', bias: 'bullish', confidence_score: 0.5 },
    { video_id: 'asym_1', ticker: 'TSLA', bias: 'bearish', confidence_score: 0.6 },
    { video_id: 'asym_2', ticker: 'NVDA', bias: 'bearish', confidence_score: 0.5 },
  ];

  const { claims, conflicting } = toAsymClaims(signals);

  // NVDA in asym_1 is two mentions of one call -> one claim, two mentions.
  const nvda = claims.find((claim) => claim.video_id === 'asym_1' && claim.ticker === 'NVDA');
  assert.ok(nvda);
  assert.equal(nvda.mentions, 2);
  assert.equal(nvda.confidence_score, 0.8, 'the strongest mention carries the confidence');

  // The same ticker in another post is a different claim.
  assert.ok(claims.find((claim) => claim.video_id === 'asym_2' && claim.ticker === 'NVDA'));

  // TSLA is bullish and bearish in one post -> not scored.
  assert.equal(claims.find((claim) => claim.ticker === 'TSLA'), undefined);
  assert.equal(conflicting.length, 1);
  assert.equal(conflicting[0].ticker, 'TSLA');
});

test('the media directory is inside the repository and is not the YouTube one', () => {
  assert.ok(ASYM_MEDIA_DIR.startsWith(ROOT), 'the media directory must be inside the repository');
  assert.ok(!ASYM_MEDIA_DIR.includes('downloads_1080p'));
  assert.ok(!ASYM_MEDIA_DIR.includes('downloads_hires'));
  assert.ok(
    portablePath(ASYM_MEDIA_DIR).startsWith('data/video_pipeline/'),
    `the media path must be repository-relative, got ${portablePath(ASYM_MEDIA_DIR)}`,
  );
});