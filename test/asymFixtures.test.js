'use strict';

// The AsymTrading fixtures must be TRACKED, and they must be the posts the
// tests actually read.
//
// This is the same shape as test/qmgBenchmarkFixtures.test.js. The captured
// corpus is what makes the AsymTrading tests run OFFLINE, and a fixture
// that silently changes is a test that silently stops testing what it
// claims to.
//
// The md5 check is the important one. A fixture's identity is its FILE, not
// its name: if a captured post is replaced -- by a re-capture, or by
// accident -- the parser's measured behaviour changes with it, and every
// recorded number moves.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'asym');
const FREE_DIR = path.join(FIXTURES, 'free');
const MANIFEST = path.join(FIXTURES, 'manifest.json');

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

test('the fixture manifest is present and says where the posts came from', () => {
  const meta = manifest();
  assert.ok(meta.description, 'the manifest says what the fixtures are');
  assert.ok(meta.source && meta.source.publication, 'the manifest names the publication');
  assert.ok(meta.source.endpoint, 'the manifest names the endpoint the posts came from');
  assert.ok(meta.why_fixtures, 'the manifest says why the tests read fixtures rather than the API');
});

test('every fixture the manifest names exists and is the file it names', () => {
  const meta = manifest();
  const files = meta.files;

  for (const name of ['corpus_index.json', 'post_224076892_paid.json']) {
    const entry = files[name];
    assert.ok(entry, `the manifest does not describe ${name}`);
    const filePath = path.join(FIXTURES, name);
    assert.ok(fs.existsSync(filePath), `${name} is missing from test/fixtures/asym/`);
    assert.equal(md5(filePath), entry.md5,
      `${name} has changed (md5 ${md5(filePath)}, expected ${entry.md5}). If a fixture was `
      + 'deliberately replaced, update the manifest and the recorded numbers together.');
  }

  const freeEntry = files['free/*.json'];
  assert.ok(freeEntry, 'the manifest does not describe the free corpus');
  const onDisk = fs.readdirSync(FREE_DIR).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(onDisk, Object.keys(freeEntry.md5).sort(),
    'the free corpus on disk and the one the manifest names are not the same set');
  for (const [name, expected] of Object.entries(freeEntry.md5)) {
    const actual = md5(path.join(FREE_DIR, name));
    assert.equal(actual, expected,
      `${name} has changed (md5 ${actual}, expected ${expected}). A fixture's identity is its `
      + 'FILE -- if it was deliberately replaced, update the manifest and the recorded '
      + 'numbers together.');
  }
});

test('the free corpus is the whole free corpus', () => {
  const meta = manifest();
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus_index.json'), 'utf8'));
  const free = index.filter((row) => row.audience !== 'only_paid');
  assert.equal(meta.files['free/*.json'].count, free.length,
    'the manifest counts a different number of free posts than the corpus index lists');
  assert.equal(fs.readdirSync(FREE_DIR).filter((n) => n.endsWith('.json')).length, free.length);
});

test('every captured post is a real post, not an error page', () => {
  // A capture that failed would be a JSON object with an `error` key, and
  // every test that reads it would fail in a way that looks like a parser
  // bug.
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus_index.json'), 'utf8'));
  for (const row of index) {
    assert.ok(Number.isInteger(row.id), `a corpus row has no numeric post id: ${JSON.stringify(row)}`);
    assert.ok(row.slug, `a corpus row has no slug: ${JSON.stringify(row)}`);
    assert.ok(row.date, `a corpus row has no date: ${JSON.stringify(row)}`);
  }
  for (const name of fs.readdirSync(FREE_DIR).filter((n) => n.endsWith('.json'))) {
    const post = JSON.parse(fs.readFileSync(path.join(FREE_DIR, name), 'utf8'));
    assert.ok(!post.error, `${name} is an error response, not a post`);
    assert.equal(post.slug, name.replace(/\.json$/, ''), `${name} does not match its slug`);
    assert.ok(post.body_html && post.body_html.length > 0, `${name} has no body`);
  }
});

test('the paid fixture really is paywalled', () => {
  // If this fixture were ever replaced with a free post, the gate's
  // behaviour would change and the test would still pass -- so the test
  // checks the fixture, not just the code.
  const paid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'post_224076892_paid.json'), 'utf8'));
  assert.equal(paid.audience, 'only_paid');
  assert.ok(!(paid.body_html || '').includes('Market Metrics'),
    'the paid fixture has a report in it, so it is not the fixture it claims to be');
});