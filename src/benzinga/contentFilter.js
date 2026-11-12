'use strict';

// Content classification for the Benzinga channel.
//
// WHY AN ALLOW-LIST, AND NOT T3LIVE'S DENY-LIST
//
// T3Live is a trading channel whose hosts call trades, so its filter only
// drops the handful of titles that are clearly not market talk. Benzinga is
// a media company. Measured on the newest 150 streams and 150 videos
// (2026-11-11):
//
//   streams  76  company EARNINGS-CALL rebroadcasts   management speech
//            50  PreMarket Playbook (daily, live)      the show to read
//            16  The Drift (weekly, options)           the show to read
//             5  sponsored webinars / education
//             3  FOMC press conferences                Fed speech
//   videos  ~63  futures / market-update clips         news-anchor recaps
//            51  thematic explainers                   long-horizon picks
//            28  single-ticker small-cap clips         setups with levels
//             7  CEO interviews                        insiders' own book
//             7  education / Benzinga Pro tutorials
//
// Running the extractor over everything would publish an earnings call's
// "we expect strong growth" as a bullish call, and a CEO's pitch as a
// recommendation. So a video is EXTRACTED only when its show is on the
// allow-list, and everything else is quarantined with a reason.
//
// THE DECISION, PER SHOW
//
//   premarket_playbook  extract       PreMarket Playbook / PreMarket Prep
//   the_drift           extract       Adam Mesh & Tom Sosnoff, options
//   stock_in_play       extract       one ticker in the title, a short clip
//   explainer           extract       >= 400 s, thematic; scored at one month
//   market_update       readings      futures recaps: market readings only
//   earnings_call       quarantine    management speech (an event calendar)
//   fed_presser         quarantine    Fed speech (an event calendar)
//   interview           quarantine    CEO / founder interviews
//   education           quarantine    webinars, how-to, beginners
//   product_tutorial    quarantine    Benzinga Pro product pieces
//   short_clip          quarantine    under 70 s
//   upcoming            quarantine    not streamed yet / still live
//   other               quarantine    unclassified -- the allow-list is strict
//
// The show is a DERIVED property of the title, the duration and the live
// status, computed at run time like T3Live's. Nothing about it is stored.
//
// THE PARTNER
//
// PreMarket Playbook is often co-hosted: "PreMarket Playbook + T3 Live",
// "+ Nasdaq", "+ Cboe", "+ Direxion", "+ All Access". The T3 Live episodes
// feature people whose calls are ALSO in the t3live corpus, so the two are
// not independent; and an ETF issuer's segment is a sponsor's. The partner
// is read so the outcome analysis can split by it.

/** @readonly @enum {string} */
const BENZINGA_SHOWS = {
  PREMARKET_PLAYBOOK: 'premarket_playbook',
  THE_DRIFT: 'the_drift',
  STOCK_IN_PLAY: 'stock_in_play',
  EXPLAINER: 'explainer',
  MARKET_UPDATE: 'market_update',
  EARNINGS_CALL: 'earnings_call',
  FED_PRESSER: 'fed_presser',
  INTERVIEW: 'interview',
  PARTNER_CONTENT: 'partner_content',
  EDUCATION: 'education',
  PRODUCT_TUTORIAL: 'product_tutorial',
  SHORT_CLIP: 'short_clip',
  UPCOMING: 'upcoming',
  OTHER: 'other',
};

/** @readonly @enum {string} */
const BENZINGA_PRIORITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NONE: 'none' };

/** What the pipeline does with a show. @readonly @enum {string} */
const BENZINGA_HANDLING = {
  /** Transcribe, extract ticker signals, and read the market. */
  EXTRACT: 'extract',
  /** Transcribe and read the market only -- no ticker signals. */
  READINGS: 'readings',
  /** Do not transcribe, do not extract. */
  QUARANTINE: 'quarantine',
};

