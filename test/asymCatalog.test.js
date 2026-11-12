'use strict';

// The AsymTrading catalog tool: what it writes, and what it does not.
//
// The tool is run against a SCRATCH COPY of the catalog, against a FAKE
// API, so the test exercises the real write path -- the SQL, the upsert,
// the article parse and the audit row -- without a network and without
// touching the shipped catalog.
//
// The fake serves the CAPTURED posts, so the rows the tool writes are the
// rows the real publication produces. That is what makes this a test of
// the tool rather than a test of the fixtures.
//
// WHY THE FAKE RUNS IN ITS OWN PROCESS
//
// The test drives the tool with `spawnSync`, which BLOCKS the test
// process's event loop until the tool exits. A fake HTTP server in the
// same process could therefore never answer the tool's request -- the
// tool would wait for a reply from a server that cannot run until the
// tool is gone. The fake is a separate process for that reason, and the
// reason is worth knowing before anyone "simplifies" this back.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'catalogAsymSubstack.js');
const CHANNEL_MODULE = path.join(ROOT, 'src', 'asym', 'channel.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'asym');
const FREE_DIR = path.join(FIXTURES, 'free');

/** Every captured post, free and paid. */
function capturedPosts() {
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus_index.json'), 'utf8'));
  const posts = [];
  for (const row of index) {
    const freePath = path.join(FREE_DIR, `${row.slug}.json`);
    if (fs.existsSync(freePath)) {
      posts.push(JSON.parse(fs.readFileSync(freePath, 'utf8')));
      continue;
    }
    // The paid posts are not all captured; one representative is, and it
    // stands in for the rest.
    if (row.slug === 'market-pulse-6e8') {
      posts.push(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'post_224076892_paid.json'), 'utf8')));
    }
  }
  return posts;
}

/**
 * The fake API, as its own process.
 *
 * It answers the posts endpoint with the captured corpus, paging by the
 * cursor the tool sends. It prints its port on stdout and then serves
 * until it is killed.
 *
 * @param {string} dir - a scratch directory
 * @returns {Promise<{port: number, stop: Function}>}
 */
