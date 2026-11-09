'use strict';

// Content classification for the T3Live channel.
//
// WHY THIS FILE EXISTS
//
// T3Live is different from the other sources in this project in one important
// way: it has MULTIPLE DISTINCT SHOWS with different hosts and formats. The
// Sevcik pipeline has one show and one host. The OCR pipelines (Revere,
// Qullamaggie) are purely technical and have no show concept at all.
//
// So this module does two things:
//
//   1. SHOW CLASSIFICATION — which show is this video?
//      This is computed at extraction/aggregation time from the video title.
//      No schema change is needed: the show is a derived property of the
//      title, and storing it in the database would just be storing a function
//      of data we already have.
//
//   2. QUARANTINE FILTER — should this video be skipped by default?
//      T3Live's non-market content is not yet well characterized (unlike
//      Sevcik's known "14 dni challenge" series). So the initial filter is
//      PERMISSIVE: only skip videos that are clearly non-market. The list
//      will grow from measurement.
//
// THE SHOWS
//
// Two shows are the reason the source was added, and they stay the
// high-priority ones:
//
//   "Actionable Swing Trade Ideas" (Sami Abusaad) — weekly swing calls.
//   "630 Club" (Scott Redler) — the daily pre-market show. The older title
//     spells it "Redler 6:30 Club"; that is the same show, not a new one.
//
// Three more titles repeat often enough to be a series rather than a one-off,
// and each is its own category so it is not scored as if it were one of the
// two above:
//
//   "Options In Play" — a 2020 options series, including the weekly
//     "Earnings On The Radar". No host is named in the title.
//   "Morning Call" — morning commentary, Scott's when he is named, and a
//     different show from the 630 Club (the titles do not overlap).
//   "Daily Recap" — the house end-of-day format, used by several hosts
//     from 2011 on. A format, not one person's show: the host is whoever
//     the title names, and unknown when it names nobody.
//
// Anything else that names Scott or Sami but is none of the above stays in
// the host drawer (scott_misc, sami_misc). A title that names no show and no
// host is "other".
//
// Older formats are categories too, even when the show has ended. Measured
// in the titles that were still "other" after the five series above:
// Market Wrap, How-to, a day-of-week Watch List, Pro Desk, Half-Time Report,
// Mid-Day Update, Red Dog, Black Room, Marketcast, Situation Report, Core FX,
// Conversations With A Pro Trader, Morning Game Plan, Wall Report, and
// Derrick's Weekly Market Update. A one-off title is still "other".

/**
 * Show IDs used throughout the pipeline.
 *
 * @readonly
 * @enum {string}
 */
const T3LIVE_SHOWS = {
  ACTIONABLE_SWINGS: 'actionable_swings',
  CLUB_630: '630club',
  OPTIONS_IN_PLAY: 'options_in_play',
  MORNING_CALL: 'morning_call',
  DAILY_RECAP: 'daily_recap',
  MARKET_WRAP: 'market_wrap',
  HOW_TO: 'how_to',
  WATCH_LIST: 'watch_list',
  PRO_DESK: 'pro_desk',
  HALF_TIME: 'half_time',
  MID_DAY: 'mid_day',
  RED_DOG: 'red_dog',
  BLACK_ROOM: 'black_room',
  MARKETCAST: 'marketcast',
  SITUATION_REPORT: 'situation_report',
  CORE_FX: 'core_fx',
  CONVERSATIONS: 'conversations',
  MORNING_GAME_PLAN: 'morning_game_plan',
  WALL_REPORT: 'wall_report',
  WEEKLY_UPDATE: 'weekly_update',
  SCOTT_MISC: 'scott_misc',
  SAMI_MISC: 'sami_misc',
  OTHER: 'other',
};

/**
 * Host IDs used throughout the pipeline.
 *
 * @readonly
 * @enum {string}
 */
const T3LIVE_HOSTS = {
  SAMI: 'sami',
  SCOTT: 'scott',
  DERRECK: 'derreck',
  ADAM: 'adam',
  MICHAEL: 'michael',
  UNKNOWN: 'unknown',
};

/**
 * Priority levels. Used by the aggregator to surface the most signal-rich
 * content first.
 *
 * @readonly
 * @enum {string}
 */
const T3LIVE_PRIORITY = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