const SHOW_POLICY = {
  [BENZINGA_SHOWS.PREMARKET_PLAYBOOK]: { handling: BENZINGA_HANDLING.EXTRACT, priority: BENZINGA_PRIORITY.HIGH },
  [BENZINGA_SHOWS.THE_DRIFT]: { handling: BENZINGA_HANDLING.EXTRACT, priority: BENZINGA_PRIORITY.HIGH },
  [BENZINGA_SHOWS.STOCK_IN_PLAY]: { handling: BENZINGA_HANDLING.EXTRACT, priority: BENZINGA_PRIORITY.MEDIUM },
  [BENZINGA_SHOWS.EXPLAINER]: { handling: BENZINGA_HANDLING.EXTRACT, priority: BENZINGA_PRIORITY.MEDIUM },
  [BENZINGA_SHOWS.MARKET_UPDATE]: { handling: BENZINGA_HANDLING.READINGS, priority: BENZINGA_PRIORITY.LOW },
  [BENZINGA_SHOWS.EARNINGS_CALL]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.FED_PRESSER]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.INTERVIEW]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.PARTNER_CONTENT]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.EDUCATION]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.PRODUCT_TUTORIAL]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.SHORT_CLIP]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.UPCOMING]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
  [BENZINGA_SHOWS.OTHER]: { handling: BENZINGA_HANDLING.QUARANTINE, priority: BENZINGA_PRIORITY.NONE },
};

/** A clip shorter than this cannot carry a call worth scoring. */
const SHORT_CLIP_MAX_SECONDS = 70;

/** A prerecorded video at least this long is an explainer, not a clip. */
const EXPLAINER_MIN_SECONDS = 400;

/**
 * Titles that identify a THIRD PARTY's show, not Benzinga's own commentary.
 *
 * The channel republishes partner content: Cboe's and Nasdaq's live shows,
 * conference keynotes, webinars, conference panels. Measured on the full
 * listing (2026-11-12): of the 3,689 long stream titles, a large part is
 * partner content -- "LIVE from Cboe", "NVIDIA GTC Keynote", "Global Small
 * Cap Conference".
 *
 * That content carries calls, but they are not Benzinga's calls, and
 * scoring them as Benzinga's would misattribute them. The PreMarket and
 * The Drift patterns run FIRST, so "PreMarket Playbook + Cboe" -- which is
 * Benzinga's host with a guest -- is never caught here.
 */