function startFakeApi(dir) {
  const serverPath = path.join(dir, 'fake_api.js');
  fs.writeFileSync(serverPath, [
    "'use strict';",
    "const http = require('node:http');",
    "const fs = require('node:fs');",
    `const POSTS = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'posts.json'))}, 'utf8'));`,
    "const server = http.createServer((req, res) => {",
    "  const url = new URL(req.url, 'http://localhost');",
    "  if (url.pathname !== '/api/v1/posts') { res.writeHead(404).end('{}'); return; }",
    "  const cursor = url.searchParams.get('cursor');",
    "  let offset = 0;",
    "  if (cursor) {",
    "    const m = /\"(\\d+)\"/.exec(Buffer.from(cursor, 'base64').toString('utf8'));",
    "    offset = m ? Number(m[1]) : 0;",
    "  }",
    "  const size = 10;",
    "  const page = POSTS.slice(offset, offset + size);",
    "  const next = offset + size;",
    "  const payload = { posts: page, nextCursor: next < POSTS.length ? Buffer.from(JSON.stringify({ post_date: String(next) })).toString('base64') : '' };",
    "  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));",
    "});",
    "server.listen(0, '127.0.0.1', () => { console.log(String(server.address().port)); });",
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(dir, 'posts.json'), JSON.stringify(capturedPosts()), 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the fake API did not start'));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      const port = Number(out.trim().split('\n')[0]);
      resolve({
        port,
        stop: () => { try { child.kill(); } catch { /* already gone */ } },
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Run the catalog tool against a scratch catalog and a fake API.
 *
 * @returns {Promise<{summary: object, db: string, dir: string}>}
 */
async function runCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asym-catalog-'));
  const dbPath = path.join(dir, 'state.sqlite');

  // A FRESH catalog, not a copy of the shipped one. The shipped catalog
  // already holds every AsymTrading post -- the tool was run against it --
  // so a copy would carry rows the run under test did not write, and the
  // assertions about what the run wrote would be measuring the copy.
  const { DatabaseSync } = require('node:sqlite');
  const fresh = new DatabaseSync(dbPath);
  fresh.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  fresh.close();

  const api = await startFakeApi(dir);

  // The tool reads the base URL from src/asym/channel.js, so it is
  // pointed at the fake for the run. The original is restored after.
  const original = fs.readFileSync(CHANNEL_MODULE, 'utf8');
  fs.writeFileSync(CHANNEL_MODULE, original.replace(
    /https:\/\/asymtrading\.substack\.com/g, `http://127.0.0.1:${api.port}`,
  ));

  // And it is pointed at the scratch catalog the same way.
  const toolPath = path.join(ROOT, 'tools', 'tmpAsymCatalogTest.js');
  fs.writeFileSync(toolPath, fs.readFileSync(TOOL, 'utf8').replace(
    /const DB_PATH = path\.join\(ROOT, 'data', 'video_pipeline', 'state\.sqlite'\);/,
    `const DB_PATH = ${JSON.stringify(dbPath)};`,
  ));

  let result;
  try {
    result = spawnSync(process.execPath, [toolPath, '--json', '--pause-ms', '0'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    });
  } finally {
    fs.writeFileSync(CHANNEL_MODULE, original);
    fs.rmSync(toolPath, { force: true });
    api.stop();
  }

  if (result.status !== 0) {
    throw new Error(`the tool failed: ${result.stderr}`);
  }
  let summary = null;
  try {
    summary = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`the tool's output was not JSON: ${result.stdout}\n${result.stderr}`);
  }
  return { summary, db: dbPath, dir };
}

/** Query the scratch catalog. */
function query(dbPath, sql) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

test('the catalog records every post, free and paid', async (t) => {
  const { summary, db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const posts = capturedPosts();
  const free = posts.filter((p) => p.audience !== 'only_paid');

  assert.equal(summary.rowCount, posts.length, 'every post was walked');
  assert.equal(summary.complete, true, 'the walk reached the end of the cursor chain');
  assert.equal(summary.free, free.length, 'every free post was read');
  assert.equal(summary.paid, posts.length - free.length, 'the paid posts were catalogued, not read');

  const rows = query(db, 'SELECT video_id, access, audience FROM asym_posts');
  assert.equal(rows.length, posts.length);
  assert.equal(rows.filter((r) => r.access === 'free').length, free.length);
  assert.equal(rows.filter((r) => r.access === 'paywalled').length, posts.length - free.length);

  // A paid post is in the catalog and is NOT in the articles table.
  const paidIds = rows.filter((r) => r.access !== 'free').map((r) => r.video_id);
  assert.ok(paidIds.length > 0, 'the corpus has a paid post to check');
  for (const videoId of paidIds) {
    const articles = query(db, `SELECT video_id FROM asym_articles WHERE video_id = '${videoId}'`);
    assert.equal(articles.length, 0, `${videoId} is paywalled and must have no article`);
  }
});

test('the article rows carry the parsed readings', async (t) => {
  const { summary, db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  assert.equal(summary.articles, capturedPosts().filter((p) => p.audience !== 'only_paid').length);

  const rows = query(db, 'SELECT video_id, backdrop, trend, breadth, momentum, parser_version FROM asym_articles');
  assert.ok(rows.length > 0);

  // The Market Pulse posts all four readings.
  const pulses = query(db, `
    SELECT a.video_id, a.backdrop, a.trend, a.breadth, a.momentum
    FROM asym_articles a JOIN asym_posts p ON p.video_id = a.video_id
    WHERE p.series = 'market_pulse'`);
  assert.ok(pulses.length > 0, 'the Market Pulse posts were parsed');
  for (const row of pulses) {
    assert.ok(row.backdrop, `${row.video_id} has no backdrop`);
    assert.ok(row.trend, `${row.video_id} has no trend`);
    assert.ok(row.breadth, `${row.video_id} has no breadth`);
    assert.ok(row.momentum, `${row.video_id} has no momentum`);
  }
  for (const row of rows) {
    assert.equal(row.parser_version, 'asym-article-1');
  }
});

test('the catalog id is the namespaced post id', async (t) => {
  const { db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const rows = query(db, 'SELECT video_id, post_id FROM asym_posts');
  for (const row of rows) {
    assert.equal(row.video_id, `asym_${row.post_id}`,
      'the catalog id and the post id disagree');
    assert.ok(/^\d+$/.test(row.post_id), 'the post id is not numeric');
  }
});

test('the date is the date the post is ABOUT', async (t) => {
  const { db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const rows = query(db, 'SELECT video_id, post_label, upload_date FROM asym_posts');
  let checked = 0;
  for (const row of rows) {
    if (!row.post_label) continue;
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(row.post_label);
    if (!match) continue;
    const [, month, day, year] = match;
    assert.equal(row.upload_date, `${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`,
      `${row.video_id}: the upload date is not the author's own date label`);
    checked += 1;
  }
  assert.ok(checked > 0, 'no post carried a date label to check');
});

test('the run is recorded in the catalog history', async (t) => {
  const { summary, db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const runs = query(db, "SELECT * FROM catalog_runs WHERE channel = 'asymtrading' ORDER BY run_id DESC");
  assert.equal(runs.length, 1, 'exactly one run was recorded');
  assert.equal(runs[0].kind, 'live', 'a real catalog run is a live run');
  assert.equal(runs[0].row_count, summary.rowCount);
  assert.equal(runs[0].row_count_kind, 'listing_rows');
  assert.equal(runs[0].listing_complete, 1, 'the walk reached the end, so the listing was complete');
});

test('running the catalog twice does not duplicate anything', async (t) => {
  const { db, dir } = await runCatalog();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const before = query(db, 'SELECT COUNT(*) n FROM asym_posts')[0].n;
  const beforeArticles = query(db, 'SELECT COUNT(*) n FROM asym_articles')[0].n;
  assert.ok(before > 0, 'the first run wrote nothing');

  // Run the tool again against the same scratch catalog.
  const api = await startFakeApi(dir);
  const original = fs.readFileSync(CHANNEL_MODULE, 'utf8');
  fs.writeFileSync(CHANNEL_MODULE, original.replace(
    /https:\/\/asymtrading\.substack\.com/g, `http://127.0.0.1:${api.port}`,
  ));
  const toolPath = path.join(ROOT, 'tools', 'tmpAsymCatalogTest2.js');
  fs.writeFileSync(toolPath, fs.readFileSync(TOOL, 'utf8').replace(
    /const DB_PATH = path\.join\(ROOT, 'data', 'video_pipeline', 'state\.sqlite'\);/,
    `const DB_PATH = ${JSON.stringify(db)};`,
  ));
  try {
    spawnSync(process.execPath, [toolPath, '--json', '--pause-ms', '0'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
  } finally {
    fs.writeFileSync(CHANNEL_MODULE, original);
    fs.rmSync(toolPath, { force: true });
    api.stop();
  }

  assert.equal(query(db, 'SELECT COUNT(*) n FROM asym_posts')[0].n, before,
    'the second run duplicated posts');
  assert.equal(query(db, 'SELECT COUNT(*) n FROM asym_articles')[0].n, beforeArticles,
    'the second run duplicated articles');
});

test('a dry run writes nothing', async (t) => {
  // A dry run that half-writes is worse than no dry run: the catalog then
  // holds rows the run never claimed to have written.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asym-dry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxBuffer: 10 }));

  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dir, 'state.sqlite');
  const fresh = new DatabaseSync(dbPath);
  fresh.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  fresh.close();

  const api = await startFakeApi(dir);
  const original = fs.readFileSync(CHANNEL_MODULE, 'utf8');
  fs.writeFileSync(CHANNEL_MODULE, original.replace(
    /https:\/\/asymtrading\.substack\.com/g, `http://127.0.0.1:${api.port}`,
  ));
  const toolPath = path.join(ROOT, 'tools', 'tmpAsymDryTest.js');
  fs.writeFileSync(toolPath, fs.readFileSync(TOOL, 'utf8').replace(
    /const DB_PATH = path\.join\(ROOT, 'data', 'video_pipeline', 'state\.sqlite'\);/,
    `const DB_PATH = ${JSON.stringify(dbPath)};`,
  ));
  let result;
  try {
    result = spawnSync(process.execPath, [toolPath, '--json', '--dry-run', '--pause-ms', '0'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
  } finally {
    fs.writeFileSync(CHANNEL_MODULE, original);
    fs.rmSync(toolPath, { force: true });
    api.stop();
  }

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim());
  assert.ok(summary.rowCount > 0, 'the dry run still walked the corpus');
  assert.equal(summary.articles, capturedPosts().filter((p) => p.audience !== 'only_paid').length,
    'the dry run still parsed the free posts');

  assert.equal(query(dbPath, 'SELECT COUNT(*) n FROM asym_posts')[0].n, 0,
    'a dry run wrote posts');
  assert.equal(query(dbPath, 'SELECT COUNT(*) n FROM asym_articles')[0].n, 0,
    'a dry run wrote articles');
  assert.equal(query(dbPath, "SELECT COUNT(*) n FROM catalog_runs WHERE channel = 'asymtrading'")[0].n, 0,
    'a dry run wrote an audit row');
});
