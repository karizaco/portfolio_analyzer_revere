'use strict';

// THE SHARED CLASSIFIER. One implementation, two callers:
// `tools/fetchSevcikTranscripts.js` (which writes the caption-less
// blacklist) and `tools/auditNoCaptions.js` (which re-verifies it). If
// the two disagreed, the audit would measure a different thing than the
// fetch wrote and would report a clean list while the list is wrong.
//
// The tests here pin the SHAPES the existing per-tool tests cannot: what
// `live_chat` counts as, what the table's rows look like, and which
// verdicts may keep a video on the blacklist.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  classifyCaptionFetch, blacklistEntryFor,
} = require('../src/transcript/captionVerdicts');

test('a video whose only "subtitle" is live_chat has NO captions', () => {
  // Verbatim what yt-dlp prints. `live_chat` is the stream's chat
  // replay, not a caption track -- a rule that counted it would
  // blacklist nothing, and the list would stay wrong forever.
  const stdout = [
    '[youtube] HaWCmHfnpM0: Downloading m3u8 information',
    'HaWCmHfnpM0 has no automatic captions',
    '[info] Available subtitles for HaWCmHfnpM0:',
    'Language  Formats',
    'live_chat json',
    '',
  ].join('\n');

  const result = classifyCaptionFetch(stdout, '');
  assert.equal(result.verdict, 'no captions');
  assert.equal(result.permanent, true);
  assert.ok(blacklistEntryFor(result), 'an absent track justifies a blacklist entry');
});

test('a real caption track is NOT an absence', () => {
  // The table's rows are `code  name  formats` -- THREE fields -- so the
  // track is the first token of each row, not the row's only token.
  const stdout = [
    '[info] Available automatic captions for AQEvPMs2jXw:',
    'Language Name                  Formats',
    'en       English               vtt, srt, ttml, srv3, json3',
    'cs       Czech                 vtt, srt, ttml, srv3, json3',
  ].join('\n');

  const result = classifyCaptionFetch(stdout, '');
  assert.equal(result.permanent, false, 'a real track must not blacklist');
  assert.equal(result.verdict, 'HAS CAPTIONS');
  assert.match(result.detail, /en, cs/);
  assert.equal(blacklistEntryFor(result), null, 'nothing may be written for it');
});

test('the header line and the video-id line are not tracks', () => {
  const stdout = [
    '[info] Available automatic captions for AQEvPMs2jXw:',
    'Language Name                  Formats',
  ].join('\n');
  assert.equal(classifyCaptionFetch(stdout, '').verdict, 'caption fetch failed',
    'an empty table is a failed read, not an absence and not a track');
});

test('a failed fetch is NEVER permanent', () => {
  // The whole rule: only YouTube's own answer may blacklist.
  for (const stderr of [
    'ERROR: [youtube] abc: Sign in to confirm your age',
    'ERROR: The page needs to be reloaded.',
    'ERROR: unable to download video data: HTTP Error 403',
    'ERROR: does not look like a Netscape format cookies file',
  ]) {
    const result = classifyCaptionFetch('', stderr);
    assert.equal(result.permanent, false, `"${stderr.slice(0, 44)}" must not blacklist`);
    assert.equal(blacklistEntryFor(result), null);
    assert.equal(result.verdict, 'caption fetch failed');
  }
});

test('a rate limit outranks an absence', () => {
  // A throttled endpoint can be reached while the output ALSO says no
  // subtitles -- and a rate limit is a wait, not a fact about the video.
  const result = classifyCaptionFetch(
    'x has no automatic captions',
    'ERROR: unable to download webpage: HTTP Error 429: Too Many Requests',
  );
  assert.equal(result.verdict, 'rate limited (HTTP 429)');
  assert.equal(result.permanent, false);
});

test('an empty run is a failure, not an absent track', () => {
  const result = classifyCaptionFetch('', '');
  assert.equal(result.verdict, 'caption fetch failed');
  assert.equal(result.permanent, false);
});

test('the failure detail carries the cause, not the warning noise', () => {
  const stderr = [
    'C:\\...\\requests\\__init__.py:113: RequestsDependencyWarning: urllib3 ...',
    '  warnings.warn(',
    'ERROR: [youtube] abc: Sign in to confirm your age. This video may be',
  ].join('\n');
  assert.match(classifyCaptionFetch('', stderr).detail, /Sign in to confirm/);
  assert.doesNotMatch(classifyCaptionFetch('', stderr).detail, /warnings\.warn/);
});

