'use strict';

// The AsymTrading source: its identity, its access gate, and its parser.
//
// These tests run OFFLINE. They read the captured fixtures under
// test/fixtures/asym/, which are real posts captured from the publication
// on 2026-11-11.
//
// WHY FIXTURES RATHER THAN THE LIVE API
//
// The publication is rate-limited -- a full catalog walk is 20 requests,
// and asking for it repeatedly gets the IP throttled (measured: HTTP 429
// after a handful of walks). A test suite that hits the network would be
// slow, flaky, and would eventually fail for reasons that have nothing to
// do with the code. So the corpus is captured once and the tests read it.
//
// The fixtures are the whole free corpus (42 posts) plus one paid post and
// the corpus index, so the tests cover every format era the report has
// been in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ASYM_CHANNEL,
  ASYM_ID_PREFIX,
  ASYM_PUBLICATION_ID,
  asymPostId,
  asymPostUrl,
  asymVideoId,
  channelFromSourceUrl,
  isAsymSourceUrl,
} = require('../src/asym/channel');
const {
  ASYM_SERIES,
  asymAccess,
  asymMedia,
  asymPostQuarantine,
  asymSeries,
} = require('../src/asym/contentFilter');
const {
  matchSectors,
  metricForLabel,
  parseAsymArticle,
  splitBlocks,
  splitLabelValue,
  summarizeAsymArticle,
} = require('../src/asym/articleParse');
const { createAsymClient } = require('../src/asym/substackClient');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'asym');
const FREE_DIR = path.join(FIXTURES, 'free');

/** Every captured free post. */
function freePosts() {
  return fs.readdirSync(FREE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(FREE_DIR, name), 'utf8')));
}

/** One captured post, by slug. */
function freePost(slug) {
  return JSON.parse(fs.readFileSync(path.join(FREE_DIR, `${slug}.json`), 'utf8'));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('the catalog id namespaces the post id', () => {
  assert.equal(asymVideoId(222466781), 'asym_222466781');
  assert.equal(asymVideoId('222466781'), 'asym_222466781');
});

test('a non-numeric post id is refused rather than silently mangled', () => {
  // The slug is NOT an id: `market-pulse-open-access` and
  // `market-pulse-open-access-bf1` are different posts with the same
  // series, and `6-steps-to-profitable-swing-trading` appears with six
  // different suffixes.
  assert.throws(() => asymVideoId('market-pulse-2d2'), /numeric/);
  assert.throws(() => asymVideoId(''), /numeric/);
  assert.throws(() => asymVideoId(null), /numeric/);
});

test('the post id can be read back out of the catalog id', () => {
  assert.equal(asymPostId('asym_222466781'), '222466781');
  assert.equal(asymPostId('222466781'), null);
  assert.equal(asymPostId('asym_abc'), null);
  assert.equal(asymPostId(''), null);
});

test('a YouTube video id is never mistaken for ours', () => {
  assert.equal(asymPostId('dQw4w9WgXcQ'), null);
});

test('the source URL identifies the publication', () => {
  assert.ok(isAsymSourceUrl('https://asymtrading.substack.com/archive'));
  assert.ok(isAsymSourceUrl('https://asymtrading.substack.com/p/market-pulse-2d2'));
  assert.ok(!isAsymSourceUrl('https://www.youtube.com/@Qullamaggie/videos'));
  assert.equal(channelFromSourceUrl('https://asymtrading.substack.com'), ASYM_CHANNEL);
  assert.equal(channelFromSourceUrl('https://www.youtube.com/@t3live/streams'), '');
});

test('the catalog id is namespaced so it cannot collide with a YouTube id', () => {
  assert.ok(ASYM_ID_PREFIX.length > 0);
  assert.notEqual(asymVideoId(222466781), '222466781');
});

test('the publication id is the numeric one the API requires', () => {
  // The media-upload endpoint needs `override_publication_id`, and every
  // post carries the same one.
  assert.equal(typeof ASYM_PUBLICATION_ID, 'number');
  const post = freePost('market-pulse-2d2');
  assert.equal(post.publication_id, ASYM_PUBLICATION_ID);
});

test('the post URL is the canonical one', () => {
  assert.equal(
    asymPostUrl('market-pulse-2d2'),
    'https://asymtrading.substack.com/p/market-pulse-2d2',
  );
});

// ---------------------------------------------------------------------------
// The access gate
// ---------------------------------------------------------------------------

test('a free post is readable', () => {
  const access = asymAccess(freePost('market-pulse-2d2'));
  assert.equal(access.readable, true);
  assert.equal(access.reason, 'free');
});

test('a paid post is not readable, and says so', () => {
  const paid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'post_224076892_paid.json'), 'utf8'));
  const access = asymAccess(paid);
  assert.equal(access.readable, false);
  assert.equal(access.reason, 'paywalled');
});

