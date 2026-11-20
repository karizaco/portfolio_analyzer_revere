'use strict';

// THE INTERCHANGEABILITY CONTRACT.
//
// The paid API and the browser are two routes to the same posts. They are
// interchangeable only if the same post, captured both ways, becomes the
// same canonical record -- so that is what this file pins, field by field,
// and how the importer merges the two when both arrive.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeApiV2Page } = require('../src/x/normalizeApiV2');
const { normalizeGraphqlResponse } = require('../src/x/normalizeGraphql');
const { normalizeDomPost } = require('../src/x/normalizeDom');
const { mergeRecords } = require('../src/x/merge');
const { IDS, USER, apiPage, graphqlTimeline } = require('./fixtures/x/scenario');

const CONTENT_FIELDS = [
  'post_id', 'user_id', 'handle', 'created_at', 'kind', 'text', 'text_source', 'lang', 'conversation_id',
  'in_reply_to_post_id', 'in_reply_to_user_id', 'self_thread', 'quoted_post_id', 'reposted_post_id',
  'entities', 'media', 'edit',
];

function pick(record) {
  return Object.fromEntries(CONTENT_FIELDS.map((field) => [field, record[field]]));
}

test('the same post via the API and via GraphQL normalizes to the same content', () => {
  const api = new Map(normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records.map((r) => [r.post_id, r]));
  const web = new Map(normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-20T11:00:00.000Z' }).records.map((r) => [r.post_id, r]));
  assert.deepEqual([...api.keys()].sort(), [...web.keys()].sort(), 'both routes see the same posts');
  for (const id of api.keys()) {
    assert.deepEqual(pick(web.get(id)), pick(api.get(id)), `post ${id} differs between the routes`);
  }
});

test('a cashtag is the same value whichever route spelled it with the marker', () => {
  // The API gives `NVDA`; the web GraphQL gives `$NVDA` and `#nasa` for a
  // hashtag. A cashtag is an EXPLICIT ticker (the extraction rule), so
  // `$NVDA` that matches no ticker is a lost holding -- and the archive's
  // content would depend on which route saw the post first.
  const api = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const web = normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-20T11:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  assert.deepEqual(api.entities.cashtags, ['NVDA', 'AMD']);
  assert.deepEqual(web.entities.cashtags, ['NVDA', 'AMD'], 'the $ marker is stripped');
  assert.deepEqual(web.entities.hashtags, ['nasa'], 'the # marker is stripped');
  assert.deepEqual(api.entities, web.entities);
});

test('merging: the API wins a field, but the first sighting and first metrics never move', () => {
  const web = normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-19T09:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const api = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const { record } = mergeRecords(web, api);
  assert.equal(record.fetched_via, 'api_v2');
  assert.equal(record.first_seen_at, '2026-11-19T09:00:00.000Z', 'the earliest sighting is kept');
  assert.equal(record.metrics_first_seen.likes, 11, 'the first observation of the metrics is kept');
  assert.equal(record.metrics_first_seen.observed_at, '2026-11-19T09:00:00.000Z');

  const again = mergeRecords(record, api);
  assert.equal(again.changed, false, 'merging the same capture twice changes nothing');
});

test('merging: the entity sets are UNIONED, and the order does not depend on the order of arrival', () => {
  // A cashtag is present or it is not, so the lower route's extra cashtags
  // must not be lost to a higher route that simply found fewer -- and the
  // merge must not depend on which route was seen first.
  const web = normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-19T09:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const api = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const narrow = { ...api, entities: { ...api.entities, cashtags: ['NVDA'] } };
  const forward = mergeRecords(narrow, web).record;
  const backward = mergeRecords(web, narrow).record;
  assert.deepEqual(forward.entities.cashtags, ['NVDA', 'AMD'], 'the lower route\'s extra cashtag survives');
  assert.deepEqual(forward.entities.cashtags, backward.entities.cashtags, 'the order does not depend on the arrival order');
});

test('merging: a truncated page-scraped text never replaces the full text, and a real media key replaces a placeholder', () => {
  const full = normalizeGraphqlResponse(graphqlTimeline(), { fetchedAt: '2026-11-20T11:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.long);
  const { record: dom } = normalizeDomPost({
    status_path: `/TestTrader/status/${IDS.long}`,
    datetime: '2026-11-18T15:00:00.000Z',
    text: `${full.text.slice(0, 120)}…`,
    show_more: true,
    media: [],
  }, { knownUsers: new Map([['testtrader', USER.id]]), fetchedAt: '2026-11-20T09:00:00.000Z' });
  assert.equal(dom.fidelity, 'partial');

  const merged = mergeRecords(dom, full).record;
  assert.equal(merged.text, full.text);
  assert.equal(merged.fidelity, 'full');
  const reverse = mergeRecords(full, dom).record;
  assert.equal(reverse.text, full.text, 'the order of arrival does not matter');

  const original = normalizeApiV2Page(apiPage(), { fetchedAt: '2026-11-20T10:00:00.000Z' }).records
    .find((r) => r.post_id === IDS.original);
  const { record: domOriginal } = normalizeDomPost({
    status_path: `/TestTrader/status/${IDS.original}`,
    datetime: '2026-11-18T14:32:08.000Z',
    text: 'Watching $NVDA over 145.50 & $AMD under 120. Daily chart:',
    media: ['https://pbs.twimg.com/media/AAA111?format=jpg&name=small'],
  }, { knownUsers: new Map([['testtrader', USER.id]]) });
  assert.equal(domOriginal.media[0].media_key, 'dom_AAA111');
  assert.equal(domOriginal.media[0].url, 'https://pbs.twimg.com/media/AAA111.jpg');
  assert.equal(mergeRecords(domOriginal, original).record.media[0].media_key, '3_111');
});
