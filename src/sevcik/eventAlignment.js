'use strict';

// Event-time alignment for Sevcik claims.
//
// The claim is spoken at a segment inside a stream. The market can only be
// traded AFTER that moment is known. For daily bars this module derives:
//
//   claim_date            calendar day of the stream (upload_date)
//   claim_clock           approximate local clock from event_time_sec
//   venue                 US | PR | DE | CRYPTO | UNKNOWN
//   executable_date       first regular session open AFTER the claim day
//   alignment_confidence  high | medium | low | none
//
// Rules (daily, conservative):
//   - missing upload_date => unaligned
//   - executable = next regular session after claim_date (never claim day)
//   - weekends and a simple holiday set are skipped
//   - high confidence only when venue is known AND segment time is present

const { yahooSymbolFor } = require('./outcomeAnalysis');

/** Fixed holidays used for session-day walks (YYYY-MM-DD). Good enough for daily bars. */
const HOLIDAYS = {
  US: new Set([
    // 2020-2026 major US equity holidays (observed where applicable, simplified)
    '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10', '2020-05-25', '2020-07-03',
    '2020-09-07', '2020-11-26', '2020-12-25',
    '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31', '2021-07-05',
    '2021-09-06', '2021-11-25', '2021-12-24',
    '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20', '2022-07-04',
    '2022-09-05', '2022-11-24', '2022-12-26',
    '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19',
    '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
    '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19',
    '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19',
    '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ]),
  PR: new Set([
    // Czech public holidays (common equity closures)
    '2020-01-01', '2020-04-10', '2020-04-13', '2020-05-01', '2020-05-08', '2020-07-05',
    '2020-07-06', '2020-09-28', '2020-10-28', '2020-11-17', '2020-12-24', '2020-12-25', '2020-12-26',
    '2021-01-01', '2021-04-02', '2021-04-05', '2021-05-01', '2021-05-08', '2021-07-05',
    '2021-07-06', '2021-09-28', '2021-10-28', '2021-11-17', '2021-12-24', '2021-12-25', '2021-12-26',
    '2022-01-01', '2022-04-15', '2022-04-18', '2022-05-01', '2022-05-08', '2022-07-05',
    '2022-07-06', '2022-09-28', '2022-10-28', '2022-11-17', '2022-12-24', '2022-12-25', '2022-12-26',
    '2023-01-01', '2023-04-07', '2023-04-10', '2023-05-01', '2023-05-08', '2023-07-05',
    '2023-07-06', '2023-09-28', '2023-10-28', '2023-11-17', '2023-12-24', '2023-12-25', '2023-12-26',
    '2024-01-01', '2024-03-29', '2024-04-01', '2024-05-01', '2024-05-08', '2024-07-05',
    '2024-07-06', '2024-09-28', '2024-10-28', '2024-11-17', '2024-12-24', '2024-12-25', '2024-12-26',
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01', '2025-05-08', '2025-07-05',
    '2025-07-06', '2025-09-28', '2025-10-28', '2025-11-17', '2025-12-24', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-08', '2026-07-05',
    '2026-07-06', '2026-09-28', '2026-10-28', '2026-11-17', '2026-12-24', '2026-12-25', '2026-12-26',
  ]),
  DE: new Set([
    // Xetra / German common holidays
    '2020-01-01', '2020-04-10', '2020-04-13', '2020-05-01', '2020-06-01', '2020-12-24',
    '2020-12-25', '2020-12-26', '2020-12-31',
    '2021-01-01', '2021-04-02', '2021-04-05', '2021-05-01', '2021-05-24', '2021-12-24',
    '2021-12-25', '2021-12-26', '2021-12-31',
    '2022-01-01', '2022-04-15', '2022-04-18', '2022-05-01', '2022-05-26', '2022-06-06',
    '2022-10-03', '2022-12-24', '2022-12-25', '2022-12-26', '2022-12-31',
    '2023-01-01', '2023-04-07', '2023-04-10', '2023-05-01', '2023-05-18', '2023-05-29',
    '2023-10-03', '2023-12-24', '2023-12-25', '2023-12-26', '2023-12-31',
    '2024-01-01', '2024-03-29', '2024-04-01', '2024-05-01', '2024-05-09', '2024-05-20',
    '2024-10-03', '2024-12-24', '2024-12-25', '2024-12-26', '2024-12-31',
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01', '2025-05-29', '2025-06-09',
    '2025-10-03', '2025-12-24', '2025-12-25', '2025-12-26', '2025-12-31',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25',
    '2026-10-03', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-31',
  ]),
  CRYPTO: new Set(), // 24/7; still skip nothing except we still use next calendar day after stream
};

/**
 * @param {string} value YYYYMMDD or YYYY-MM-DD
 * @returns {string} YYYY-MM-DD or ''
 */
function toIsoDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return '';
}

/**
 * @param {string} iso YYYY-MM-DD
 * @param {number} days
 * @returns {string}
 */
function shiftIsoDate(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Format seconds as HH:MM:SS (or null).
 * @param {number|null|undefined} sec
 * @returns {string|null}
 */
function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Map ticker / Yahoo symbol onto a venue bucket.
 * @param {string} [ticker]
 * @param {string} [yahooSymbol]
 * @returns {{venue:string, yahoo_symbol:string, venue_known:boolean}}
 */
function resolveVenue(ticker, yahooSymbol) {
  const yahoo = String(yahooSymbol || yahooSymbolFor(ticker) || '').toUpperCase();
  if (!yahoo) {
    return { venue: 'UNKNOWN', yahoo_symbol: '', venue_known: false };
  }
  if (yahoo.includes('-USD') || yahoo.endsWith('USD') && yahoo.includes('-')) {
    return { venue: 'CRYPTO', yahoo_symbol: yahoo, venue_known: true };
  }
  if (yahoo.endsWith('.PR')) return { venue: 'PR', yahoo_symbol: yahoo, venue_known: true };
  if (yahoo.endsWith('.DE') || yahoo.endsWith('.F')) {
    return { venue: 'DE', yahoo_symbol: yahoo, venue_known: true };
  }
  // Plain US tickers and share-class forms (BRK-B).
  if (/^[A-Z0-9]+(-[A-Z])?$/.test(yahoo)) {
    return { venue: 'US', yahoo_symbol: yahoo, venue_known: true };
  }
  // Other European suffixes → treat like DE calendar as a coarse proxy, mark medium later.
  if (/\.(L|PA|AS|SW|MI|MC|VI|ST|CO|HE|OL|T|AX)$/.test(yahoo)) {
    return { venue: 'DE', yahoo_symbol: yahoo, venue_known: false };
  }
  return { venue: 'US', yahoo_symbol: yahoo, venue_known: false };
}

/**
 * @param {string} iso YYYY-MM-DD
 * @returns {number} 0=Sun .. 6=Sat (UTC)
 */
function weekdayUtc(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * Is this a regular session day for the venue?
 * @param {string} iso
 * @param {string} venue
 * @returns {boolean}
 */
function isSessionDay(iso, venue) {
  if (!iso) return false;
  if (venue === 'CRYPTO') return true;
  const dow = weekdayUtc(iso);
  if (dow === 0 || dow === 6) return false;
  const set = HOLIDAYS[venue] || HOLIDAYS.US;
  return !set.has(iso);
}

/**
 * First regular session on or after iso (inclusive).
 * @param {string} iso
 * @param {string} venue
 * @param {number} [maxLookahead]
 * @returns {string}
 */
function nextSessionOnOrAfter(iso, venue, maxLookahead = 14) {
  let cur = iso;
  for (let i = 0; i < maxLookahead; i += 1) {
    if (isSessionDay(cur, venue)) return cur;
    cur = shiftIsoDate(cur, 1);
    if (!cur) return '';
  }
  return '';
}

/**
 * First regular session strictly after iso.
 * @param {string} iso
 * @param {string} venue
 * @returns {string}
 */
function nextSessionAfter(iso, venue) {
  const next = shiftIsoDate(iso, 1);
  return nextSessionOnOrAfter(next, venue);
}

/**
 * Align one claim to a tradable daily event.
 *
 * @param {object} claim
 * @param {string} [claim.upload_date]
 * @param {number|null} [claim.event_time_sec]
 * @param {string} [claim.ticker]
 * @param {string} [claim.yahoo_symbol]
 * @param {object} [opts]
 * @param {'daily'} [opts.barSize]
 * @returns {object}
 */
function alignClaimEvent(claim, opts = {}) {
  const barSize = opts.barSize || 'daily';
  const claimDate = toIsoDate(claim && claim.upload_date);
  const eventSec = claim && claim.event_time_sec != null ? Number(claim.event_time_sec) : null;
  const hasEventSec = Number.isFinite(eventSec);
  const venueInfo = resolveVenue(claim && claim.ticker, claim && claim.yahoo_symbol);
  const venue = venueInfo.venue;

  if (!claimDate) {
    return {
      claim_date: '',
      claim_clock: null,
      executable_date: '',
      venue,
      yahoo_symbol: venueInfo.yahoo_symbol,
      venue_known: venueInfo.venue_known,
      alignment_confidence: 'none',
      alignment_rule: 'missing_upload_date',
      bar_size: barSize,
      notes: 'upload_date missing; cannot align',
    };
  }

  const executableDate = nextSessionAfter(claimDate, venue);
  let confidence = 'medium';
  let rule = 'next_session_after_stream';
  let notes = 'Daily entry on the next regular session after the stream.';

  if (!executableDate) {
    confidence = 'none';
    rule = 'no_session_found';
    notes = 'Could not find a session day within lookahead.';
  } else if (venueInfo.venue_known && hasEventSec) {
    confidence = 'high';
    rule = 'next_session_with_venue_and_segment_time';
    notes = 'Venue known and segment time present; entry is next regular session open.';
  } else if (venueInfo.venue_known && !hasEventSec) {
    confidence = 'medium';
    rule = 'next_session_with_venue_no_segment_time';
    notes = 'Venue known but segment time unknown; entry is next regular session open.';
  } else if (!venueInfo.venue_known && hasEventSec) {
    confidence = 'medium';
    rule = 'next_session_weak_venue_with_segment_time';
    notes = 'Segment time present but venue only coarsely inferred.';
  } else {
    confidence = 'low';
    rule = 'next_session_weak_venue_no_segment_time';
    notes = 'Venue weakly inferred and segment time unknown.';
  }

  // Crypto still uses next calendar day after stream (no overnight session concept).
  if (venue === 'CRYPTO' && executableDate) {
    rule = hasEventSec ? 'next_day_crypto_with_segment_time' : 'next_day_crypto_no_segment_time';
  }

  return {
    claim_date: claimDate,
    claim_clock: formatClock(eventSec),
    event_time_sec: hasEventSec ? eventSec : null,
    executable_date: executableDate,
    venue,
    yahoo_symbol: venueInfo.yahoo_symbol,
    venue_known: venueInfo.venue_known,
    alignment_confidence: confidence,
    alignment_rule: rule,
    bar_size: barSize,
    notes,
  };
}

module.exports = {
  HOLIDAYS,
  alignClaimEvent,
  formatClock,
  isSessionDay,
  nextSessionAfter,
  nextSessionOnOrAfter,
  resolveVenue,
  shiftIsoDate,
  toIsoDate,
  weekdayUtc,
};
