'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseChunkOutput } = require('../tools/fetchTranscriptChunks');

// The chunk runner has to tell four outcomes apart, because three of them
// mean "do not ask for this video again" and one means "ask again later".
// The bug this file pins is the one that cost a whole run on 2026-11-10: a
// chunk of ids the content filter had already quarantined left the fetch
// tool with no candidates, it fetched nothing, and the runner reported a
// possible throttle and stopped. The run was not throttled -- it had
// finished.

test('a fetched video is counted as fetched', () => {
  const output = [
    '[sevcik-transcripts] candidates=2 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 youtube_auto (812 segments)',
    '[sevcik-transcripts] def456 20240102 youtube_auto (430 segments)',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.fetched, ['abc123', 'def456']);
  assert.equal(parsed.quarantined.length, 0);
});

test('a caption-less video is separated from a failure', () => {
  const output = [
    '[sevcik-transcripts] candidates=2 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: no captions | deepgram: off',
    '[sevcik-transcripts] def456 20240102 FAILED: youtube_auto: en: no auto-captions found',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.noCaptions, ['abc123', 'def456']);
  assert.deepEqual(parsed.otherFailures, []);
});

test('a blacklist entry carries the verdict that justified it', () => {
  // A blacklist entry is permanent -- the runner never asks for the video
  // again. So the entry has to say WHY, or a reader cannot tell a video
  // YouTube said has no captions from one a run merely failed to fetch.
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: no captions | deepgram: off',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.equal(parsed.noCaptionsByReason.abc123, 'en: no captions | deepgram: off');
});

test('a FAILED FETCH is never blacklisted, whatever its detail says', () => {
  // The detail text of a failed fetch can contain the phrase "no captions"
  // itself -- e.g. a yt-dlp error quoting the request. The failure must
  // still be a retry and not a permanent blacklist entry.
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: caption fetch failed (ERROR: no captions in response)',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.noCaptions, []);
  assert.deepEqual(parsed.otherFailures, ['abc123']);
});

test('a genuine failure is neither a fetch nor a caption-less video', () => {
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: HTTP 500',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.otherFailures, ['abc123']);
  assert.deepEqual(parsed.noCaptions, []);
  assert.deepEqual(parsed.fetched, []);
});

test('a quarantined video is named, so the runner stops asking for it', () => {
  const output = [
    '[sevcik-transcripts] quarantined_non_market=2 ids=aaa111,bbb222',
    '[sevcik-transcripts] candidates=0 channel=t3live provider=auto',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.quarantined, ['aaa111', 'bbb222']);
  // A quarantined video is not a failure and not a caption-less video.
  assert.deepEqual(parsed.otherFailures, []);
  assert.deepEqual(parsed.noCaptions, []);
  // And it is not a fetch.
  assert.deepEqual(parsed.fetched, []);
});

test('a rate-limited video is flagged and NOT blacklisted', () => {
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: rate limited by YouTube',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.equal(parsed.rateLimited, true);
  // It must appear in NONE of the lists, so the next run asks for it again.
  assert.deepEqual(parsed.noCaptions, []);
  assert.deepEqual(parsed.otherFailures, []);
  assert.deepEqual(parsed.quarantined, []);
});

test('a rate limit is recognised in yt-dlp\'s own hyphenated wording', () => {
  // "rate-limited", with a hyphen. A pattern for "rate limited", with a
  // space, does not match it -- so a throttled endpoint reads as a plain
  // failure and the runner keeps hammering it.
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 FAILED: youtube_auto: en: caption fetch failed (ERROR: The current session has been rate-limited by YouTube for up to an hour.)',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.equal(parsed.rateLimited, true);
  // And it must not be blacklisted, and not be a generic failure either.
  assert.deepEqual(parsed.noCaptions, []);
  assert.deepEqual(parsed.otherFailures, []);
});

test('an all-quarantined chunk is not a throttle', () => {
  // This is the exact shape of the 2026-11-10 false stop: the fetch tool
  // had no candidates, so it printed nothing and fetched nothing.
  const output = [
    '[sevcik-transcripts] quarantined_non_market=11 ids=a1,a2,a3,a4,a5,a6,a7,a8,a9,a10,a11',
    '[sevcik-transcripts] candidates=0 channel=t3live provider=auto',
    '[sevcik-transcripts] done: fetched=0 skipped=0 failed=0 providers={}',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.equal(parsed.fetched.length, 0);
  assert.equal(parsed.quarantined.length, 11);
  assert.equal(parsed.rateLimited, false);
});

test('only the LAST block is counted -- an earlier block is a different chunk', () => {
  // The fetch tool prints a header per run. Counting the whole output would
  // attribute an earlier chunk's successes to this chunk.
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] old111 20230101 youtube_auto (100 segments)',
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] new222 20240101 youtube_auto (100 segments)',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.fetched, ['new222']);
});

test('a deepgram transcript counts as fetched', () => {
  const output = [
    '[sevcik-transcripts] candidates=1 channel=t3live provider=auto',
    '[sevcik-transcripts] abc123 20240101 deepgram (881 segments)',
  ].join('\n');
  const parsed = parseChunkOutput(output);
  assert.deepEqual(parsed.fetched, ['abc123']);
});
