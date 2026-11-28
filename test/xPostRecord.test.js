'use strict';

// The canonical X post record: ids, dates, text normalisation, validation
// and the reply policy. See src/x/postRecord.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalize, classifyUnlabelledReply, compareIds, isPostId, keepByPolicy, normalizeText, parseXDate, snowflakeTime, validatePostRecord,
} = require('../src/x/postRecord');
const { idAt } = require('./fixtures/x/scenario');

function valid(overrides = {}) {
  const created = '2026-11-18T14:32:08.000Z';
  return canonicalize({
    post_id: idAt(created, 7), user_id: '123456789', handle: 'TestTrader', created_at: created,
    kind: 'original', text: 'hello $NVDA', fetched_via: 'api_v2', fidelity: 'full', ...overrides,
  });
}

test('an id is a string, because a JS number cannot hold it', () => {
  const id = idAt('2026-11-18T14:32:08.000Z', 7);
  assert.ok(BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER), 'the fixture id must exceed 2^53 to prove the point');
  assert.notEqual(String(Number(id)), id, 'Number() silently changes the id');
  assert.equal(isPostId(id), true);
  assert.equal(isPostId(Number(id)), false);
  assert.equal(compareIds('9007199254740993', '9007199254740992'), 1, 'compared numerically, past 2^53');
});

test('the id carries its own timestamp, and created_at is checked against it', () => {
  const iso = '2026-11-18T14:32:08.000Z';
  const id = idAt(iso, 3);
  assert.equal(new Date(snowflakeTime(id)).toISOString(), iso);
  assert.equal(snowflakeTime('20'), null, 'a pre-snowflake id carries no time and is not checked');

  const bad = valid({ created_at: '2026-11-17T14:32:08.000Z' });
  bad.post_id = idAt('2026-11-18T14:32:08.000Z', 7);
  const check = validatePostRecord(bad);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(' '), /disagrees with the id's own time/);
});

test('both date forms parse: ISO and the legacy web-app form', () => {
  assert.equal(parseXDate('Wed Nov 18 14:32:08 +0000 2026'), '2026-11-18T14:32:08.000Z');
  assert.equal(parseXDate('2026-11-18T14:32:08Z'), '2026-11-18T14:32:08.000Z');
  assert.equal(parseXDate('2h'), '', 'a relative time is not a date');
});

test('a reply X did not label is a reply, and only an own thread is kept', () => {
  const created = '2026-11-18T14:32:08.000Z';
  const root = idAt(created, 1);
  const reply = valid({
    post_id: idAt(created, 2),
    conversation_id: root,
    kind: 'original',
    text: '@someone Agree',
  });
  const ownThread = classifyUnlabelledReply(reply, new Set([root]));
  assert.equal(ownThread.kind, 'reply');
  assert.equal(ownThread.self_thread, true);
  assert.equal(keepByPolicy(ownThread).keep, true);

  const other = classifyUnlabelledReply(reply, new Set());
  assert.equal(other.self_thread, false);
  assert.equal(keepByPolicy(other).reason, 'reply_to_other');

  const post = valid();
  const untouched = classifyUnlabelledReply({ ...post, conversation_id: post.post_id, text: 'my own post' }, new Set());
  assert.equal(untouched.kind, 'original', 'a post whose conversation is itself is not a reply');
});

test('text is normalised the same way on every route', () => {
  assert.equal(normalizeText('Long $X &amp; $Y &lt;3 https://t.co/abc123'), 'Long $X & $Y <3');
  assert.equal(normalizeText('see https://t.co/inline1 for more'), 'see https://t.co/inline1 for more',
    'a link in the middle of the text is the author\'s own link');
  assert.equal(normalizeText('@TestTrader @Other Triggered.', { isReply: true }), 'Triggered.');
  assert.equal(normalizeText('@TestTrader is right', { isReply: false }), '@TestTrader is right',
    'only a reply\'s leading addressees are presentation');
});

test('a valid record validates, and the common corruptions do not', () => {
  assert.deepEqual(validatePostRecord(valid()).errors, []);
  assert.equal(validatePostRecord({ ...valid(), post_id: 123 }).ok, false, 'a numeric id is refused');
  assert.equal(validatePostRecord({ ...valid(), handle: 'has space' }).ok, false);
  assert.equal(validatePostRecord({ ...valid(), kind: 'repost', reposted_post_id: null }).ok, false);
});

test('canonicalize writes every field in one fixed order', () => {
  const a = valid();
  const b = canonicalize(JSON.parse(JSON.stringify({ ...a, extra: 'dropped' })));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(Object.keys(a)[0], 'schema');
  assert.equal('extra' in b, false);
});

test('the reply policy keeps own posts and own thread replies, never replies to others or reposts', () => {
  assert.equal(keepByPolicy(valid({ kind: 'original' }), 'self').keep, true);
  assert.equal(keepByPolicy(valid({ kind: 'quote', quoted_post_id: '1858123456789012345' }), 'self').keep, true);
  assert.equal(keepByPolicy(valid({ kind: 'reply', self_thread: true, in_reply_to_user_id: '123456789' }), 'self').keep, true);
  assert.deepEqual(keepByPolicy(valid({ kind: 'reply', self_thread: false, in_reply_to_user_id: '5' }), 'self'),
    { keep: false, reason: 'reply_to_other' });
  assert.deepEqual(keepByPolicy(valid({ kind: 'repost', reposted_post_id: '1858123456789012345' }), 'self'),
    { keep: false, reason: 'repost' });
  assert.equal(keepByPolicy(valid({ kind: 'reply', self_thread: true, in_reply_to_user_id: '123456789' }), 'none').keep, false);
});
