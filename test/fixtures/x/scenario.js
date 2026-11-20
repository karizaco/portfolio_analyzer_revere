'use strict';

/**
 * One synthetic account's posts, rendered in BOTH response shapes:
 * the X API v2 page and the web app's GraphQL timeline.
 *
 * The shapes follow the documented API v2 format and the known structure of
 * the web GraphQL timeline (TimelineAddEntries -> tweet_results.result).
 * They are SYNTHETIC: Phase 0's real captures are what confirm the GraphQL
 * shape, and test/manual/ replays those.
 *
 * Every id is a real snowflake for its created_at, so the record validator's
 * "the id carries its own time" check is exercised, not bypassed.
 */

const EPOCH = 1288834974657n;

function idAt(iso, seq = 1) {
  const ms = BigInt(Date.parse(iso));
  return String(((ms - EPOCH) << 22n) | BigInt(seq));
}

const USER = { id: '123456789', username: 'TestTrader', name: 'Test Trader' };
const OTHER = { id: '987654321', username: 'OtherGuy', name: 'Other Guy' };

const T = {
  original: '2026-11-18T14:32:08.000Z',
  long: '2026-11-18T15:00:00.000Z',
  selfReply: '2026-11-18T19:45:10.000Z',
  replyOther: '2026-11-18T20:00:00.000Z',
  quote: '2026-11-19T13:10:00.000Z',
  quoted: '2026-11-19T12:00:00.000Z',
  repost: '2026-11-19T14:00:00.000Z',
  reposted: '2026-11-19T11:00:00.000Z',
  editedFirst: '2026-11-19T15:00:00.000Z',
  editedLatest: '2026-11-19T15:05:00.000Z',
};

const IDS = Object.fromEntries(Object.entries(T).map(([key, iso], index) => [key, idAt(iso, index + 1)]));

const LONG_TEXT = `${'Big picture on $SPY and semis. '.repeat(12)}Adding $SMH over 250 with a stop under 240.`;

/** The posts, as the truth both renderings share. */
const POSTS = [
  {
    key: 'original', author: USER, text: 'Watching $NVDA over 145.50 &amp; $AMD under 120. Daily chart:',
    cashtags: ['NVDA', 'AMD'], media: [{ key: '3_111', type: 'photo', url: 'https://pbs.twimg.com/media/AAA111.jpg', w: 1920, h: 1080 }],
    tco: 'https://t.co/media111',
  },
  { key: 'long', author: USER, text: LONG_TEXT, note: true, cashtags: ['SPY', 'SMH'] },
  {
    key: 'selfReply', author: USER, text: 'Triggered. Stop to break-even.', replyTo: { key: 'original', user: USER },
    cashtags: [],
  },
  {
    key: 'replyOther', author: USER, text: 'Agree, nice trade', replyTo: { id: idAt('2026-11-18T19:00:00.000Z', 99), user: OTHER },
    cashtags: [],
  },
  {
    key: 'quote', author: USER, text: 'This is the setup I mean. $TSLA', quote: 'quoted', cashtags: ['TSLA'],
    tco: 'https://t.co/quote1',
  },
  { key: 'quoted', author: OTHER, text: 'TSLA flagging on the daily', cashtags: [], onlyIncluded: true },
  { key: 'repost', author: USER, text: 'RT @OtherGuy: Market breadth is improving', repostOf: 'reposted', cashtags: [] },
  { key: 'reposted', author: OTHER, text: 'Market breadth is improving', cashtags: [], onlyIncluded: true },
  {
    key: 'editedLatest', author: USER, text: 'Long $PLTR here (edited: size 3%)', cashtags: ['PLTR'],
    editHistory: ['editedFirst', 'editedLatest'],
  },
];

function byKey(key) {
  return POSTS.find((post) => post.key === key);
}

/** Render the API v2 page. */
function apiPage() {
  const data = [];
  const includesTweets = [];
  const media = [];
  for (const post of POSTS) {
    const refs = [];
    if (post.replyTo) refs.push({ type: 'replied_to', id: post.replyTo.key ? IDS[post.replyTo.key] : post.replyTo.id });
    if (post.quote) refs.push({ type: 'quoted', id: IDS[post.quote] });
    if (post.repostOf) refs.push({ type: 'retweeted', id: IDS[post.repostOf] });
    const replyPrefix = post.replyTo ? `@${post.replyTo.user.username} ` : '';
    const fullText = `${replyPrefix}${post.text}${post.tco ? ` ${post.tco}` : ''}`;
    const tweet = {
      id: IDS[post.key],
      text: post.note ? `${fullText.slice(0, 270)}…` : fullText,
      author_id: post.author.id,
      created_at: T[post.key],
      conversation_id: post.replyTo && post.replyTo.key ? IDS[post.replyTo.key] : (post.replyTo ? post.replyTo.id : IDS[post.key]),
      lang: 'en',
      edit_history_tweet_ids: post.editHistory ? post.editHistory.map((key) => IDS[key]) : [IDS[post.key]],
      entities: { cashtags: post.cashtags.map((tag) => ({ tag })) },
      public_metrics: { like_count: 10, retweet_count: 2, reply_count: 1, quote_count: 0, impression_count: 500, bookmark_count: 3 },
    };
    if (post.note) tweet.note_tweet = { text: fullText, entities: { cashtags: post.cashtags.map((tag) => ({ tag })) } };
    if (refs.length) tweet.referenced_tweets = refs;
    if (post.replyTo) tweet.in_reply_to_user_id = post.replyTo.user.id;
    if (post.media) {
      tweet.attachments = { media_keys: post.media.map((item) => item.key) };
      for (const item of post.media) media.push({ media_key: item.key, type: item.type, url: item.url, width: item.w, height: item.h });
    }
    if (post.onlyIncluded) includesTweets.push(tweet);
    else data.push(tweet);
  }
  return {
    data,
    includes: { users: [USER, OTHER], tweets: includesTweets, media },
    meta: { result_count: data.length },
  };
}

