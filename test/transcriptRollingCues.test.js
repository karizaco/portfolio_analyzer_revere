'use strict';

// YouTube's rolling caption cues, and what the extractors do with them.
//
// A YouTube auto-caption track records every state of a two-line scrolling
// display, so each spoken line appears twice: once with the line before it,
// once alone. Read as separate segments, every line is said twice and the
// line before a ticker shares the ticker's segment -- which is how "not
// bullish", said about MSTR, ended up in BHC's signal on the T3Live
// Actionable Swing video (AQEvPMs2jXw).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  collapseRollingCues,
  cueOverlap,
  isRollingCaptionTranscript,
} = require('../src/transcript/transcriptNormalize');
const { extractSignals } = require('../src/sevcik/signalExtractor');

/** Build the rolling cue sequence YouTube writes for a list of lines. */
function rollingCues(lines, startSec = 0) {
  const cues = [];
  let t = startSec;
  lines.forEach((line, i) => {
    if (i === 0) {
      cues.push({ start_sec: t, end_sec: t + 0.01, text: line, confidence: null });
      return;
    }
    cues.push({ start_sec: t, end_sec: t + 2, text: `${lines[i - 1]} ${line}`, confidence: null });
    t += 2;
    cues.push({ start_sec: t, end_sec: t + 0.01, text: line, confidence: null });
  });
  return cues;
}

const LINES = [
  'okay so lets look at the bearish names first',
  'the MSTR if we are going to move higher',
  'but the picture right now is not bullish',
  'BHC is very very very bullish probably',
  'reported earnings gapped up I like it',
  'higher over the pivot here similar to the others',
  'and that is all for this week thanks everyone',
];

test('a cue that repeats the previous cue\'s last line overlaps by its whole length', () => {
  assert.equal(cueOverlap('a b c d'.split(' '), 'c d'.split(' ')), 2);
  assert.equal(cueOverlap('a b c d'.split(' '), 'c d e f'.split(' ')), 2);
  assert.equal(cueOverlap('a b c d'.split(' '), 'x y'.split(' ')), 0);
});

test('a YouTube caption track is detected as rolling; a Deepgram one is not', () => {
  assert.equal(isRollingCaptionTranscript(rollingCues(LINES)), true);
  const deepgram = LINES.map((text, i) => ({ start_sec: i * 3, end_sec: i * 3 + 3, text, confidence: 0.98 }));
  assert.equal(isRollingCaptionTranscript(deepgram), false);
});

test('too few cues are not enough evidence to call a transcript rolling', () => {
  assert.equal(isRollingCaptionTranscript(rollingCues(LINES.slice(0, 2))), false);
});

test('collapsing gives each spoken line exactly once, in order', () => {
  const collapsed = collapseRollingCues(rollingCues(LINES));
  assert.deepEqual(collapsed.map((s) => s.text), LINES);
});

test('every collapsed segment remembers the stored cue it came from', () => {
  const cues = rollingCues(LINES);
  const collapsed = collapseRollingCues(cues);
  for (const segment of collapsed) {
    assert.ok(cues[segment.source_index].text.endsWith(segment.text), segment.text);
  }
});

test('a transcript that is not rolling passes through with its text untouched', () => {
  const clean = LINES.map((text, i) => ({ start_sec: i, end_sec: i + 1, text }));
  const out = collapseRollingCues(clean);
  assert.deepEqual(out.map((s) => s.text), LINES);
  assert.deepEqual(out.map((s) => s.source_index), LINES.map((_, i) => i));
});

test('on rolling captions a negation said about one name does not reach the next name', () => {
  const lexicon = new Set(['MSTR', 'BHC']);
  const signals = extractSignals({ segments: rollingCues(LINES), lexicon, videoId: 'rolling' });
  const bhc = signals.filter((s) => s.ticker === 'BHC');
  assert.equal(bhc.length, 1, 'BHC is one signal, not one per repeated cue');
  assert.equal(bhc[0].bias, 'bullish');
  assert.ok(!/not bullish/.test(bhc[0].evidence_text), bhc[0].evidence_text);
});

test('on rolling captions the evidence carries each line once', () => {
  const lexicon = new Set(['MSTR', 'BHC']);
  const [bhc] = extractSignals({ segments: rollingCues(LINES), lexicon }).filter((s) => s.ticker === 'BHC');
  const occurrences = bhc.evidence_text.split('BHC is very very very bullish probably').length - 1;
  assert.equal(occurrences, 1);
});

test('a signal\'s segment span points at the STORED cues, not the collapsed ones', () => {
  const cues = rollingCues(LINES);
  const lexicon = new Set(['MSTR', 'BHC']);
  const [bhc] = extractSignals({ segments: cues, lexicon }).filter((s) => s.ticker === 'BHC');
  assert.ok(cues[bhc.segment_start_index].text.includes('BHC'), cues[bhc.segment_start_index].text);
  assert.equal(bhc.event_time_sec, cues[bhc.segment_start_index].start_sec);
});