test('a paid post carries the boilerplate but no report', () => {
  // The publication says `only_paid`, and what comes back is the shared
  // intro every post starts with -- the "What You Can Expect" block -- and
  // nothing else. No report, no headings, no market readings.
  //
  // This is why the gate checks the AUDIENCE first and the body second.
  // The body alone would not be enough: a reader cannot tell a paywalled
  // post from a free one by looking at the boilerplate.
  const paid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'post_224076892_paid.json'), 'utf8'));
  assert.equal(paid.audience, 'only_paid');
  assert.ok((paid.body_html || '').length > 0, 'the shared intro is present');
  assert.ok(!(paid.body_html || '').includes('Market Metrics'),
    'the report itself is not in a paywalled body');
  assert.equal(splitBlocks(paid.body_html).some((b) => b.tag.startsWith('h')), false,
    'the boilerplate has no headings; the report does');
  assert.ok((paid.truncated_body_text || '').length > 0, 'a teaser is present');
});

test('the listing endpoint gives a paid post no body at all', () => {
  // The two endpoints differ: the LIST endpoint returns an empty body for
  // a paid post, while the BY-ID endpoint returns the boilerplate. The
  // catalog uses the list endpoint, so a paywalled post there is empty.
  // Both are recorded here because the difference is easy to trip over.
  const paid = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'post_224076892_paid.json'), 'utf8'));
  assert.ok((paid.body_html || '').length > 0);
  assert.equal(asymAccess(paid).readable, false, 'and it is still not readable');
});

test('an unrecognised audience is not an access grant', () => {
  const access = asymAccess({ audience: 'founders_of_the_month', body_html: '<p>hi</p>' });
  assert.equal(access.readable, false);
  assert.match(access.reason, /unknown_audience/);
});

test('a free post with no body is not readable either', () => {
  const access = asymAccess({ audience: 'everyone', body_html: '', truncated_body_text: 'teaser' });
  assert.equal(access.readable, false);
  assert.equal(access.reason, 'teaser_only');
});

// ---------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------

test('every post in the corpus is classified', () => {
  // A post that falls into "other" is a post the catalog cannot describe.
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'corpus_index.json'), 'utf8'));
  const unclassified = index.filter((row) => asymSeries(row.slug) === ASYM_SERIES.OTHER);
  assert.deepEqual(unclassified.map((row) => row.slug), [],
    'every published post belongs to a known series');
});

test('the main series is recognised from its slug', () => {
  assert.equal(asymSeries('market-pulse-2d2'), ASYM_SERIES.MARKET_PULSE);
  assert.equal(asymSeries('market-pulse-open-access'), ASYM_SERIES.MARKET_PULSE);
});

test('a copy is a copy, not the series it copies', () => {
  assert.equal(asymSeries('copy-market-pulse'), ASYM_SERIES.COPY);
  assert.equal(asymSeries('copy-market-pulse-347'), ASYM_SERIES.COPY);
});

test('the non-market series are quarantined', () => {
  const course = asymPostQuarantine({ slug: '6-steps-to-profitable-swing-trading' });
  assert.equal(course.quarantined, true);
  assert.match(course.reason, /non_market_series/);
});

test('the Market Pulse series is not quarantined', () => {
  const pulse = asymPostQuarantine({ slug: 'market-pulse-2d2' });
  assert.equal(pulse.quarantined, false);
});

test('the educational and pre-launch posts are the quarantined ones', () => {
  // The free corpus is 42 posts: 27 Market Pulse reports, 12 from the
  // course / profile / pre-launch series, and 3 that announce or explain a
  // feature ("Momentum Movers", "Learning Together", "Market Monitor").
  //
  // The 12 are quarantined: they carry no market calls. The 3 are not --
  // they are ABOUT the market work, and a subscriber session would want
  // them. They simply do not parse as a report, and the parser says so by
  // returning no readings for them, which is honest.
  const free = freePosts();
  const marketPulse = free.filter((p) => asymSeries(p.slug) === ASYM_SERIES.MARKET_PULSE);
  const quarantined = free.filter((p) => asymPostQuarantine(p).quarantined);

  assert.equal(free.length, 42);
  assert.equal(marketPulse.length, 27);
  assert.equal(quarantined.length, 12);

  const quarantinedSeries = [...new Set(quarantined.map((p) => asymSeries(p.slug)))].sort();
  assert.deepEqual(quarantinedSeries, [
    'prelaunch',
    'swing_trading_course',
    'trader_profile',
  ]);
});

