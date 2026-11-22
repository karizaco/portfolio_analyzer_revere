'use strict';

// What of the X source is committed, and what must never be.
//
//   tracked    data/x_pipeline/archive/   the record (posts get deleted; the API costs money)
//   untracked  raw captures, downloaded images, the rebuildable index, the crawl lock
//   outside    the browser profile -- it holds the user's X session cookies

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { defaultProfileDir, isInsideRepo } = require('../src/x/browser/capture');

const ROOT = path.resolve(__dirname, '..');

function ignored(relativePath) {
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    return null; // no git: cannot tell
  }
}

test('the post archive is tracked; raw captures, images, the index and the lock are not', (t) => {
  if (ignored('data/x_pipeline/archive/1/2026/2026-11.jsonl') === null) {
    t.skip('git is not available');
    return;
  }
  assert.equal(ignored('data/x_pipeline/archive/1/2026/2026-11.jsonl'), false, 'the archive must be committed');
  for (const p of ['data/x_pipeline/raw/run/a.json.gz', 'data/x_pipeline/media/1/1_0.jpg',
    'data/x_pipeline/x_index.sqlite', 'data/x_pipeline/x_index.sqlite-wal', 'data/x_pipeline/.browser.lock']) {
    assert.equal(ignored(p), true, `${p} must be ignored`);
  }
});

test('the browser profile with the X session is outside the repository unless explicitly moved', () => {
  assert.equal(isInsideRepo(defaultProfileDir({ LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' })), false);
  assert.equal(isInsideRepo(defaultProfileDir({})), false);
});

test('.env (the X token, the X session cookies, the MiniMax key) is ignored and has never been committed', (t) => {
  if (ignored('.env') === null) {
    t.skip('git is not available');
    return;
  }
  assert.equal(ignored('.env'), true, '.env must stay in .gitignore');
  const tracked = execFileSync('git', ['ls-files', '--', '.env'], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(tracked, '', '.env must not be tracked (git rm --cached .env, then rotate every key in it)');
});
