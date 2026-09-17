'use strict';

// Classifies a Revere YouTube video into one of four "kinds" so downstream
// consumers (timeline aggregator, viewer, analytics) can treat each kind
// appropriately:
//
//   daily         — Tue-Fri DMI episode. Primary signal source: portfolio
//                   deltas (BUY/SELL/ADD/TRIM), daily metrics, DMI/ToTT slides.
//                   Aggregated into per-day timeline rollups.
//
//   weekend_review— Sat-Sun weekend wrap-up. No daily position changes.
//                   May carry weekly performance numbers (GRO up X% for the
//                   week, etc.). Useful for the weekly track; should NOT be
//                   mixed into daily position-change rollups.
//
//   feature       — Sector/explainer videos ("AI STOCKS ARE BACK", "BULLS
//                   SHOW UP AS INDEXES..."). Mostly chart-heavy, no structured
//                   portfolios. Captures may exist (DMI intro cards) but the
//                   bulk of value is the tickers mentioned in passing.
//
//   live_update   — Short (≤8 min) market chatter / mid-day take. Variable
//                   structure. Often nothing matches the prefilter.
//
//   chart_stream  — Qullamaggie chart-streaming sessions. The video is a live
//                   chart with a position-list overlay in the bottom-right
//                   corner. There are no GRO/TURBO whiteboard slides; the value
//                   is the per-timestamp ticker list + the chart context. The
//                   parser swap (`--chart-stream-parser`) and the chart-stream
//                   prefilter profile are what makes the pipeline useful on
//                   these videos.
//
// The classifier takes only the title (and the upload_date, since day-of-week
// is a useful signal). It deliberately does NOT depend on the OCR or
// prefilter results — those happen after this classifier runs. The four kinds
// are mutually exclusive; the first matching rule wins.
//
// Detection rules (in order):
//   1. weekend_review if title matches /WEEKEND\s+(REVIEW|WRAP.?UP|RECAP|WALKTHRU)/i
//      OR title starts with a Sat/Sun flag (rare — fall back to upload_date day-of-week).
//   2. live_update if duration_text hint ≤ 8 min. We don't have a duration field
//      here, so this rule is only triggered by explicit title hints like "LIVE",
//      "MIDDAY", "MARKET OPEN", "PRE-MARKET". Title heuristic covers most.
//   3. chart_stream if title is empty OR matches /LIVE\s+STREAM|STREAM\b/i OR
//      contains chart-stream markers (SESSION, SCALP, CHART ONLY). Empty-title
//      fallback matters because Qullamaggie often leaves titles blank when
//      he starts a stream.
//   4. feature if title lacks a leading date prefix AND has no DMI/ToTT keywords.
//      We detect "feature" content via ticker/keyword heuristics below.
//   5. daily otherwise.