/**
 * Title patterns that identify NON-MARKET or educational content.
 *
 * These grow from measurement: when we find that a recurring series produces
 * few or zero signals, we add its title pattern here.
 *
 * The initial list is SPARSE on purpose. T3Live's non-market series are not
 * yet characterized. Start permissive.
 */
const NON_MARKET_TITLE_PATTERNS = [
  // "How to" educational videos — unlikely to contain trade calls
  /\bhow\s+to\s+(?:read|trade|use|set\s+up)\b/i,
  // "Introduction to X" / "Basics of X" series
  /\b(?:intro(?:duction)?\s+to|basics\s+of|beginner(?:s)?\s+guide)\b/i,
];

/**
 * Title patterns that identify show categories, in priority order.
 *
 * The first matching pattern wins. Order matters: more specific patterns
 * before more general ones.
 */
const SHOW_PATTERNS = [
  {
    pattern: /actionable\s+swing\s+trade\s+ideas?/i,
    show: T3LIVE_SHOWS.ACTIONABLE_SWINGS,
    host: T3LIVE_HOSTS.SAMI,
    priority: T3LIVE_PRIORITY.HIGH,
  },
  // "630 Club", "630club", and the older "6:30 Club" / "6.30 Club" spelling.
  // This has to beat the Scott-name drawer: "Redler 6:30 Club" names neither
  // "Scott Redler" nor "630".
  {
    pattern: /\b630\s*club\b|\b6[:.]30\s*club\b/i,
    show: T3LIVE_SHOWS.CLUB_630,
    host: T3LIVE_HOSTS.SCOTT,
    priority: T3LIVE_PRIORITY.HIGH,
  },
  {
    pattern: /options\s+in\s+play/i,
    show: T3LIVE_SHOWS.OPTIONS_IN_PLAY,
    host: T3LIVE_HOSTS.UNKNOWN,
    priority: T3LIVE_PRIORITY.MEDIUM,
  },
  // Before the host drawers, so "Scott Redler Morning Call" is the series
  // and not scott_misc. Before nothing else: a 630 Club title that also says
  // "morning" is already taken by the pattern above.
  {
    pattern: /morning\s+call/i,
    show: T3LIVE_SHOWS.MORNING_CALL,
    host: T3LIVE_HOSTS.UNKNOWN,
    priority: T3LIVE_PRIORITY.MEDIUM,
  },
  {
    pattern: /daily\s+recap/i,
    show: T3LIVE_SHOWS.DAILY_RECAP,
    host: T3LIVE_HOSTS.UNKNOWN,
    priority: T3LIVE_PRIORITY.MEDIUM,
  },
  // Older formats. More specific titles before broader ones: a Black Room
  // open house is not a generic watch list, and "Red Dog mid-day" is Red Dog,
  // not the mid-day update. "How to" is last so it cannot swallow a series
  // whose title happens to use those words.
  { pattern: /black\s+room/i, show: T3LIVE_SHOWS.BLACK_ROOM, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /pro\s*desk/i, show: T3LIVE_SHOWS.PRO_DESK, host: T3LIVE_HOSTS.DERRECK, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /weekly\s+market\s+update/i, show: T3LIVE_SHOWS.WEEKLY_UPDATE, host: T3LIVE_HOSTS.DERRECK, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /red\s+dog/i, show: T3LIVE_SHOWS.RED_DOG, host: T3LIVE_HOSTS.SCOTT, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /half[\s-]*time\s+report/i, show: T3LIVE_SHOWS.HALF_TIME, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /marketcast/i, show: T3LIVE_SHOWS.MARKETCAST, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /conversations\s+with\s+a\s+pro/i, show: T3LIVE_SHOWS.CONVERSATIONS, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.LOW },
  { pattern: /core\s+fx/i, show: T3LIVE_SHOWS.CORE_FX, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /situation\s+report/i, show: T3LIVE_SHOWS.SITUATION_REPORT, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /wall\s+report/i, show: T3LIVE_SHOWS.WALL_REPORT, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /morning\s+game\s+plan/i, show: T3LIVE_SHOWS.MORNING_GAME_PLAN, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /market\s+wrap/i, show: T3LIVE_SHOWS.MARKET_WRAP, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /mid[\s-]*day/i, show: T3LIVE_SHOWS.MID_DAY, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /watch\s*list/i, show: T3LIVE_SHOWS.WATCH_LIST, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.MEDIUM },
  { pattern: /\bhow\s+to\b/i, show: T3LIVE_SHOWS.HOW_TO, host: T3LIVE_HOSTS.UNKNOWN, priority: T3LIVE_PRIORITY.LOW },
  {
    pattern: /\bscott\s+redler\b/i,
    show: T3LIVE_SHOWS.SCOTT_MISC,
    host: T3LIVE_HOSTS.SCOTT,
    priority: T3LIVE_PRIORITY.MEDIUM,
  },
  {
    pattern: /\bsami\s+(?:abusaad|abusa[ao]d)?\b/i,
    show: T3LIVE_SHOWS.SAMI_MISC,
    host: T3LIVE_HOSTS.SAMI,
    priority: T3LIVE_PRIORITY.MEDIUM,
  },
];

