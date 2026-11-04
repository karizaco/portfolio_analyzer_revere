'use strict';

// The transcript normalizer's behaviour on the two providers' shapes.
//
// WHY THIS MATTERS
//
// The whole pipeline downstream is provider-agnostic: the extractor sees
// `{ start_sec, end_sec, text, confidence }` and nothing else. That only
// works if BOTH providers normalize into the same shape, so the two
// normalizers are pinned here against the shapes the providers actually
// return.
//
// The two facts that are easy to get wrong, and are pinned below:
//
//   * the YouTube auto-captions carry NO confidence, and none is invented
//   * a transcript file and a Deepgram response are the same transcript in
//     two shapes, and the normalizer handles both

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDeepgram,
  normalizeTranscript,
  normalizeTranscriptJson,
  normalizeVtt,
  parseVttTimestamp,
  transcriptChecksum,
  transcriptText,
} = require('../src/transcript/transcriptNormalize');

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500
So let's talk about TQQQ today.

00:00:02.500 --> 00:00:05.000
<c>I am very bullish</c> on this one.

00:01:00.000 --> 00:01:03.250
The first target is around 78.
`;

const DEEPGRAM = {
  metadata: { request_id: 'abc' },
  results: {
    utterances: [
      {
        start: 0,
        end: 2.5,
        confidence: 0.98,
        transcript: 'So let us talk about TQQQ today.',
      },
      {
        start: 2.5,
        end: 5,
        confidence: 0.91,
        transcript: 'I am very bullish on this one.',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// WebVTT
// ---------------------------------------------------------------------------

test('a VTT timestamp is parsed into seconds', () => {
  assert.equal(parseVttTimestamp('00:01:30.500'), 90.5);
  assert.equal(parseVttTimestamp('01:30.500'), 90.5);
  assert.equal(parseVttTimestamp('30.500'), 30.5);
});

test('a malformed VTT timestamp is null, not a wrong number', () => {
  assert.equal(parseVttTimestamp('not a timestamp'), null);
});

test('VTT cues become canonical segments', () => {
  const segments = normalizeVtt(VTT);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].start_sec, 0);
  assert.equal(segments[0].end_sec, 2.5);
  assert.equal(segments[0].text, "So let's talk about TQQQ today.");
  assert.equal(segments[2].start_sec, 60);
});

test('VTT styling tags are stripped', () => {
  const segments = normalizeVtt(VTT);
  assert.equal(segments[1].text, 'I am very bullish on this one.');
});

test('the YouTube auto-captions carry no confidence, and none is invented', () => {
  // A fabricated confidence would be a number that means nothing, and it
  // would be compared against Deepgram's real one.
  const segments = normalizeVtt(VTT);
  for (const segment of segments) {
    assert.equal(segment.confidence, null);
  }
});

test('a VTT cue with no text is dropped', () => {
  const segments = normalizeVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n\n00:00:01.000 --> 00:00:02.000\nhello\n');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'hello');
});

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

test('Deepgram utterances become canonical segments', () => {
  const segments = normalizeDeepgram(DEEPGRAM);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start_sec, 0);
  assert.equal(segments[0].end_sec, 2.5);
  assert.equal(segments[0].text, 'So let us talk about TQQQ today.');
});

test("Deepgram's confidence is kept", () => {
  const segments = normalizeDeepgram(DEEPGRAM);
  assert.equal(segments[0].confidence, 0.98);
  assert.equal(segments[1].confidence, 0.91);
});

test('a Deepgram response with no utterances falls back to its word list', () => {
  // The API's shape depends on the parameters, and a silent shape change
  // would otherwise produce an empty transcript.
  const wordList = {
    results: {
      channels: [{
        alternatives: [{
          words: [
            { word: 'I', start: 0, end: 0.2, confidence: 0.9, punctuated_word: 'I' },
            { word: 'am', start: 0.2, end: 0.4, confidence: 0.9, punctuated_word: 'am' },
            { word: 'bullish', start: 0.4, end: 0.8, confidence: 0.8, punctuated_word: 'bullish.' },
          ],
        }],
      }],
    },
  };
  const segments = normalizeDeepgram(wordList);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, 'I am bullish.');
  assert.ok(segments[0].confidence > 0.8);
});

test('a malformed Deepgram payload yields nothing rather than throwing', () => {
  assert.deepEqual(normalizeDeepgram(null), []);
  assert.deepEqual(normalizeDeepgram('not json'), []);
  assert.deepEqual(normalizeDeepgram({}), []);
});

// ---------------------------------------------------------------------------
// The project's own transcript file
// ---------------------------------------------------------------------------

test('the transcript file tools/fetchCaptions.js writes is normalized', () => {
  const body = {
    video_id: 'abc',
    channel: 'davidsevcik',
    segments: [
      { start_ts: 0, end_ts: 2.5, text: 'So let us talk about TQQQ today.' },
      { start_ts: 2.5, end_ts: 5, text: 'I am very bullish on this one.' },
    ],
  };
  const segments = normalizeTranscriptJson(body);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].start_sec, 0);
  assert.equal(segments[0].end_sec, 2.5);
});

// ---------------------------------------------------------------------------
// The provider-agnostic entry point
// ---------------------------------------------------------------------------

test('the provider is inferred from the payload shape when it is not given', () => {
  const fromDeepgram = normalizeTranscript(DEEPGRAM);
  const fromFile = normalizeTranscript({
    segments: [{ start_ts: 0, end_ts: 1, text: 'hello' }],
  });
  assert.equal(fromDeepgram.length, 2);
  assert.equal(fromFile.length, 1);
});

test('an explicit provider is honoured', () => {
  const segments = normalizeTranscript(DEEPGRAM, 'deepgram');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].confidence, 0.98);
});

test('an unusable payload yields nothing rather than throwing', () => {
  assert.deepEqual(normalizeTranscript(null), []);
  assert.deepEqual(normalizeTranscript('nonsense'), []);
  assert.deepEqual(normalizeTranscript({}), []);
});

// ---------------------------------------------------------------------------
// The checksum
// ---------------------------------------------------------------------------

test('the same text always gives the same checksum', () => {
  const a = normalizeVtt(VTT);
  const b = normalizeVtt(VTT);
  assert.equal(transcriptChecksum(a), transcriptChecksum(b));
});

test('a different text gives a different checksum', () => {
  const a = normalizeVtt(VTT);
  const b = normalizeVtt(VTT.replace('bullish', 'bearish'));
  assert.notEqual(transcriptChecksum(a), transcriptChecksum(b));
});

test('the checksum ignores the timing', () => {
  // A re-transcription can shift the timing slightly without changing a
  // single word, and that is not a different transcript.
  const a = normalizeVtt(VTT);
  const shifted = a.map((segment) => ({
    ...segment,
    start_sec: segment.start_sec + 0.25,
    end_sec: segment.end_sec + 0.25,
  }));
  assert.equal(transcriptChecksum(a), transcriptChecksum(shifted));
});

test('the transcript text is the segments joined', () => {
  const segments = normalizeVtt(VTT);
  const text = transcriptText(segments);
  assert.ok(text.includes('TQQQ'));
  assert.ok(text.includes('78'));
});
