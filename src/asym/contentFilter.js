'use strict';

// What kind of AsymTrading post this is, and whether the pipeline may read it.
//
// WHY THIS FILE EXISTS
//
// The Sevcik pipeline has one show and one host. T3Live has several, so it
// got a content filter. AsymTrading has something neither of them has: a
// PAYWALL, and a publication whose visible corpus is mostly behind it.
//
// Measured over the full archive (475 posts, 2023-03-29 to 2026-11-08):
//
//   44 of the most recent 50 posts are `only_paid`
//   42 posts in the whole corpus are free
//   of those 42, exactly 24 carry an embedded video
//
// So "free" is a genuine, narrow gate rather than a formality, and the
// free subset splits again: 24 posts with a video to transcribe and 18
// text-only posts (the 2023-2024 educational series, plus two
// `market-pulse-open-access` posts that have a body but no video).
//
// THE GATE IS THE POST'S OWN AUDIENCE FIELD
//
// Substack reports `audience: 'everyone'` for a post anybody may read and
// `audience: 'only_paid'` for a subscriber-only one. That field is the
// publication's own statement about access, and it is the thing the API
// enforces: for a paid post, `body_html` comes back EMPTY and only
// `truncated_body_text` (a 309-character teaser) is present.
//
// So the gate has two independent parts, and a post must pass both:
//
//   1. `audience !== 'only_paid'`  -- the publication says it is free
//   2. the body is actually present -- and we can prove we did not get a
//      teaser where a body was expected
//
// Part 2 is not redundant. Part 1 is a claim; part 2 is the receipt.
//
// WHAT THIS FILE DOES NOT DO
//
// It does not attempt to reach paid content. There is no "subscriber mode"
// here, no cookie handling, and no scraping of a logged-in session. If the
// user later subscribes and wants their own access to be used, that is a
// separate, explicit feature -- and it would have to be built on the user's
// own credentials, never on a bypass.

/**
 * The audience values Substack reports.
 *
 * @readonly
 * @enum {string}
 */
const ASYM_AUDIENCE = {
  EVERYONE: 'everyone',
  ONLY_PAID: 'only_paid',
  FOUNDERS: 'founders',
};

/**
 * The post series this publication publishes.
 *
 * @readonly
 * @enum {string}
 */
const ASYM_SERIES = {
  /** The weekly "Market Pulse": market recap, sector analysis, setups. */
  MARKET_PULSE: 'market_pulse',
  /** "Momentum Movers" -- a 2025 series of morning posts. */
  MOMENTUM_MOVERS: 'momentum_movers',
  /** "Learning Together" -- a 2024 series. */
  LEARNING_TOGETHER: 'learning_together',
  /** "6 Steps to Profitable Swing Trading" -- a 2023 educational series. */
  SWING_TRADING_COURSE: 'swing_trading_course',
  /** "Top Trader Profile" -- a 2023 series about other traders. */
  TRADER_PROFILE: 'trader_profile',
  /** "Market Breadth Monitor" -- a 2023 post. */
  MARKET_BREADTH_MONITOR: 'market_breadth_monitor',
  /** "Gotta Get Started Somewhere" / "Coming Soon" -- pre-launch posts. */
  PRELAUNCH: 'prelaunch',
  /** "Market Monitor" -- the breadth/momentum data posts. */
  MARKET_MONITOR: 'market_monitor',
  /** "Focus List" -- the watchlist posts. */
  FOCUS_LIST: 'focus_list',
  /** "Post Mortem" -- the review of one closed trade. */
  POST_MORTEM: 'post_mortem',
  /** "Market Dashboard" -- a one-off dashboard post. */
  MARKET_DASHBOARD: 'market_dashboard',
  /** The standalone essays: psychology, risk, drawdowns, watchlists. */
  ESSAY: 'essay',
  /** A "copy-" duplicate of another series. */
  COPY: 'copy',
  /** Anything not matched above. */
  OTHER: 'other',
};

