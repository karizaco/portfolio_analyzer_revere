'use strict';

// Content classification for the FundedMind channel.
//
// THE DATE AND HOST ARE IN THE TITLE
//
// Measured on the 465-stream listing (2026-11-18): flat playlist rows have
// no upload_date. Almost every live title ends in a Czech calendar date
// ("13.11. 2026" or "8.10.2026") after the host name. That date is the
// SESSION date. The host sits between the "|" and the date.
//
// SHOW KINDS (streams, measured)
//
//   live_trading      314   "Live Trading | …", "LiveTrading | …"
//   focus             109   "Sunday Focus | …", "Monday Focus | …"
//   market_structure    6   "Market Structure LiveTrading | …"
//   gold                6   "Gold Trading | …"
//   macro               6   "Macro Monday | …"
//   event               1+  tournament / floor / Charts and Chill
//   other              23
//
// The /videos tab is a different product: education, psychology, prop-firm
// guides and FM Interview podcasts. Those are stored and quarantined from
// the forward-signal / transcript extract path.

/** Session / show kinds used throughout the FundedMind path. */
const FUNDEDMIND_KINDS = Object.freeze({
  LIVE_TRADING: 'live_trading',
  FOCUS: 'focus',
  MARKET_STRUCTURE: 'market_structure',
  GOLD: 'gold',
  MACRO: 'macro',
  EVENT: 'event',
  WEEK_RECAP: 'week_recap',
  INTERVIEW: 'interview',
  EDUCATION: 'education',
  OTHER: 'other',
});

/** Kinds that are eligible for the transcript extract path by default. */
// Measured empty: no YT captions and Deepgram returned no utterances (music/silence).
const HARD_SKIP_VIDEO_IDS = new Set([
  // Empty/silent (no captions + empty Deepgram).
  'VjyKk33u0Jw',
  // Confirmed unavailable on YouTube (2026-11-19 catalog leftovers).
  'HOjvIVUsDGY',
  'MpTPITV6drw',
  '_Lbi6yY2DCU',
  'e6qmC94uujs',
  'i3_Pl6RV06E',
  'iDgReFnBJVQ',
  'lCuY46u5eNU',
]);

const EXTRACT_ELIGIBLE_KINDS = new Set([
  FUNDEDMIND_KINDS.LIVE_TRADING,
  FUNDEDMIND_KINDS.FOCUS,
  FUNDEDMIND_KINDS.MARKET_STRUCTURE,
  FUNDEDMIND_KINDS.GOLD,
  FUNDEDMIND_KINDS.MACRO,
  FUNDEDMIND_KINDS.WEEK_RECAP,
]);

const DATE_AT_END = /(\d{1,2})\.\s*(\d{1,2})\.*\s*(20\d{2})\s*$/;
// Older Week Recap titles often omit the year: "Week Recap  Petr 15.11."
const DATE_AT_END_NO_YEAR = /(\d{1,2})\.\s*(\d{1,2})\.?\s*$/;

/**
 * The session date in a title, as YYYYMMDD, or '' when the title has none.
 *
 * Accepts Czech day.month forms used on this channel:
 *   "… 13.11. 2026", "… 8.10.2026", "… 1.11. 2026"
 *
 * @param {string} title
 * @returns {string}
 */