/**
 * A host named in the title, independent of which show it is.
 *
 * A series title does not always name its host ("Daily Recap" is several
 * people's show), and a host name does not always name a show. The two are
 * read separately so "Scott Redler — Daily Recap" is the recap, by Scott,
 * rather than one or the other.
 *
 * @param {string} title
 * @returns {string|null}
 */
function hostFromTitle(title) {
  if (/\bscott\s+redler\b/i.test(title)) return T3LIVE_HOSTS.SCOTT;
  if (/\bsami\s+(?:abusaad|abusa[ao]d)?\b/i.test(title)) return T3LIVE_HOSTS.SAMI;
  if (/\bderr(?:e|i)ck\b/i.test(title)) return T3LIVE_HOSTS.DERRECK;
  if (/\badam\b/i.test(title)) return T3LIVE_HOSTS.ADAM;
  if (/\bmichael\b/i.test(title)) return T3LIVE_HOSTS.MICHAEL;
  return null;
}

/**
 * Classify a T3Live video by show and host, inferred from its title.
 *
 * The first matching series wins. A host the title names overrides the
 * series' default host, so a recap Scott recorded is his and a recap that
 * names nobody stays unknown. A title that matches no series is the host's
 * miscellaneous drawer when it names Scott or Sami, and "other" otherwise.
 *
 * @param {string} title
 * @returns {{ show: string, host: string, priority: string }}
 */
function classifyT3liveVideo(title) {
  const raw = String(title || '');
  const namedHost = hostFromTitle(raw);

  for (const { pattern, show, host, priority } of SHOW_PATTERNS) {
    if (pattern.test(raw)) {
      return { show, host: namedHost || host, priority };
    }
  }

  if (namedHost === T3LIVE_HOSTS.SCOTT) {
    return { show: T3LIVE_SHOWS.SCOTT_MISC, host: namedHost, priority: T3LIVE_PRIORITY.MEDIUM };
  }
  if (namedHost === T3LIVE_HOSTS.SAMI) {
    return { show: T3LIVE_SHOWS.SAMI_MISC, host: namedHost, priority: T3LIVE_PRIORITY.MEDIUM };
  }

  return {
    show: T3LIVE_SHOWS.OTHER,
    host: namedHost || T3LIVE_HOSTS.UNKNOWN,
    priority: T3LIVE_PRIORITY.MEDIUM,
  };
}

/**
 * Should this T3Live video be skipped by the extraction pipeline?
 *
 * The filter is PERMISSIVE by design. We do not yet know which of T3Live's
 * recurring series are signal-rich and which are not. The quarantine list
 * will grow from measurement — when a known series consistently produces
 * zero signals, its title pattern is added here.
 *
 * @param {{ title?: string, video_id?: string }} video
 * @returns {{ quarantined: boolean, reason: string }}
 */
function t3liveVideoQuarantine(video) {
  const title = String((video && video.title) || '');

  if (NON_MARKET_TITLE_PATTERNS.some((re) => re.test(title))) {
    return { quarantined: true, reason: 'non_market_series' };
  }

  return { quarantined: false, reason: '' };
}

module.exports = {
  T3LIVE_SHOWS,
  T3LIVE_HOSTS,
  T3LIVE_PRIORITY,
  NON_MARKET_TITLE_PATTERNS,
  SHOW_PATTERNS,
  classifyT3liveVideo,
  t3liveVideoQuarantine,
};