/**
 * The standalone essays.
 *
 * They are a handful of long-form posts about trading psychology, risk and
 * position sizing. Each has a long distinct slug and no common prefix, so
 * they are listed rather than pattern-matched.
 */
const ESSAY_SLUGS = new Set([
  'using-your-watchlist-as-a-market',
  'understanding-drawdowns-in-trading',
  'the-power-of-framing-and-words-in',
  'the-mindset-difference-amateurs-vs',
  'the-danger-of-trying-to-be-right',
  'the-art-of-setting-stop-losses',
]);

/**
 * Series that carry no tradeable market commentary.
 *
 * The 2023-2024 educational series are free, so they pass the paywall gate,
 * but they are not market calls: "6 Steps to Profitable Swing Trading" is a
 * course, and "Top Trader Profile" is about somebody else. Ingesting them
 * as if they were market views would put noise into the same tables as real
 * calls, so they are quarantined -- the same treatment the T3Live filter
 * gives its non-market series.
 */
const NON_MARKET_SERIES = new Set([
  ASYM_SERIES.SWING_TRADING_COURSE,
  ASYM_SERIES.TRADER_PROFILE,
  ASYM_SERIES.PRELAUNCH,
  ASYM_SERIES.ESSAY,
]);

/**
 * The series a post belongs to, from its slug.
 *
 * The SLUG is used rather than the title because the title is "Market Pulse"
 * for every post in the main series, while the slug carries the series name
 * for the older ones. The slug's random suffix is stripped first, because
 * `market-pulse-open-access-bf1` and `6-steps-to-profitable-swing-trading-718`
 * are the same series as their unsuffixed siblings.
 *
 * @param {string} slug
 * @returns {string} one of ASYM_SERIES
 */
function asymSeries(slug) {
  const raw = String(slug || '').trim().toLowerCase();
  if (!raw) return ASYM_SERIES.OTHER;

  if (raw.startsWith('market-pulse')) return ASYM_SERIES.MARKET_PULSE;
  if (raw.startsWith('momentum-movers')) return ASYM_SERIES.MOMENTUM_MOVERS;
  if (raw.startsWith('learning-together')) return ASYM_SERIES.LEARNING_TOGETHER;
  if (raw.startsWith('6-steps-to-profitable-swing-trading')) return ASYM_SERIES.SWING_TRADING_COURSE;
  if (raw.startsWith('top-trader-profile')) return ASYM_SERIES.TRADER_PROFILE;
  if (raw.startsWith('market-breadth-monitor')) return ASYM_SERIES.MARKET_BREADTH_MONITOR;
  if (raw.startsWith('gotta-get-started-somewhere') || raw.startsWith('coming-soon')) {
    return ASYM_SERIES.PRELAUNCH;
  }
  // A "copy-" slug is a duplicate of another post's series. It is
  // identified BEFORE the series it copies, because "copy-market-pulse-347"
  // starts with neither "market-pulse" nor "momentum-movers" but is a copy.
  if (raw.startsWith('copy-')) {
    return ASYM_SERIES.COPY;
  }
  if (raw.startsWith('market-monitor')) return ASYM_SERIES.MARKET_MONITOR;
  if (raw.startsWith('focus-list')) return ASYM_SERIES.FOCUS_LIST;
  if (raw.startsWith('post-mortem')) return ASYM_SERIES.POST_MORTEM;
  if (raw.startsWith('market-dashboard')) return ASYM_SERIES.MARKET_DASHBOARD;
  // The standalone essays have long, distinct titles and no common
  // prefix, so they are recognised by a list rather than a pattern.
  if (ESSAY_SLUGS.has(raw)) return ASYM_SERIES.ESSAY;
  return ASYM_SERIES.OTHER;
}

/**
 * May the pipeline read this post's body?
 *
 * Two independent checks, and a post must pass both. The first is the
 * publication's own access statement; the second is the receipt -- the body
 * actually being there.
 *
 * @param {object} post - a post object from the Substack API
 * @returns {{ readable: boolean, reason: string }}
 */
