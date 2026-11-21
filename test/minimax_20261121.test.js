'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeTweet } = require('../src/x/normalizeGraphql');

test('GraphQL retweet remains a repost when its embedded status is absent', () => {
  const record = normalizeTweet({
    __typename: 'Tweet',
    rest_id: '1001',
    core: {
      user_results: {
        result: {
          rest_id: '2001',
          core: { screen_name: 'example' },
        },
      },
    },
    legacy: {
      user_id_str: '2001',
      created_at: 'Wed Oct 07 20:49:13 +0000 2020',
      full_text: 'RT @source: Example',
      retweeted_status_id_str: '3001',
    },
  }, '2026-11-21T00:00:00.000Z');

  assert.equal(record.kind, 'repost');
  assert.equal(record.reposted_post_id, '3001');
});
