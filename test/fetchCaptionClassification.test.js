'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyMissingCaptions } = require('../tools/fetchSevcikTranscripts');

// The three verdicts need three different responses: "no captions" is a
// permanent blacklist entry, "rate limited" is a wait, and "caption fetch
// failed" is a retry. Only the first one is permanent.
//
// The bug this file pins is the one that put 119 wrong entries in the T3Live
// caption-less list on 2026-11-10: every failure was reported as "no
// captions", so a video fetched once during a bad window was never asked for
// again -- and a blacklist entry sends a video with FREE captions to a PAID
// transcription API.

test('yt-dlp saying there are no subtitles is a blacklist entry', () => {
  const stdout = [
    '[youtube] Extracting URL: https://www.youtube.com/watch?v=abc',
    '[info] abc: Downloading 1 format(s): 137+251',
    '[info] There are no subtitles for the requested languages',
    '[SubtitlesConvertor] There aren\'t any subtitles to convert',
  ].join('\n');
  const verdict = classifyMissingCaptions('en', stdout, 'WARNING: [youtube] Skipping unsupported client', false);
  assert.equal(verdict, 'en: no captions');
});

// THIS IS THE ONE THAT MATTERS. The message is on STDOUT, not stderr --
// yt-dlp puts its [info] lines there and only its warnings on stderr.
// Reading stderr alone classifies a genuinely absent caption track as a
// failed fetch, which is the same defect in the other direction.
test('the no-subtitles verdict is read from STDOUT, not stderr', () => {
  const stdout = '[info] There are no subtitles for the requested languages';
  assert.equal(classifyMissingCaptions('en', stdout, '', false), 'en: no captions');
});

test('a rate limit is a wait, not a blacklist entry', () => {
  const verdict = classifyMissingCaptions('en', '', 'HTTP Error 429: Too Many Requests', true);
  assert.match(verdict, /rate limited/);
  assert.notEqual(verdict, 'en: no captions');
});

test('a failed fetch is a retry, and it is named as one', () => {
  const stderr = 'ERROR: [youtube] Video unavailable';
  const verdict = classifyMissingCaptions('en', '', stderr, false);
  assert.match(verdict, /caption fetch failed/);
  // It must NOT say "no captions" -- the video may well have them.
  assert.notEqual(verdict, 'en: no captions');
});

test('the failure detail carries the cause, not the warning noise', () => {
  // A Python RequestsDependencyWarning ends every single run. Reporting it
  // as the cause tells a reader nothing.
  const stderr = [
    'RequestsDependencyWarning: urllib3 (2.6.3) or chardet (7.6.0) doesn\'t match!',
    '  warnings.warn(',
    'ERROR: [youtube] Sign in to confirm you\'re not a bot',
  ].join('\n');
  const verdict = classifyMissingCaptions('en', '', stderr, false);
  assert.match(verdict, /Sign in to confirm/);
  assert.doesNotMatch(verdict, /warnings\.warn/);
});

test('an empty run reports a failure, not an absent caption track', () => {
  const verdict = classifyMissingCaptions('en', '', '', false);
  assert.match(verdict, /caption fetch failed/);
  assert.notEqual(verdict, 'en: no captions');
});

test('the language is carried through', () => {
  assert.match(classifyMissingCaptions('cs', '[info] There are no subtitles for the requested languages', '', false), /^cs: /);
});

// THE HYPHEN IS THE WHOLE DEFECT. yt-dlp's own wording is "rate-limited",
// with a hyphen, and a pattern for "rate limited" -- with a space -- does
// not match it. The tool then reads a throttled endpoint as a video with no
// captions: it does not wait, it does not stop, and it blacklists the
// video. On 2026-11-11 that burned 76 fetches against an already-throttled
// IP before the run gave up.
test('a rate limit is recognised in yt-dlp\'s own hyphenated wording', () => {
  const stderr = 'ERROR: [youtube] abc: This content isn\'t available, try again later. '
    + 'The current session has been rate-limited by YouTube for up to an hour.';
  const verdict = classifyMissingCaptions('en', '', stderr, false);
  assert.match(verdict, /rate limited/, `expected a rate-limit verdict, got: ${verdict}`);
  assert.notEqual(verdict, 'en: no captions');
});

test('the HTTP forms are recognised too', () => {
  for (const stderr of ['HTTP Error 429: Too Many Requests', 'ERROR: Too Many Requests']) {
    const verdict = classifyMissingCaptions('en', '', stderr, false);
    assert.match(verdict, /rate limited/, `expected a rate-limit verdict for: ${stderr}`);
  }
});