test('a post that is not a report parses to no readings', () => {
  // The three free non-report posts are not quarantined, so the parser is
  // what keeps them out of the readings -- and it does so by finding
  // nothing rather than by inventing something.
  for (const slug of ['momentum-movers', 'learning-together', 'market-breadth-monitor']) {
    const parsed = parseAsymArticle(freePost(slug));
    assert.equal(parsed.backdrop, null, `${slug} has no backdrop`);
    assert.equal(parsed.trend, null, `${slug} has no trend`);
    assert.equal(parsed.breadth, null, `${slug} has no breadth`);
    assert.equal(parsed.momentum, null, `${slug} has no momentum`);
  }
});

// ---------------------------------------------------------------------------
// The embedded media
// ---------------------------------------------------------------------------

test('the media upload id is read out of the body', () => {
  const media = asymMedia(freePost('market-pulse-2d2'));
  assert.equal(media.hasMedia, true);
  assert.equal(media.mediaUploadId, 'd5ace2e7-950f-405b-b7f7-dbe26f68a849');
});

test('a post with no video reports no media', () => {
  const media = asymMedia({ body_html: '<p>no video here</p>' });
  assert.equal(media.hasMedia, false);
  assert.equal(media.mediaUploadId, '');
});

test('the media attribute survives the HTML escaping', () => {
  // The attribute is HTML-escaped JSON, so it has to be unescaped before
  // it can be parsed. A parser that skipped that step would find no
  // video in any post.
  const free = freePosts();
  const withMedia = free.filter((p) => asymMedia(p).hasMedia);
  assert.equal(withMedia.length, 24, '24 of the 42 free posts carry a video');
});

// ---------------------------------------------------------------------------
// The report parser
// ---------------------------------------------------------------------------

test('every Market Pulse post yields all four market readings', () => {
  const pulses = freePosts().filter((p) => asymSeries(p.slug) === ASYM_SERIES.MARKET_PULSE);
  const incomplete = pulses.filter((p) => {
    const parsed = parseAsymArticle(p);
    return !(parsed.backdrop && parsed.trend && parsed.breadth && parsed.momentum);
  });
  assert.deepEqual(incomplete.map((p) => p.slug), [],
    'every Market Pulse post reports a backdrop, a trend, a breadth and a momentum reading');
});

test('the readings keep the sentence they came from', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.equal(parsed.trend.evidence, 'Overall Trend: Mixed');
  assert.equal(parsed.breadth.evidence, 'Overall NH/NL Breadth: Positive');
  assert.equal(parsed.momentum.evidence, 'Overall Up/Down Momentum: Mixed');
});

test('the report format changed, and the parser follows the labels', () => {
  // The 2026 posts call the backdrop "Market Backdrop" and the trend
  // "Overall Trend". The 2025-03 posts call them "Overall" and "Index
  // Trends". A parser that switched on the date would break on one of
  // them.
  const newer = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.equal(newer.backdrop.state, 'mixed');
  assert.equal(newer.trend.state, 'mixed');

  const older = parseAsymArticle(freePost('market-pulse-dd4'));
  assert.equal(older.backdrop.state, 'negative');
  assert.equal(older.trend.state, 'negative');
});

test('the cap-size breakdown is read under its metric', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.deepEqual(
    parsed.capSizes.trend.map((r) => [r.cap, r.state]),
    [['Large Cap', 'mixed'], ['Mid Cap', 'positive'], ['Small Cap', 'positive']],
  );
  assert.deepEqual(
    parsed.capSizes.breadth.map((r) => [r.cap, r.state]),
    [['Large Cap', 'positive'], ['Mid Cap', 'positive'], ['Small Cap', 'positive']],
  );
});

test('the plan sections are read in both numbering styles', () => {
  // The 2026 posts number them "1) ..." and the 2025-09 ones "1. ...".
  const paren = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.equal(paren.planSections.length, 7);
  assert.equal(paren.planSections[0].number, 1);
  assert.equal(paren.planSections[0].title, 'Market Posture');
  assert.equal(paren.planSections[0].state, 'cautiously constructive');

  const dot = parseAsymArticle(freePost('market-pulse-f25'));
  assert.ok(dot.planSections.length >= 5);
  assert.equal(dot.planSections[0].number, 1);
  assert.equal(dot.planSections[0].title, 'Trend Alignment');
});

test('the bottom line is read', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.match(parsed.bottomLine, /technical repair/);
});

