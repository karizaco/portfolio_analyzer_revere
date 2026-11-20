'use strict';

/**
 * Which US trading session does a post belong to?
 *
 * X posts carry minute-level timestamps, which the other sources do not,
 * and that changes the honest entry price. A post made at 18:00 ET cannot
 * be entered at that day's close -- the close was two hours BEFORE the post.
 * So a post belongs to:
 *
 *   - that day's session, when it was made before 16:00 ET on a weekday;
 *   - the next weekday's session otherwise.
 *
 * The entry is then "the first close at or after the post", and market
 * holidays are resolved there (the price series simply has no bar on a
 * holiday, so the lookup moves to the next bar). This file does not carry a
 * holiday calendar on purpose: a wrong calendar would be a silent error.
 */

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

const CLOSE_MINUTES = 16 * 60;

/**
 * The America/New_York wall-clock parts of an instant.
 *
 * @param {string|number|Date} instant
 * @returns {{date: string, minutes: number, weekday: string}}
 */
function easternParts(instant) {
  const parts = Object.fromEntries(ET_PARTS.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: parts.weekday,
  };
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(isoDate) {
  const day = new Date(`${isoDate}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The session (YYYY-MM-DD) a post made at `instant` belongs to.
 *
 * @param {string|number|Date} instant
 * @returns {string}
 */
function eventSession(instant) {
  const { date, minutes } = easternParts(instant);
  let session = date;
  if (isWeekend(session) || minutes >= CLOSE_MINUTES) {
    session = addDays(session, 1);
    while (isWeekend(session)) session = addDays(session, 1);
  }
  return session;
}

module.exports = { easternParts, eventSession };