const PARTNER_CONTENT_PATTERN = /\blive\s+from\b|\bkeynote\b|\bconference\b|\bsummit\b|\bwebinar\b|\b(?:\[|\()replay\)?\b|\breplay\s*[:\-]|\bunconference\b|\bbreakout\s+session\b|\bpanel\b|\bfireside\b/i;

/**
 * The PreMarket show's own length. A title carrying the show's name and a
 * length below this is a PRERECORDED CLIP of the brand, not the live show:
 * measured on the /videos tab, 1,357 titles carry the PreMarket name and
 * their median length is 17 minutes ("Top PreMarket Prep Movers Of The
 * Day 3/16", "Is Alibaba A Buy? | PreMarket Prep"). The live episodes are
 * 60-150 minutes.
 */
const PREMARKET_LIVE_MIN_SECONDS = 45 * 60;

/**
 * Title patterns, in priority order. The two shows the source is for come
 * FIRST, because their titles routinely name the things the quarantine
 * patterns look for: "Nvidia CEO Controversy ... | PreMarket Playbook" and
 * "$SPY, $QQQ Rise Ahead Of Fed Rate Decision | PreMarket Playbook".
 */
const TITLE_PATTERNS = [
  { show: BENZINGA_SHOWS.PREMARKET_PLAYBOOK, pattern: /pre-?\s*market\s+(?:playbook|prep)/i },
  { show: BENZINGA_SHOWS.THE_DRIFT, pattern: /\bthe\s+drift\b/i },
  { show: BENZINGA_SHOWS.EARNINGS_CALL, pattern: /\bearnings\s+call\b|\bconference\s+call\b/i },
  { show: BENZINGA_SHOWS.FED_PRESSER, pattern: /\bfomc\b|\bpress\s+conference\b|\brate\s+decision\b|\bpowell\s+(?:speaks|testifies|testimony)\b/i },
  { show: BENZINGA_SHOWS.INTERVIEW, pattern: /\bceo\b|\bcfo\b|\bco-?founder\b|\bexclusive\s+interview\b|\binterview\s+with\b|\bmanaging\s+(?:director|partner)\b/i },
  { show: BENZINGA_SHOWS.PRODUCT_TUTORIAL, pattern: /\bbenzinga\s+pro\b|\bnewsfeed\b|\bbest\s+tool\s+for\b|\bsquawk\b/i },
  {
    show: BENZINGA_SHOWS.EDUCATION,
    pattern: /\bfor\s+beginners\b|\bhow\s+to\s+(?:short|trade|read|use|approach|find|start|invest|buy)\b|\bintro(?:duction)?\s+to\b|\bbinary\s+(?:options|outcomes)\b|\bopinions\s+(?:in)?to\s+expectations\b|\bincome\s+investing\b|\binsights\s+from\b|\bsmart\s+money\s+flowing\b|\bthe\s+power\s+of\b|\bwebinar\b|\bmasterclass\b/i,
  },
];

/** Futures and market-recap wording: a news-anchor update, not a call. */
const MARKET_UPDATE_PATTERN = /\bfutures\b|^(?:stock\s+)?markets?\s+(?:trend|rise|rally|fall|gain|slip|drop|mixed|decline|edge|climb|sink|surge|tumble)|\bdow\s+jones\b|\bwall\s+street\b|\bstock\s+market\s+(?:today|update|news)\b/i;

/**
 * All-caps tokens in a title that are not tickers. A title is set in title
 * case, so a 2-5 letter all-caps token is almost always a symbol -- these
 * are the exceptions measured in the sampled titles.
 */
const TITLE_CAPS_STOPLIST = new Set([
  'AI', 'US', 'USA', 'UK', 'EU', 'CEO', 'CFO', 'ETF', 'ETFS', 'ATH', 'NFP', 'CPI', 'PPI', 'PCE', 'FOMC', 'GDP',
  'TV', 'IPO', 'EV', 'EVS', 'NYSE', 'PMI', 'OPEC', 'SEC', 'FED', 'DOJ', 'FDA', 'LIVE', 'WATCH', 'Q1', 'Q2', 'Q3',
  'Q4', 'FY', 'NEW', 'BIG', 'THE', 'AND', 'FOR', 'WHY', 'HOW', 'ALL', 'NOT', 'TOP', 'MAG', 'YOLO', 'DCA', 'IRA',
  'ET', 'PM', 'AM', 'OK', 'VS', 'API', 'GPU', 'GPUS', 'CHIPS', 'BTC', 'ETH', 'NASDAQ', 'OCT', 'NOV', 'DEC', 'SEPT',
  'BROKE', 'HUGE', 'NOW', 'WARNING', 'BILLION', 'TRILLION', 'MILLION',
]);

/**
 * The tickers a title names: `$CASHTAGS` first (Benzinga writes them in 102
 * of 150 stream titles), then bare all-caps tokens.
 *
 * @param {string} title
 * @returns {{cashtags: string[], bare: string[]}}
 */
function titleTickers(title) {
  const raw = String(title || '');
  const cashtags = [...new Set([...raw.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g)].map((m) => m[1]))];
  const bare = [...new Set([...raw.replace(/\$[A-Z.]+/g, ' ').matchAll(/\b([A-Z]{2,5})\b/g)]
    .map((m) => m[1])
    .filter((t) => !TITLE_CAPS_STOPLIST.has(t)))];
  return { cashtags, bare };
}

const PARTNER_ALIASES = [
  { partner: 't3live', pattern: /^t3(?:\s*live)?\b/i },
  { partner: 'nasdaq', pattern: /^nasdaq\b/i },
  { partner: 'cboe', pattern: /^cboe\b/i },
  { partner: 'direxion', pattern: /^direxion\b/i },
  { partner: 'all_access', pattern: /^all\s*access\b/i },
];

/**
 * The co-host named after "PreMarket Playbook +", or '' when there is none.
 *
 * @param {string} title
 * @returns {string}
 */