test('the attachments are found', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.match(parsed.spreadsheetUrl, /docs\.google\.com\/spreadsheets\/d\/1vfSktAuZMvODVbZ6BK7DyzeO4e009yPYxzGLQko2YNo/);
  assert.equal(parsed.tc2000Url, 'https://www.tc2000.com/~Vpw8M9');
});

test('the index tickers are reported as context, not as calls', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  assert.deepEqual(parsed.indexTickers, ['IWM', 'MDY', 'QQQ', 'SPY']);
});

test('the sectors are read with their tier', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  const primary = parsed.sectors.filter((s) => s.tier === 'primary').map((s) => s.sector);
  assert.ok(primary.includes('Energy'));
  assert.ok(primary.includes('Healthcare'));
});

test('an overlapping sector alias does not report two sectors', () => {
  // "Consumer Staples" contains "Consumer", which is the alias for
  // Consumer Discretionary. Both would match, and the author named one.
  assert.deepEqual(matchSectors('Consumer Staples'), ['Consumer Staples']);
  assert.deepEqual(matchSectors('Consumer Discretionary'), ['Consumer Discretionary']);
  assert.deepEqual(matchSectors('Financial Services'), ['Financials']);
});

test('a metric label maps to its metric', () => {
  assert.equal(metricForLabel('Market Backdrop'), 'backdrop');
  assert.equal(metricForLabel('Overall'), 'backdrop');
  assert.equal(metricForLabel('Overall Trend'), 'trend');
  assert.equal(metricForLabel('Index Trends'), 'trend');
  assert.equal(metricForLabel('Overall NH/NL Breadth'), 'breadth');
  assert.equal(metricForLabel('Overall Up/Down Momentum'), 'momentum');
  assert.equal(metricForLabel('Something Else'), null);
});

test('the summary names the readings it found', () => {
  const parsed = parseAsymArticle(freePost('market-pulse-2d2'));
  const summary = summarizeAsymArticle(parsed);
  assert.match(summary, /backdrop=mixed/);
  assert.match(summary, /trend=mixed/);
  assert.match(summary, /breadth=positive/);
});

test('the block splitter keeps the tag each block came from', () => {
  const blocks = splitBlocks('<h1>Title</h1><p>Body</p><ul><li>Item</li></ul>');
  assert.deepEqual(blocks.map((b) => b.tag), ['h1', 'p', 'li']);
  assert.deepEqual(blocks.map((b) => b.text), ['Title', 'Body', 'Item']);
});

test('a label is split from its value', () => {
  assert.deepEqual(splitLabelValue('Overall Trend: Mixed'), { label: 'Overall Trend', value: 'Mixed' });
  assert.equal(splitLabelValue('no colon here'), null);
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

test('the client walks the cursor until the API stops giving one', async () => {
  const pages = [
    { posts: [{ id: 1, slug: 'a' }], nextCursor: 'CURSOR1' },
    { posts: [{ id: 2, slug: 'b' }], nextCursor: 'CURSOR2' },
    { posts: [{ id: 3, slug: 'c' }], nextCursor: '' },
  ];
  const seen = [];
  const client = createAsymClient({
    fetchImpl: async (url) => {
      seen.push(url);
      const body = pages[seen.length - 1];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });

  const walk = await client.listAllPosts();
  assert.equal(walk.posts.length, 3);
  assert.equal(walk.pages, 3);
  assert.equal(walk.complete, true);
  assert.match(seen[0], /limit=25/);
  assert.match(seen[1], /cursor=CURSOR1/);
  assert.match(seen[2], /cursor=CURSOR2/);
});

test('the client stops when it is told to, and says it did not finish', async () => {
  const client = createAsymClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ posts: [{ id: 1 }], nextCursor: 'MORE' }),
    }),
  });
  const walk = await client.listAllPosts({ maxPages: 2 });
  assert.equal(walk.pages, 2);
  assert.equal(walk.complete, false, 'a truncated walk must not claim to be complete');
});

test('a rejected request is not retried', async () => {
  // Substack answers HTTP 400 for an invalid parameter. Retrying it just
  // repeats the mistake, so it must fail immediately.
  let calls = 0;
  const client = createAsymClient({
    retries: 3,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ errors: [{ param: 'offset' }] }),
      };
    },
  });
  await assert.rejects(() => client.listPage(), /Substack request failed/);
  assert.equal(calls, 1);
});

test('a transport failure is retried', async () => {
  let calls = 0;
  const client = createAsymClient({
    retries: 3,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error('fetch failed');
      return { ok: true, status: 200, text: async () => JSON.stringify({ posts: [] }) };
    },
  });
  await client.listPage();
  assert.equal(calls, 3);
});