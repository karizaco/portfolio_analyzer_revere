'use strict';

// The API v2 and the web GraphQL normalizers, each on its own, against the
// same synthetic scenario (test/fixtures/x/scenario.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeApiV2Page } = require('../src/x/normalizeApiV2');
const { normalizeGraphqlResponse } = require('../src/x/normalizeGraphql');
const { validatePostRecord } = require('../src/x/postRecord');
const { IDS, LONG_TEXT, USER, apiPage, graphqlTimeline } = require('./fixtures/x/scenario');

const FETCHED = '2026-11-20T10:00:00.000Z';

function byId(records) {
  return new Map(records.map((record) => [record.post_id, record]));
}

for (const [label, normalize] of [
  ['api_v2', () => normalizeApiV2Page(apiPage(), { fetchedAt: FETCHED }).records],
  ['web_graphql', () => normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: FETCHED }).records],
  ['web_graphql (2025 core.screen_name + visibility wrapper)',
    () => normalizeGraphqlResponse(graphqlTimeline({ coreScreenName: true, wrapVisibility: true }), { fetchedAt: FETCHED }).records],
]) {
  test(`${label}: every post becomes a valid record of the right kind`, () => {
    const records = normalize();
    assert.equal(records.length, 7, 'the quoted and reposted posts are references, not posts of their own');
    for (const record of records) assert.deepEqual(validatePostRecord(record).errors, [], record.post_id);
    const posts = byId(records);

    const original = posts.get(IDS.original);
    assert.equal(original.kind, 'original');
    assert.equal(original.handle, 'testtrader');
    assert.equal(original.user_id, USER.id);
    assert.equal(original.text, 'Watching $NVDA over 145.50 & $AMD under 120. Daily chart:', 'entities decoded, media link removed');
    assert.deepEqual(original.entities.cashtags, ['NVDA', 'AMD']);
    assert.equal(original.media.length, 1);
    assert.equal(original.media[0].media_key, '3_111');
    assert.equal(original.media[0].width, 1920);

    const long = posts.get(IDS.long);
    assert.equal(long.text_source, 'note_tweet', 'the long post\'s full text comes from the note');
    assert.equal(long.text, LONG_TEXT);
    assert.deepEqual(long.entities.cashtags, ['SPY', 'SMH']);

    const selfReply = posts.get(IDS.selfReply);
    assert.equal(selfReply.kind, 'reply');
    assert.equal(selfReply.self_thread, true);
    assert.equal(selfReply.in_reply_to_post_id, IDS.original);
    assert.equal(selfReply.conversation_id, IDS.original);
    assert.equal(selfReply.text, 'Triggered. Stop to break-even.', 'the reply\'s @-addressee is removed');

    assert.equal(posts.get(IDS.replyOther).self_thread, false);

    const quote = posts.get(IDS.quote);
    assert.equal(quote.kind, 'quote');
    assert.equal(quote.quoted_post_id, IDS.quoted);
    const quotedRef = quote.referenced.find((ref) => ref.type === 'quoted');
    assert.equal(quotedRef.text, 'TSLA flagging on the daily');
    assert.equal(quotedRef.handle, 'otherguy');

    const repost = posts.get(IDS.repost);
    assert.equal(repost.kind, 'repost');
    assert.equal(repost.reposted_post_id, IDS.reposted);

    const edited = posts.get(IDS.editedLatest);
    assert.deepEqual(edited.edit.history_ids, [IDS.editedFirst, IDS.editedLatest]);
    assert.equal(edited.edit.is_earliest, false, 'a later version of an edited post is flagged');
  });
}

test('api_v2: errors[] entries (deleted / protected posts) are reported, not dropped silently', () => {
  const page = apiPage();
  page.errors = [{ resource_id: '1858000000000000000', title: 'Not Found Error', type: 'https://api.twitter.com/2/problems/resource-not-found' }];
  const { errors } = normalizeApiV2Page(page, { fetchedAt: FETCHED });
  assert.deepEqual(errors.map((error) => error.post_id), ['1858000000000000000']);
});

test('api_v2: the deleted post\'s id is found in WHICHEVER field X puts it in', () => {
  // X has carried the id of a failed resource in more than one field, and
  // WHICH one has differed between API versions. A deleted post whose id
  // was lost cannot be marked as deleted, so the reader takes the id from
  // whichever field holds one -- and from the detail when neither does.
  const shapes = [
    { resource_id: '1858000000000000000', resource_type: 'tweet', title: 'Not Found Error' },
    { value: '1858000000000000001', resource_type: 'tweet', title: 'Not Found Error' },
    { detail: 'Could not find tweet with id: [1858000000000000002].', title: 'Not Found Error' },
  ];
  for (const shape of shapes) {
    const page = apiPage();
    page.errors = [shape];
    const { errors } = normalizeApiV2Page(page, { fetchedAt: FETCHED });
    assert.match(errors[0].post_id, /^18580000000000000\d\d$/, JSON.stringify(shape));
  }
  const page = apiPage();
  page.errors = [{ resource_id: 'tweet', value: '1858000000000000003', resource_type: 'tweet' }];
  assert.equal(normalizeApiV2Page(page, { fetchedAt: FETCHED }).errors[0].post_id, '1858000000000000003',
    'a field that holds a TYPE is not mistaken for an id');
});

test('web_graphql: a tombstone is reported, and the paging cursor is found', () => {
  const { unavailable, cursors } = normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: FETCHED });
  assert.equal(unavailable.length, 1);
  assert.match(unavailable[0].reason, /deleted/);
  assert.equal(cursors.bottom, 'DAABCgABGc');
});

test('web_graphql: a REAL captured SearchTimeline page normalizes completely (live shape, 2026-11-21)', () => {
  // The other GraphQL fixtures were modelled on the known structure; this
  // one is a real capture of the browser crawler's first live session,
  // trimmed to five posts. If X changes the shape, this is what fails.
  const fs = require('node:fs');
  const path = require('node:path');
  const capture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'x', 'real_search_timeline_chickengenius_2026-10.json'), 'utf8'));
  const { records, unavailable } = normalizeGraphqlResponse(capture.body, { fetchedAt: capture.fetched_at });
  assert.equal(unavailable.length, 0);
  assert.equal(records.length, 5);
  for (const record of records) {
    assert.deepEqual(validatePostRecord(record), { ok: true, errors: [] }, `${record.post_id} is a valid x-post-1 record`);
    assert.equal(record.handle, 'chickengenius');
    assert.equal(record.user_id, '1027041315110842368');
    assert.equal(record.fidelity, 'full');
  }
  const byId = Object.fromEntries(records.map((r) => [r.post_id, r]));
  const buy = byId['2108547145498276146'];
  assert.equal(buy.kind, 'original');
  assert.deepEqual(buy.entities.cashtags, ['LEU'], 'the cashtag arrives without its $ (the web shape is "$LEU")');
  assert.equal(buy.media.length, 1);
  assert.equal(buy.media[0].type, 'photo');
  const threadReply = byId['2108548379844465040'];
  assert.equal(threadReply.kind, 'reply');
  assert.equal(threadReply.self_thread, true, 'a reply to his own post is a tweetstorm, and the policy keeps it');
  assert.equal(byId['2114914774496710921'].self_thread, false, 'a reply to somebody else: the policy drops it');
  assert.equal(byId['2114913418713190885'].text_source, 'note_tweet', 'a long post is read in full, not truncated');
  assert.equal(byId['2107639919686681005'].kind, 'quote');
  assert.ok(byId['2107639919686681005'].quoted_post_id, 'a quote names the post it quotes');
});