function partnerFromTitle(title) {
  const match = /pre-?\s*market\s+(?:playbook|prep)\s*\+\s*([^|]+)/i.exec(String(title || ''));
  if (!match) return '';
  const named = match[1].trim();
  for (const { partner, pattern } of PARTNER_ALIASES) if (pattern.test(named)) return partner;
  return named.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Classify a Benzinga video.
 *
 * @param {{title?: string, duration_sec?: number|null, live_status?: string|null,
 *          listing_kind?: string|null}} video
 * @returns {{show: string, handling: string, priority: string, partner: string}}
 */
function classifyBenzingaVideo(video) {
  const title = String((video && video.title) || '');
  const duration = Number(video && video.duration_sec);
  const hasDuration = Number.isFinite(duration) && duration > 0;
  const liveStatus = String((video && video.live_status) || '');
  const listingKind = String((video && video.listing_kind) || '');
  const partner = partnerFromTitle(title);

  const result = (show) => ({ show, ...SHOW_POLICY[show], partner });

  // A Shorts clip is under a minute and carries no call worth scoring.
  if (listingKind === 'shorts') return result(BENZINGA_SHOWS.SHORT_CLIP);

  // A stream that has not happened yet (or is still running) has no final
  // captions. It becomes readable once it is `was_live`.
  if (liveStatus === 'is_upcoming' || liveStatus === 'is_live' || liveStatus === 'post_live') {
    return result(BENZINGA_SHOWS.UPCOMING);
  }

  for (const { show, pattern } of TITLE_PATTERNS) {
    if (pattern.test(title)) {
      // A short piece carrying the show's name is a prerecorded clip of
      // the brand, not the live episode.
      if (show === BENZINGA_SHOWS.PREMARKET_PLAYBOOK
        && hasDuration && duration < PREMARKET_LIVE_MIN_SECONDS) {
        return result(BENZINGA_SHOWS.STOCK_IN_PLAY);
      }
      return result(show);
    }
  }

  if (hasDuration && duration < SHORT_CLIP_MAX_SECONDS) return result(BENZINGA_SHOWS.SHORT_CLIP);

  if (MARKET_UPDATE_PATTERN.test(title) && (!hasDuration || duration < EXPLAINER_MIN_SECONDS)) {
    return result(BENZINGA_SHOWS.MARKET_UPDATE);
  }

  // A third party's show -- a partner's live programme, a keynote, a
  // conference panel. It carries calls, but not Benzinga's.
  if (PARTNER_CONTENT_PATTERN.test(title)) return result(BENZINGA_SHOWS.PARTNER_CONTENT);

  if (hasDuration && duration >= EXPLAINER_MIN_SECONDS) return result(BENZINGA_SHOWS.EXPLAINER);

  const { cashtags, bare } = titleTickers(title);
  if (cashtags.length + bare.length > 0) return result(BENZINGA_SHOWS.STOCK_IN_PLAY);

  // A short clip that names no ticker is market commentary.
  if (hasDuration) return result(BENZINGA_SHOWS.MARKET_UPDATE);

  return result(BENZINGA_SHOWS.OTHER);
}

/**
 * Should this video be skipped? A video is quarantined unless its show is on
 * the allow-list. `readings` shows are NOT quarantined -- they are
 * transcribed for the market readings -- but the signal extractor skips
 * them (see `isSignalShow`).
 *
 * @param {{title?: string, duration_sec?: number|null, live_status?: string|null}} video
 * @returns {{quarantined: boolean, reason: string}}
 */
function benzingaVideoQuarantine(video) {
  const { show, handling } = classifyBenzingaVideo(video);
  if (handling === BENZINGA_HANDLING.QUARANTINE) return { quarantined: true, reason: show };
  return { quarantined: false, reason: '' };
}

/**
 * Does the ticker-signal extractor read this video?
 *
 * @param {object} video
 * @returns {boolean}
 */
function isSignalShow(video) {
  return classifyBenzingaVideo(video).handling === BENZINGA_HANDLING.EXTRACT;
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * The air date a title states, as YYYYMMDD, or '' when it states none.
 *
 * PreMarket Playbook titles end with the date the show aired, written
 * several ways: "November 9, 2026", "Nov 10, 2026", "OCT 20, 2026",
 * "September 30, 2026". A month-and-year alone ("[October 2026]") is not a
 * date and is not read.
 *
 * @param {string} title
 * @returns {string}
 */
function titleAirDate(title) {
  const raw = String(title || '');
  const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/i.exec(raw);
  let year; let month; let day;
  if (named) {
    month = MONTHS[named[1].toLowerCase()];
    day = Number(named[2]);
    year = Number(named[3]);
  } else {
    const numeric = /\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2})\b/.exec(raw);
    if (!numeric) return '';
    month = Number(numeric[1]);
    day = Number(numeric[2]);
    year = Number(numeric[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

module.exports = {
  BENZINGA_HANDLING,
  BENZINGA_PRIORITY,
  BENZINGA_SHOWS,
  EXPLAINER_MIN_SECONDS,
  SHORT_CLIP_MAX_SECONDS,
  SHOW_POLICY,
  benzingaVideoQuarantine,
  classifyBenzingaVideo,
  isSignalShow,
  partnerFromTitle,
  titleAirDate,
  titleTickers,
};