function dateFromTitle(title, options = {}) {
  const text = String(title || '').trim();
  const match = text.match(DATE_AT_END);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return '';
    return `${match[3]}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  }

  // Incomplete day.month (no year) — borrow year from upload_date / fallbackYear.
  // Measured on older Week Recaps: "Week Recap  Petr 15.11." with upload 20241116.
  const soft = text.match(DATE_AT_END_NO_YEAR);
  if (!soft) return '';
  const day = Number(soft[1]);
  const month = Number(soft[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return '';

  let year = '';
  if (options && options.fallbackYear) {
    year = String(options.fallbackYear);
  } else if (options && options.uploadDate && /^\d{8}$/.test(String(options.uploadDate))) {
    year = String(options.uploadDate).slice(0, 4);
  }
  if (!/^20\d{2}$/.test(year)) return '';
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * The host name in a title, or '' when none can be read.
 *
 * "Live Trading | Oliver Pátek 13.11. 2026" → "Oliver Pátek"
 * "Sunday Focus | Petr Můčka 15.11. 2026" → "Petr Můčka"
 * Joint hosts keep the full string ("Petr Můčka & Daniel Hvězda").
 *
 * @param {string} title
 * @returns {string}
 */
// Catalog titles sometimes drop diacritics / middle syllables
// ("Petr Mka", "Daniel Valchá"). Canonicalize known hosts only.
const HOST_ALIASES = Object.freeze([
  { match: /^petr\s+mka$/i, host: 'Petr Můčka' },
  { match: /^daniel\s+valchá$/i, host: 'Daniel Valchář' },
  { match: /^daniel\s+valcha$/i, host: 'Daniel Valchář' },
  { match: /^michal$/i, host: 'Michal Veselovský' },
  { match: /^petr$/i, host: 'Petr Můčka' },
  { match: /^honza$/i, host: 'Honza' },
  { match: /^oliver$/i, host: 'Oliver Pátek' },
]);

function normalizeHost(name) {
  const cleaned = String(name || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  for (const row of HOST_ALIASES) {
    if (row.match.test(cleaned)) return row.host;
  }
  return cleaned;
}

/**
 * Host on the LEFT of the pipe for older title shapes:
 *   "Live trading - Michal Veselovský | 8.5. 2025"
 *   "Livetrading session🔴 Michal | 19.9.2024"
 *   "Sunday Focus - Petr Můčka | 11.5. 2025"
 */
function hostFromHead(head) {
  let h = String(head || '');
  h = h.replace(/[🔴🔵]/gu, ' ');
  const withoutEmoji = h;
  const stripped = h.replace(
    /^(?:Live\s*trading|Livetrading|Sunday\s+Focus|Monday\s+Focus|Gold\s+Trading|Macro\s+Monday|Market\s+Structure(?:\s+LiveTrading)?|Week\s+Recap)(?:\s+session)?\s*/i,
    '',
  );
  if (stripped === withoutEmoji) return '';
  h = stripped;
  h = h.replace(/^[\s\-–—:]+/, '').replace(/\s+/g, ' ').trim();
  h = h.replace(DATE_AT_END, '').replace(/\s+/g, ' ').trim();
  h = h.replace(DATE_AT_END_NO_YEAR, '').replace(/\s+/g, ' ').trim();
  h = h.replace(/\d{1,2}\.\s*\d{1,2}\.?\s*\d{1,2}:\d{2}\s*$/u, '').trim();
  return h;
}

function hostFromTitle(title) {
  const text = String(title || '').trim();
  const parts = text.split('|');
  if (parts.length >= 2) {
    const tail = parts.slice(1).join('|').trim();
    // Strip full or yearless dates from the tail before reading the host.
    const tailHost = tail
      .replace(DATE_AT_END, '')
      .replace(DATE_AT_END_NO_YEAR, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Modern: "Live Trading | Oliver Pátek 13.11. 2026"
    if (tailHost && !/^\d/.test(tailHost)) return normalizeHost(tailHost);
    // Older: host left of pipe, date-only right of pipe
    const headHost = hostFromHead(parts[0]);
    if (headHost) return normalizeHost(headHost);
  }
  // No pipe (older Week Recaps): "Week Recap  Petr 22.11.2024"
  const bare = hostFromHead(text);
  if (bare) return normalizeHost(bare);
  return '';
}

/**
 * The show / session kind for a title.
 *
 * Order matters: more specific phrases win before the generic Live Trading
 * match (Market Structure LiveTrading is not plain live_trading).
 *
 * @param {string} title
 * @returns {string}
 */
function sessionKind(title) {
  const t = String(title || '');
  if (/FM\s*Interview|\bInterview\b/i.test(t)) return FUNDEDMIND_KINDS.INTERVIEW;
  if (/Psychologie\s+tradingu|Průvodce\s+prop|Pruvodce\s+prop|ROAD\s+TO\s+PAYOUT|Road\s+to\s+Payout|prop\s+firm|payout|emoce\s+stoj/i.test(t)) {
    return FUNDEDMIND_KINDS.EDUCATION;
  }
  if (/turnaj|Finále|Finale|Mastermind|Charts\s+and\s+Chill|trading\s+flooru/i.test(t)) {
    return FUNDEDMIND_KINDS.EVENT;
  }
  if (/Macro\s+Monday/i.test(t)) return FUNDEDMIND_KINDS.MACRO;
  if (/Gold\s+Trading/i.test(t)) return FUNDEDMIND_KINDS.GOLD;
  if (/Market\s+Structure/i.test(t)) return FUNDEDMIND_KINDS.MARKET_STRUCTURE;
  if (/(?:Sunday|Monday)\s+Focus/i.test(t)) return FUNDEDMIND_KINDS.FOCUS;
  if (/Week\s*Recap/i.test(t)) return FUNDEDMIND_KINDS.WEEK_RECAP;
  if (/Live\s*Trading|LiveTrading/i.test(t)) return FUNDEDMIND_KINDS.LIVE_TRADING;
  return FUNDEDMIND_KINDS.OTHER;
}

/**
 * Should this catalog row be skipped by the transcript and extract paths?
 *
 * Live trading desks, focus sessions, gold, market-structure and macro
 * streams are eligible. Interviews, education, floor events and residual
 * "other" titles are stored in the catalog but not pulled into the
 * extract queue by default.
 *
 * @param {{title?: string}} video
 * @returns {{quarantined: boolean, reason: string, kind: string, host: string, sessionDate: string}}
 */
/**
 * Calendar YYYYMMDD in the local timezone of `now` (default: Asia/Bangkok wall clock).
 * @param {Date} [now]
 * @returns {string}
 */
function calendarDayYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}${get('month')}${get('day')}`;
}

