'use strict';

// The FundedMind channel's identity, title date/host, and quarantine kinds.
//
// Measured 2026-11-18 on the live streams listing: titles carry a Czech
// calendar date and a host after "|", and the show kind decides whether the
// transcript path should pull the row.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FUNDEDMIND_CHANNEL,
  FUNDEDMIND_SOURCE_URL,
  FUNDEDMIND_SOURCE_URLS,
  channelFromSourceUrl,
  isFundedmindSourceUrl,
} = require('../src/fundedmind/channel');
const {
  FUNDEDMIND_KINDS,
  dateFromTitle,
  fundedmindVideoQuarantine,
  hostFromTitle,
  isUpcomingSession,
  sessionKind,
} = require('../src/fundedmind/contentFilter');

test('the handle is looked up, not built from the slug', () => {
  assert.equal(FUNDEDMIND_CHANNEL, 'fundedmind');
  assert.equal(isFundedmindSourceUrl('https://www.youtube.com/@FundedMind/streams'), true);
  assert.equal(isFundedmindSourceUrl('https://www.youtube.com/@fundedmind/videos'), true);
  assert.equal(isFundedmindSourceUrl('https://www.youtube.com/playlist?list=abc'), false);
  assert.equal(channelFromSourceUrl(FUNDEDMIND_SOURCE_URL), 'fundedmind');
  assert.equal(channelFromSourceUrl(FUNDEDMIND_SOURCE_URLS.videos), 'fundedmind');
  assert.equal(channelFromSourceUrl('https://www.youtube.com/@revereasset/videos'), '');
});

test('the session date is the Czech day.month form in the title', () => {
  assert.equal(dateFromTitle('Live Trading | Oliver Pátek 13.11. 2026'), '20261113');
  assert.equal(dateFromTitle('Live Trading | Michal Veselovský 8.10.2026'), '20261008');
  assert.equal(dateFromTitle('Sunday Focus | Petr Můčka 15.11. 2026'), '20261115');
  assert.equal(dateFromTitle('Gold Trading | Sunita Hakimi 10.11. 2026'), '20261110');
  assert.equal(dateFromTitle('no date here'), '');
  assert.equal(dateFromTitle(''), '');
});

test('the host sits between the pipe and the date', () => {
  assert.equal(hostFromTitle('Live Trading | Oliver Pátek 13.11. 2026'), 'Oliver Pátek');
  assert.equal(hostFromTitle('Sunday Focus | Petr Můčka 15.11. 2026'), 'Petr Můčka');
  assert.equal(hostFromTitle('Macro Monday | Daniel Valchář 9.11. 2026'), 'Daniel Valchář');
  assert.equal(hostFromTitle('Market Structure LiveTrading | Petr Šumný 12.11. 2026'), 'Petr Šumný');
  assert.equal(hostFromTitle('no pipe here 13.11. 2026'), '');
});

test('show kinds prefer specific series over generic live trading', () => {
  assert.equal(sessionKind('Live Trading | Oliver Pátek 13.11. 2026'), FUNDEDMIND_KINDS.LIVE_TRADING);
  assert.equal(sessionKind('LiveTrading | Michal Veselovský 17.11. 2026'), FUNDEDMIND_KINDS.LIVE_TRADING);
  assert.equal(sessionKind('Sunday Focus | Petr Můčka 15.11. 2026'), FUNDEDMIND_KINDS.FOCUS);
  assert.equal(sessionKind('Monday Focus | Petr Můčka 26.10. 2026'), FUNDEDMIND_KINDS.FOCUS);
  assert.equal(sessionKind('Market Structure LiveTrading | Petr Šumný 12.11. 2026'), FUNDEDMIND_KINDS.MARKET_STRUCTURE);
  assert.equal(sessionKind('Gold Trading | Sunita Hakimi 10.11. 2026'), FUNDEDMIND_KINDS.GOLD);
  assert.equal(sessionKind('Macro Monday | Daniel Valchář 9.11. 2026'), FUNDEDMIND_KINDS.MACRO);
  assert.equal(sessionKind('Jan Šrajer ŽIVĚ | Charts and Chill'), FUNDEDMIND_KINDS.EVENT);
  assert.equal(sessionKind('Jak jsem Vydělal 11 000 $ | FM Interview ep.04'), FUNDEDMIND_KINDS.INTERVIEW);
  assert.equal(sessionKind('Proč tě emoce stojí víc | Psychologie tradingu #2'), FUNDEDMIND_KINDS.EDUCATION);
  assert.equal(sessionKind('Zapomeň na winrate | Průvodce prop firmami #1'), FUNDEDMIND_KINDS.EDUCATION);
});

test('only live desk kinds are extract-eligible; interviews and education are quarantined', () => {
  const live = fundedmindVideoQuarantine({ title: 'Live Trading | Oliver Pátek 13.11. 2026' });
  assert.equal(live.quarantined, false);
  assert.equal(live.kind, FUNDEDMIND_KINDS.LIVE_TRADING);
  assert.equal(live.host, 'Oliver Pátek');
  assert.equal(live.sessionDate, '20261113');

  const focus = fundedmindVideoQuarantine({ title: 'Sunday Focus | Petr Můčka 15.11. 2026' });
  assert.equal(focus.quarantined, false);
  assert.equal(focus.kind, FUNDEDMIND_KINDS.FOCUS);

  const interview = fundedmindVideoQuarantine({ title: 'FM Interview ep.13 | something' });
  assert.equal(interview.quarantined, true);
  assert.match(interview.reason, /interview/);

  const education = fundedmindVideoQuarantine({ title: 'Průvodce prop firmami #2' });
  assert.equal(education.quarantined, true);
  assert.match(education.reason, /education/);
});