function asymAccess(post) {
  const source = post || {};
  const audience = String(source.audience || '').toLowerCase();
  const body = typeof source.body_html === 'string' ? source.body_html : '';
  const teaser = typeof source.truncated_body_text === 'string' ? source.truncated_body_text : '';

  if (audience === ASYM_AUDIENCE.ONLY_PAID) {
    return { readable: false, reason: 'paywalled' };
  }
  if (audience && audience !== ASYM_AUDIENCE.EVERYONE && audience !== ASYM_AUDIENCE.FOUNDERS) {
    // An audience we do not recognise is not an access grant.
    return { readable: false, reason: `unknown_audience:${audience}` };
  }
  if (!body.trim()) {
    // Free by the publication's own account, but there is no body to read --
    // either the post is empty (the 2023 "Coming Soon" post has three words)
    // or the endpoint served a teaser instead.
    return { readable: false, reason: teaser.trim() ? 'teaser_only' : 'empty_body' };
  }
  return { readable: true, reason: 'free' };
}

/**
 * Should this post be skipped by the extraction pipeline?
 *
 * The filter is PERMISSIVE, like the T3Live one: a post is quarantined only
 * when it is known to carry no market commentary. The known non-market
 * series are listed above; the rest are read.
 *
 * @param {object} post - a post object from the Substack API
 * @returns {{ quarantined: boolean, reason: string, series: string }}
 */
function asymPostQuarantine(post) {
  const source = post || {};
  const series = asymSeries(source.slug);

  if (NON_MARKET_SERIES.has(series)) {
    return { quarantined: true, reason: `non_market_series:${series}`, series };
  }
  return { quarantined: false, reason: '', series };
}

/**
 * Does this post carry an embedded video, and WHICH one?
 *
 * The video is not in the API's `body_html` as markup: Substack stores it as
 * a `native-video-embed` div whose `data-attrs` attribute holds
 * `{"mediaUploadId":"<uuid>","duration":null}` with the JSON HTML-escaped.
 * The rendered page carries the same id as `data-media-upload-id`.
 *
 * A post can carry MORE THAN ONE `data-attrs` block, and only some of them
 * are videos -- the others are images and tweet embeds, which have a `src`
 * instead of a `mediaUploadId`. So every `data-attrs` block is read, and
 * the ones that carry a media-upload id are collected.
 *
 * 24 of the 42 free posts have one; the 18 that do not are the 2023-2024
 * text-only series plus two `market-pulse-open-access` posts.
 *
 * `mediaUploadId` stays the FIRST id, because that is what the rest of the
 * pipeline has always used and changing it would change which video a
 * post is scored on. `mediaUploadIds` is the whole list, for the case where
 * a post genuinely carries more than one video.
 *
 * @param {object} post - a post object from the Substack API
 * @returns {{ hasMedia: boolean, mediaUploadId: string, mediaUploadIds: string[] }}
 */
function asymMedia(post) {
  const body = typeof (post || {}).body_html === 'string' ? post.body_html : '';
  const ids = [];
  const seen = new Set();

  // Every `data-attrs` block, double-quoted or single-quoted.
  for (const match of body.matchAll(/data-attrs=(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = match[1] !== undefined ? match[1] : match[2];
    if (typeof raw !== 'string' || !raw) continue;

    // The attribute is HTML-escaped JSON, so it has to be unescaped before
    // it can be parsed. `&quot;` is the escape that actually occurs here.
    const decoded = raw
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');

    let attrs = null;
    try {
      attrs = JSON.parse(decoded);
    } catch {
      // A block that is not JSON is not a video block.
      continue;
    }
    const id = attrs && typeof attrs.mediaUploadId === 'string' ? attrs.mediaUploadId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return { hasMedia: ids.length > 0, mediaUploadId: ids[0] || '', mediaUploadIds: ids };
}

module.exports = {
  ASYM_AUDIENCE,
  ASYM_SERIES,
  NON_MARKET_SERIES,
  asymAccess,
  asymMedia,
  asymPostQuarantine,
  asymSeries,
};