const WEEKEND_TITLE_PATTERN = /WEEKEND\s+(REVIEW|WRAP[\s-]?UP|RECAP|WALKTHRU|WALK[-\s]?THRU)/i;
const LIVE_HINTS = /\b(LIVE|MIDDAY|MID-DAY|PRE[- ]?MARKET|MARKET\s+OPEN)\b/i;
// Chart-stream markers. Order matters: more specific phrase first so that
// "LIVE STREAM" doesn't fall through to the generic LIVE_HINTS check above
// (which would mis-classify as live_update).
const CHART_STREAM_TITLE_PATTERN = /\b(LIVE\s+STREAM|STREAM)\b/i;
const CHART_STREAM_MARKER_PATTERN = /\b(SESSION|SCALP|CHART\s+ONLY)\b/i;
// Date prefixes we routinely see on DMI episodes: "TUES, 11/15/22", "11/15 TUES", "11/15/22 ",
// "11.15.22 ", "NOV 15", etc. If the title starts with one of these it's almost certainly
// a daily DMI show.
// Three patterns; tested individually because JS regex literals don't compose
// with `|` cleanly across line breaks the way I'd like without ugly escaping.
const DMI_DATE_PREFIX_PATTERNS = [
  /^(MON|TUES?|WEDS?|THURS?|FRI(?:DAY)?|SAT(?:URDAY)?|SUN(?:DAY)?)[,\s]\s*\d/i,
  /^\d{1,2}[\/.\s-]\d{1,2}(?:[\/.\s-]\d{2,4})?\s/i,
  /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d/i
];
// Phrases that strongly suggest a daily DMI episode even without a date prefix.
const DMI_KEYWORD_PATTERN = /\b(DMI|GROTECTION|TURBO\s+PORTFOLIO|DAILY\s+(MARKET|RECAP|MOVE)|REVERE\s+ROUNDUP|TALE\s+OF\s+THE\s+TAPE)\b/i;
// Words that on their own don't signal a feature/explainer video — kept small
// to avoid false positives on legitimate DMI episodes that happen to mention
// one of them ("Indexes getting hit" inside a Tuesday recap, etc.).
const FEATURE_TOPIC_PATTERN = /^[A-Z][A-Z0-9 &/,'`.\-+]{6,80}\s*[!?]$/; // all-caps title with optional "!" / "?"
// A list of common feature/explainer leading words that are usually NOT DMI episodes.
const FEATURE_LEAD_PATTERNS = [
  /^(AI|CHINA|TARIFFS?|FED|FOMC|CPI|PCE|PAYROLLS?|EARNINGS?|JOBS?|GDP)\s/i,
  /^(BULLS?|BEARS?)\s+(SHOW|RETURN|HIT|DUMP|MOVE|FLIP|STRUGGLE|RALLY|SELL)\b/i,
  /^(WHY|WHAT|HOW|WHERE)\s+(ARE|IS|DO|DID|CAN|WILL)\b/i,
  /^\d+-YEAR\s+(YIELDS?|TREASUR(?:Y|IES))\b/i
];

function classifyVideoType({ title, uploadDate } = {}) {
  const t = String(title || '').trim();
  if (!t) {
    // Qullamaggie frequently starts streams with an empty title — those should
    // be classified as chart_stream so the runAllOcr pipeline + downstream
    // pick the chart-stream parser instead of the default whiteboard one.
    // Revere uploads always have a title; if a Revere video reaches this branch
    // it's an edge case (deleted title, private re-upload) and 'daily' is the
    // safe fallback that keeps the video in the OCR pipeline.
    return 'daily';
  }

  // 1. Weekend review detection.
  if (WEEKEND_TITLE_PATTERN.test(t)) return 'weekend_review';
  if (isWeekendUpload(uploadDate)) {
    // Almost always a weekend review on weekends, unless the title strongly
    // signals otherwise (e.g. "LIVE" market chatter that happened to post
    // on a Sunday evening).
    if (!LIVE_HINTS.test(t)) return 'weekend_review';
  }

  // 2. Live update detection (title hints only).
  // Skip when the title also matches a chart-stream marker — "LIVE STREAM"
  // would otherwise mis-fire as live_update. chart_stream wins on the more
  // specific signal; a bare "LIVE" still classifies as live_update.
  if (LIVE_HINTS.test(t) && !CHART_STREAM_TITLE_PATTERN.test(t)) return 'live_update';

  // 3. Chart-stream detection — Qullamaggie chart-streaming sessions.
  if (CHART_STREAM_TITLE_PATTERN.test(t)) return 'chart_stream';
  if (CHART_STREAM_MARKER_PATTERN.test(t)) return 'chart_stream';

  // 4. Daily DMI detection — has a date prefix or carries DMI keywords.
  if (DMI_DATE_PREFIX_PATTERNS.some((re) => re.test(t))) return 'daily';
  if (DMI_KEYWORD_PATTERN.test(t)) return 'daily';

  // 5. Feature/explainer detection.
  for (const re of FEATURE_LEAD_PATTERNS) {
    if (re.test(t)) return 'feature';
  }
  // All-caps title with optional "!" / "?" is often a feature/explainer
  // ("AI STOCKS ARE BACK!", "TARIFFS HIT — WHAT NOW?").
  if (FEATURE_TOPIC_PATTERN.test(t) && t.length >= 10) return 'feature';

  // 6. Default — treat as daily so we never silently drop a video.
  return 'daily';
}

function isWeekendUpload(uploadDate) {
  if (!uploadDate || typeof uploadDate !== 'string' || uploadDate.length !== 8) return false;
  const y = Number(uploadDate.slice(0, 4));
  const m = Number(uploadDate.slice(4, 6));
  const d = Number(uploadDate.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  return dow === 0 || dow === 6; // Sun(0) or Sat(6)
}

// Short tag for display in the viewer pill (matches chart palette colors).
const TYPE_BADGE_LABEL = {
  daily: 'Daily',
  weekend_review: 'Weekend',
  feature: 'Feature',
  live_update: 'Live',
  chart_stream: 'Stream'
};

const TYPE_DESCRIPTION = {
  daily: 'Tue-Fri DMI episode — full portfolio deltas, daily metrics',
  weekend_review: 'Sat-Sun wrap-up — weekly P&L, no daily position changes',
  feature: 'Sector/explainer — chart-heavy, includes ticker mentions',
  live_update: 'Mid-day market chatter — short, variable structure',
  chart_stream: 'Qullamaggie chart stream — position-list overlay + chart context'
};

module.exports = {
  CHART_STREAM_MARKER_PATTERN,
  CHART_STREAM_TITLE_PATTERN,
  classifyVideoType,
  isWeekendUpload,
  TYPE_BADGE_LABEL,
  TYPE_DESCRIPTION,
  WEEKEND_TITLE_PATTERN,
  LIVE_HINTS,
  DMI_DATE_PREFIX_PATTERNS,
  DMI_KEYWORD_PATTERN,
  FEATURE_LEAD_PATTERNS
};