test('a video that is gone is not a caption question', () => {
  const result = classifyCaptionFetch('', 'ERROR: Video unavailable. This video is private');
  assert.equal(result.verdict, 'video unavailable');
  assert.equal(result.permanent, true, 'it cannot be fetched either way');
  assert.ok(blacklistEntryFor(result));
});

test('a transcript\'s own words do not manufacture an absence', () => {
  // The DETAIL TEXT of a failure can contain the phrase "no captions"
  // while describing something else entirely. The phrase is read in the
  // answer, not in the error.
  const result = classifyCaptionFetch('',
    'ERROR: the report says "no captions" for this one but the fetch failed');
  assert.equal(result.permanent, false, 'a failure mentioning the phrase is still a failure');
  assert.equal(blacklistEntryFor(result), null);
});

test('the caller-detected rate limit is honoured even with no output', () => {
  // A caller that saw a 429 before this call must not have its finding
  // overridden by an empty run.
  assert.equal(classifyCaptionFetch('', '', true).verdict, 'rate limited (HTTP 429)');
});

test('blacklistEntryFor writes only what YouTube said', () => {
  // The entry carries the VERDICT THAT JUSTIFIED IT, so a reader can
  // tell a video YouTube said has none from one a run merely failed to
  // fetch. That is the rule the T3Live list predates.
  const absent = blacklistEntryFor(classifyCaptionFetch(
    'x has no automatic captions\n[info] Available subtitles for x:\nLanguage Formats\nlive_chat json', ''));
  assert.match(absent, /no captions/);
  assert.match(absent, /verified by --list-subs/);
});

// THE AUDIT'S SAFETY PROPERTY. A run that could not reach a video must
// not take that video off the list -- a video wrongly removed from the
// caption-less blacklist is sent to a PAID transcription API for audio
// YouTube would transcribe for free. A throttled audit that emptied the
// list would cost money on every entry it emptied.

const { decideEntries } = require('../tools/auditNoCaptions');

const asRow = (id, verdict, permanent, detail = 'd') => ({ id, verdict, permanent, detail });

test('a rate-limited run does NOT empty the blacklist', () => {
  const previous = [
    { id: 'aaa', reason: 'no captions (verified by --list-subs)' },
    { id: 'bbb', reason: 'no captions (verified by --list-subs)' },
    { id: 'ccc', reason: 'no captions (verified by --list-subs)' },
  ];
  const audited = previous.map((row) => asRow(row.id, 'rate limited (HTTP 429)', false, 'throttled'));

  const keep = decideEntries(audited, previous);
  assert.equal(keep.size, 3, 'every entry survives a throttled run');
  assert.match(keep.get('aaa'), /no captions/);
  assert.match(keep.get('aaa'), /not re-verified/);
});

test('a proven-wrong entry comes off the list', () => {
  // "HAS CAPTIONS" is the one verdict that is evidence AGAINST the
  // entry: the track is there, so the entry was a lie.
  const previous = [{ id: 'aaa', reason: 'no captions' }];
  const keep = decideEntries([asRow('aaa', 'HAS CAPTIONS', false, 'en, cs')], previous);
  assert.equal(keep.size, 0);
});

test('a confirmed absence keeps the entry, with its verdict', () => {
  const previous = [{ id: 'aaa', reason: '' }];
  const keep = decideEntries([asRow('aaa', 'no captions', true, 'verified by --list-subs')], previous);
  assert.equal(keep.size, 1);
  assert.match(keep.get('aaa'), /no captions \(verified by --list-subs\)/);
});

test('an entry this run never reached keeps its old text', () => {
  const previous = [
    { id: 'aaa', reason: 'no captions (old)' },
    { id: 'bbb', reason: 'no captions (old)' },
  ];
  const keep = decideEntries([asRow('aaa', 'no captions', true, 'v')], previous);
  assert.equal(keep.size, 2);
  assert.match(keep.get('bbb'), /no captions \(old\)/);
});

test('a failure with no prior reason is not invented', () => {
  // A video that was never justified cannot be kept with a reason the
  // run did not establish -- and it cannot be silently dropped either,
  // so the caller is told.
  const keep = decideEntries([asRow('aaa', 'caption fetch failed', false, 'boom')], [{ id: 'aaa', reason: '' }]);
  assert.equal(keep.size, 0);
});