function legacyDate(iso) {
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:`
    + `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}

function gqlUser(user, useCoreScreenName) {
  return {
    __typename: 'User',
    rest_id: user.id,
    ...(useCoreScreenName ? { core: { screen_name: user.username, name: user.name } } : {}),
    legacy: useCoreScreenName ? { name: user.name } : { screen_name: user.username, name: user.name },
  };
}

/** Render one post as a GraphQL tweet object. */
function gqlTweet(post, options = {}) {
  const replyPrefix = post.replyTo ? `@${post.replyTo.user.username} ` : '';
  const fullText = `${replyPrefix}${post.text}${post.tco ? ` ${post.tco}` : ''}`;
  const legacy = {
    id_str: IDS[post.key],
    user_id_str: post.author.id,
    created_at: legacyDate(T[post.key]),
    full_text: post.note ? `${fullText.slice(0, 270)}…` : fullText,
    conversation_id_str: post.replyTo && post.replyTo.key ? IDS[post.replyTo.key] : (post.replyTo ? post.replyTo.id : IDS[post.key]),
    lang: 'en',
    entities: { symbols: post.cashtags.map((text) => ({ text })), hashtags: [], user_mentions: [], urls: [] },
    favorite_count: 11, retweet_count: 2, reply_count: 1, quote_count: 0, bookmark_count: 3,
  };
  if (post.replyTo) {
    legacy.in_reply_to_status_id_str = post.replyTo.key ? IDS[post.replyTo.key] : post.replyTo.id;
    legacy.in_reply_to_user_id_str = post.replyTo.user.id;
    legacy.in_reply_to_screen_name = post.replyTo.user.username;
  }
  if (post.media) {
    legacy.extended_entities = {
      media: post.media.map((item) => ({
        media_key: item.key, type: item.type, media_url_https: item.url, original_info: { width: item.w, height: item.h },
      })),
    };
  }
  const tweet = {
    __typename: 'Tweet',
    rest_id: IDS[post.key],
    core: { user_results: { result: gqlUser(post.author, options.coreScreenName) } },
    legacy,
    views: { count: '512', state: 'EnabledWithCount' },
    edit_control: post.editHistory
      ? { initial_tweet_id: IDS[post.editHistory[0]], edit_control_initial: { edit_tweet_ids: post.editHistory.map((key) => IDS[key]) } }
      : { edit_tweet_ids: [IDS[post.key]] },
  };
  if (post.note) {
    tweet.note_tweet = {
      is_expandable: true,
      note_tweet_results: { result: { text: fullText, entity_set: { symbols: post.cashtags.map((text) => ({ text })) } } },
    };
  }
  if (post.quote) {
    legacy.is_quote_status = true;
    legacy.quoted_status_id_str = IDS[post.quote];
    tweet.quoted_status_result = { result: gqlTweet(byKey(post.quote), options) };
  }
  if (post.repostOf) {
    legacy.retweeted_status_result = { result: gqlTweet(byKey(post.repostOf), options) };
  }
  return options.wrapVisibility ? { __typename: 'TweetWithVisibilityResults', tweet } : tweet;
}

/** Render the GraphQL SearchTimeline response. */
function graphqlTimeline(options = {}) {
  const entries = POSTS.filter((post) => !post.onlyIncluded).map((post, index) => ({
    entryId: `tweet-${IDS[post.key]}`,
    sortIndex: String(1000 - index),
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineTweet',
        tweet_results: { result: gqlTweet(post, { ...options, wrapVisibility: options.wrapVisibility && index === 0 }) },
      },
    },
  }));
  entries.push({
    entryId: 'tweet-tombstone',
    content: { entryType: 'TimelineTimelineItem', itemContent: { tweet_results: { result: { __typename: 'TweetTombstone', tombstone: { text: { text: 'This Post was deleted by the Post author.' } } } } } },
  });
  entries.push({ entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'DAABCgABGc' } });
  return {
    data: {
      search_by_raw_query: {
        search_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
      },
    },
  };
}

module.exports = { IDS, LONG_TEXT, OTHER, POSTS, T, USER, apiPage, graphqlTimeline, idAt };
