'use strict';

// The martinlukkt channel's identity, and the date its titles carry.
//
// The session date is in the title ("Flipped long | 4 Nov 2026"), not in
// the flat listing. One title in the 2026-11-18 listing has a trailing
// space after the year, and one stream's YouTube upload date is the day
// after the title date. The title is what the pipeline dates the session by.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MARTINLUKKT_CHANNEL,
  MARTINLUKKT_SOURCE_URL,
  channelFromSourceUrl,
  isMartinlukktSourceUrl,
} = require('../src/martinlukkt/channel');
const {
  dateFromTitle,
  uploadDateFromTitle,
  martinlukktVideoQuarantine,
  sessionKind,
  titleTickers,
} = require('../src/martinlukkt/contentFilter');

test('the handle is looked up, not built from the slug', () => {
  assert.equal(MARTINLUKKT_CHANNEL, 'martinlukkt');
  assert.equal(isMartinlukktSourceUrl('https://www.youtube.com/@martinlukkt/streams'), true);
  assert.equal(isMartinlukktSourceUrl('https://www.youtube.com/@MartinLukkt/videos'), true);
  assert.equal(isMartinlukktSourceUrl('https://www.youtube.com/playlist?list=abc'), false);
  assert.equal(channelFromSourceUrl(MARTINLUKKT_SOURCE_URL), 'martinlukkt');
  assert.equal(channelFromSourceUrl('https://www.youtube.com/@revereasset/videos'), '');
});

test('the session date is the date in the title', () => {
  assert.equal(dateFromTitle('Flipped long | 4 Nov 2026'), '20261104');
  assert.equal(dateFromTitle('Finally | 12 May 2026 '), '20260512');
  assert.equal(dateFromTitle('My first stream | 12 Nov 2025'), '20251112');
  assert.equal(dateFromTitle('Oct trades | 25 Nov 2025'), '20251125');
  assert.equal(dateFromTitle('no date here'), '');
  assert.equal(dateFromTitle(''), '');
  assert.equal(uploadDateFromTitle({
    title: 'Oct trades | 25 Nov 2025',
    upload_date: '20251126',
  }), '20251125');
  assert.equal(uploadDateFromTitle({
    title: 'Flipped long | 4 Nov 2026',
    upload_date: '20261104',
  }), '');
  assert.equal(uploadDateFromTitle({
    title: 'no date here',
    upload_date: '20260101',
  }), '');
});

test('a review of finished trades is not a live session', () => {
  assert.equal(sessionKind('Oct trades | 25 Nov 2025'), 'review');
  assert.equal(sessionKind('SOXX short | 28 Oct 2026'), 'live');
  assert.equal(sessionKind('Pullback short | 13 Nov 2025'), 'live');
  assert.equal(sessionKind('Flipped long | 4 Nov 2026'), 'live');
});

test('title tickers are the uppercase tokens, not the month', () => {
  assert.deepEqual(titleTickers('SOXX short | 28 Oct 2026'), ['SOXX']);
  assert.deepEqual(titleTickers('SNDK LoD | 1 Jun 2026'), ['SNDK']);
  assert.deepEqual(titleTickers('Flipped long | 4 Nov 2026'), []);
});

test('nothing on this channel is quarantined yet', () => {
  assert.deepEqual(martinlukktVideoQuarantine({ title: 'Oct trades | 25 Nov 2025' }), {
    quarantined: false,
    reason: '',
  });
});
