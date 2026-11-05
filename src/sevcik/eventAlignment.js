'use strict';

// Event-time alignment for Sevcik claims.
//
// The claim is spoken at a segment inside a stream. The market can only be
// traded AFTER that moment is known. For daily bars this module derives:
//
//   claim_date         calendar day of the stream (upload_date)
//   claim_clock        approximate local clock from event_time_sec (optional)
//   executable_date    first daily bar we treat as tradable AFTER the claim
//   alignment_confidence  how trustworthy that mapping is
//
// Rules (daily, conservative):
//   - missing upload_date => unaligned
//   - no event_time_sec   => executable = next calendar day after upload_date,
//                           confidence = medium (stream-day ambiguity)
//   - event_time_sec set  => still next calendar day after upload_date for daily
//                           bars (same-day open is already gone; same-day close
//                           may include pre-claim price action). confidence high
//                           when event_time_sec is finite, medium otherwise.
//
// The module does NOT fetch prices. It only decides WHEN the claim becomes a
// market event.

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
 * Align one claim to a tradable daily event.
 *
 * @param {object} claim
 * @param {string} [claim.upload_date]
 * @param {number|null} [claim.event_time_sec]
 * @param {object} [opts]
 * @param {'daily'} [opts.barSize]
 * @returns {object}
 */
function alignClaimEvent(claim, opts = {}) {
  const barSize = opts.barSize || 'daily';
  const claimDate = toIsoDate(claim && claim.upload_date);
  const eventSec = claim && claim.event_time_sec != null ? Number(claim.event_time_sec) : null;
  const hasEventSec = Number.isFinite(eventSec);

  if (!claimDate) {
    return {
      claim_date: '',
      claim_clock: null,
      executable_date: '',
      alignment_confidence: 'none',
      alignment_rule: 'missing_upload_date',
      bar_size: barSize,
      notes: 'upload_date missing; cannot align',
    };
  }

  // Daily bars: never use the stream day itself as entry, because the open is
  // already past and the close mixes pre/post claim price action.
  const executableDate = shiftIsoDate(claimDate, 1);
  const confidence = hasEventSec ? 'high' : 'medium';
  const rule = hasEventSec
    ? 'next_day_after_stream_with_segment_time'
    : 'next_day_after_stream_no_segment_time';

  return {
    claim_date: claimDate,
    claim_clock: formatClock(eventSec),
    event_time_sec: hasEventSec ? eventSec : null,
    executable_date: executableDate,
    alignment_confidence: confidence,
    alignment_rule: rule,
    bar_size: barSize,
    notes: hasEventSec
      ? 'Daily entry on the first calendar day after the stream; segment time recorded for audit.'
      : 'Daily entry on the first calendar day after the stream; segment time unknown.',
  };
}

module.exports = {
  alignClaimEvent,
  formatClock,
  shiftIsoDate,
  toIsoDate,
};