/**
 * True when the title's session date is strictly after today (scheduled upcoming live).
 * @param {string} title
 * @param {Date} [now]
 * @returns {boolean}
 */
function isUpcomingSession(title, now = new Date(), options = {}) {
  const sessionDate = dateFromTitle(title, options);
  if (!sessionDate) return false;
  // Same calendar day still counts as upcoming for the transcript queue:
  // measured 2026-11-19 on RijsTvSxiP4 ("… 19.11. 2026") — title date was
  // today while yt-dlp still said the live would begin in 11 hours.
  return sessionDate >= calendarDayYmd(now);
}

/**
 * Should this video be pulled into the default extract / transcript queue?
 *
 * Live trading desks, focus sessions, gold, market-structure and macro
 * streams are eligible. Interviews, education, floor events and residual
 * "other" titles are stored in the catalog but not pulled into the
 * extract queue by default. Scheduled futures (title date still ahead)
 * are also held out until they actually air.
 *
 * @param {{title?: string}} video
 * @returns {{quarantined: boolean, reason: string, kind: string, host: string, sessionDate: string}}
 */
function fundedmindVideoQuarantine(video) {
  const title = (video && video.title) || '';
  const kind = sessionKind(title);
  const host = hostFromTitle(title);
  const sessionDate = dateFromTitle(title, {
    uploadDate: video && video.upload_date ? String(video.upload_date) : '',
  });
  const videoId = video && video.video_id ? String(video.video_id) : '';
  if (videoId && HARD_SKIP_VIDEO_IDS.has(videoId)) {
    return {
      quarantined: true,
      reason: 'fundedmind hard_skip empty_or_silent',
      kind,
      host,
      sessionDate,
    };
  }
  if (isUpcomingSession(title)) {
    return {
      quarantined: true,
      reason: `fundedmind upcoming sessionDate=${sessionDate}`,
      kind,
      host,
      sessionDate,
    };
  }
  if (EXTRACT_ELIGIBLE_KINDS.has(kind)) {
    return { quarantined: false, reason: '', kind, host, sessionDate };
  }
  return {
    quarantined: true,
    reason: `fundedmind kind=${kind}`,
    kind,
    host,
    sessionDate,
  };
}

module.exports = {
  HARD_SKIP_VIDEO_IDS,
  EXTRACT_ELIGIBLE_KINDS,
  FUNDEDMIND_KINDS,
  calendarDayYmd,
  dateFromTitle,
  fundedmindVideoQuarantine,
  hostFromTitle,
  isUpcomingSession,
  sessionKind,
};