test('scheduled futures with a title date after today are quarantined', () => {
  const future = fundedmindVideoQuarantine({ title: 'Live Trading | Oliver Pátek 1.12. 2099' });
  assert.equal(future.quarantined, true);
  assert.match(future.reason, /upcoming/);
  assert.equal(future.sessionDate, '20991201');
  assert.equal(isUpcomingSession('Live Trading | Oliver Pátek 1.12. 2099', new Date('2026-11-19T12:00:00+07:00')), true);
  assert.equal(isUpcomingSession('Live Trading | Oliver Pátek 19.11. 2026', new Date('2026-11-19T12:00:00+07:00')), true);
  assert.equal(isUpcomingSession('Live Trading | Oliver Pátek 18.11. 2026', new Date('2026-11-19T12:00:00+07:00')), false);
  assert.equal(isUpcomingSession('no date here', new Date('2026-11-19T12:00:00+07:00')), false);
  const past = fundedmindVideoQuarantine({ title: 'Live Trading | Oliver Pátek 13.11. 2026' });
  assert.equal(past.quarantined, false);
});


test('Week Recap is its own extract-eligible kind', () => {
  assert.equal(sessionKind('Week Recap - Petr Můčka | 9.5. 2025'), FUNDEDMIND_KINDS.WEEK_RECAP);
  assert.equal(hostFromTitle('Week Recap - Petr Můčka | 9.5. 2025'), 'Petr Můčka');
  assert.equal(dateFromTitle('Week Recap - Petr Můčka | 9.5. 2025'), '20250509');
  const q = fundedmindVideoQuarantine({ title: 'Week Recap - Petr Můčka | 9.5. 2025' });
  assert.equal(q.quarantined, false);
  assert.equal(q.kind, FUNDEDMIND_KINDS.WEEK_RECAP);
  assert.equal(q.host, 'Petr Můčka');
  assert.equal(q.sessionDate, '20250509');
});


test('older Week Recap titles without a pipe still yield host and date', () => {
  assert.equal(hostFromTitle('Week Recap  Petr 22.11.2024'), 'Petr Můčka');
  assert.equal(dateFromTitle('Week Recap  Petr 22.11.2024'), '20241122');
  assert.equal(hostFromTitle('Week Recap  Petr 15.11.'), 'Petr Můčka');
  assert.equal(
    dateFromTitle('Week Recap  Petr 15.11.', { uploadDate: '20241116' }),
    '20241115',
  );
  assert.equal(hostFromTitle('Week Recap - Petr Mka | 8.11.'), 'Petr Můčka');
  assert.equal(
    dateFromTitle('Week Recap - Petr Mka | 8.11.', { uploadDate: '20241109' }),
    '20241108',
  );
  const q = fundedmindVideoQuarantine({
    title: 'Week Recap  Petr 15.11.',
    upload_date: '20241116',
  });
  assert.equal(q.quarantined, false);
  assert.equal(q.host, 'Petr Můčka');
  assert.equal(q.sessionDate, '20241115');
});

test('known silent empty videos are hard-skipped', () => {
  const q = fundedmindVideoQuarantine({
    video_id: 'VjyKk33u0Jw',
    title: 'Live Trading | Someone 1.1. 2025',
  });
  assert.equal(q.quarantined, true);
  assert.match(q.reason, /hard_skip/);
});
test('odd date spacing still yields a clean host', () => {
  assert.equal(hostFromTitle('LiveTrading | Michal Veselovský 12.6..2025'), 'Michal Veselovský');
  assert.equal(hostFromTitle('Live Trading | Michal Veselovský 2. 10. 2025'), 'Michal Veselovský');
  assert.equal(dateFromTitle('LiveTrading | Michal Veselovský 12.6..2025'), '20250612');
  assert.equal(dateFromTitle('Live Trading | Michal Veselovský 2. 10. 2025'), '20251002');
});

test('older pipe-left host titles and aliases resolve', () => {
  assert.equal(hostFromTitle('Live trading - Michal Veselovský | 8.5. 2025'), 'Michal Veselovský');
  assert.equal(hostFromTitle('Livetrading session🔴 Michal | 19.9.2024'), 'Michal Veselovský');
  assert.equal(hostFromTitle('Sunday Focus - Petr Můčka | 11.5. 2025'), 'Petr Můčka');
  assert.equal(hostFromTitle('Sunday Focus | Petr Mka 15.11. 2026'), 'Petr Můčka');
  assert.equal(hostFromTitle('Macro Monday | Daniel Valchá 9.11. 2026'), 'Daniel Valchář');
  assert.equal(hostFromTitle('Live trading - Petr  Můčka | 1.5. 2025'), 'Petr Můčka');
});
