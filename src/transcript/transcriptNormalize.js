'use strict';

// One canonical transcript shape, whatever produced it.
//
// WHY THIS EXISTS
//
// The Sevcik source needs transcripts from two providers with completely
// different shapes:
//
//   YouTube auto-captions   WebVTT, or the JSON `tools/fetchCaptions.js`
//                           already writes: { start_ts, end_ts, text }
//   Deepgram                JSON with `results.utterances[]`, each with
//                           `start`, `end`, `transcript`, `confidence`
//
// Everything downstream -- the signal extractor, the database, the reports --
// has to be provider-agnostic, or the provider leaks into every consumer and
// a second provider means a second parser. So both are normalized into ONE
// shape here:
//
//   { start_sec, end_sec, text, confidence }
//
// `confidence` is null when the provider reports none. It is NOT invented:
// the YouTube auto-captions carry no per-cue confidence, so a fabricated one
// would be a number that means nothing.
//
// The canonical shape deliberately keeps `text` and the time span, because a
// signal is only checkable if it can be pointed back at the words it came
// from.
//
// `tools/fetchCaptions.js` has its own VTT parser inline. The one here is
// the shared one, and the existing tool was pointed at it -- the two had
// drifted apart in the past, and a drift here would mean the same video
// transcribed two different ways depending on which tool ran.

const crypto = require('node:crypto');

const SEGMENT_MIN_SECONDS = 0;
const SEGMENT_MAX_SECONDS = 600;

/**
 * Parse a WebVTT timestamp.
 *
 * WebVTT has TWO forms and they are told apart by the number of colons:
 *
 *   hh:mm:ss.mmm    two colons -- the hour is explicit
 *   mm:ss.mmm       one colon  -- the hour is implicit
 *
 * The form matters: "01:30.500" is 90.5 SECONDS, not 3630.5. Reading the
 * first field as hours when it is minutes is an hour of error in every
 * timestamp of a long video -- and a long video is exactly what this
 * pipeline reads.
 *
 * @param {string} stamp
 * @returns {number|null} seconds, or null when the stamp is unparsable
 */
function parseVttTimestamp(stamp) {
  const text = String(stamp || '').trim();
  const match = text.match(/^(.+?)[.,](\d{1,3})$/);
  if (!match) return null;

  const clock = match[1];
  const millis = Number(String(match[2]).padEnd(3, '0'));
  const parts = clock.split(':').map((part) => Number(part));

  if (parts.some((part) => !Number.isFinite(part))) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
  } else if (parts.length === 2) {
    // ONE colon: the form is mm:ss, so the first field is MINUTES.
    [minutes, seconds] = parts;
  } else if (parts.length === 1) {
    [seconds] = parts;
  } else {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * Strip the WebVTT styling tags from a cue's text.
 *
 * @param {string} text
 * @returns {string}
 */
function stripVttTags(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a WebVTT document into canonical segments.
 *
 * @param {string} vttText
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:null}>}
 */
function normalizeVtt(vttText) {
  const lines = String(vttText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const segments = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line.includes('-->')) {
      index += 1;
      continue;
    }

    const timing = line.match(/([^\s]+)\s+-->\s+([^\s]+)/);
    if (!timing) {
      index += 1;
      continue;
    }
    const startSec = parseVttTimestamp(timing[1]);
    const endSec = parseVttTimestamp(timing[2]);
    index += 1;

    const textLines = [];
    while (index < lines.length) {
      const next = lines[index].trim();
      if (next === '' || next.includes('-->')) break;
      textLines.push(next);
      index += 1;
    }
    // Consume the blank line that separates two cues.
    if (index < lines.length && lines[index].trim() === '') index += 1;

    const text = stripVttTags(textLines.join(' '));
    if (!text) continue;

    const start = Number.isFinite(startSec) ? startSec : 0;
    const end = Number.isFinite(endSec) ? endSec : start;
    segments.push({
      start_sec: round3(start),
      end_sec: round3(Math.max(end, start)),
      text,
      confidence: null,
    });
  }

  return segments;
}

/**
 * Normalize a Deepgram response into canonical segments.
 *
 * Deepgram is asked for `utterances=true`, so each utterance carries its own
 * start/end and its own confidence. The fallback path -- a response with
 * `results.channels[].alternatives[].words[]` but no utterances -- is
 * handled too, because the API's shape depends on the parameters and a
 * silent shape change would otherwise produce an empty transcript.
 *
 * @param {object|string} payload - the parsed response, or its JSON text
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null}>}
 */
function normalizeDeepgram(payload) {
  const body = typeof payload === 'string' ? safeParseJson(payload) : payload;
  if (!body || typeof body !== 'object') return [];

  const results = body.results || {};
  const utterances = Array.isArray(results.utterances) ? results.utterances : [];

  if (utterances.length) {
    return utterances
      .map((utterance) => ({
        start_sec: round3(Number(utterance.start) || 0),
        end_sec: round3(Number(utterance.end) || 0),
        text: stripVttTags(utterance.transcript || ''),
        confidence: Number.isFinite(Number(utterance.confidence))
          ? Number(utterance.confidence)
          : null,
      }))
      .filter((segment) => segment.text);
  }

  // The no-utterances shape: one alternative with a word list.
  const alternative = results.channels && results.channels[0]
    && results.channels[0].alternatives && results.channels[0].alternatives[0];
  if (!alternative || !Array.isArray(alternative.words)) return [];

  const words = alternative.words
    .filter((word) => word && typeof word.word === 'string')
    .map((word) => ({
      start_sec: round3(Number(word.start) || 0),
      end_sec: round3(Number(word.end) || 0),
      text: String(word.word).trim(),
      confidence: Number.isFinite(Number(word.confidence)) ? Number(word.confidence) : null,
      punctuated: String(word.punctuated_word || word.word).trim(),
    }))
    .filter((word) => word.text);

  return groupWordsIntoSegments(words);
}

/**
 * Group a word list into segments, breaking on a sentence-ending punctuation
 * or a gap longer than a second.
 *
 * @param {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null,punctuated:string}>} words
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null}>}
 */
function groupWordsIntoSegments(words) {
  const segments = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      segments.push({
        start_sec: round3(current.start),
        end_sec: round3(current.end),
        text,
        confidence: current.confidences.length
          ? round3(current.confidences.reduce((sum, value) => sum + value, 0) / current.confidences.length)
          : null,
      });
    }
    current = null;
  };

  for (const word of words) {
    const endsSentence = /[.!?]$/.test(word.punctuated);
    if (!current) {
      current = {
        start: word.start_sec,
        end: word.end_sec,
        parts: [word.punctuated],
        confidences: word.confidence === null ? [] : [word.confidence],
      };
    } else {
      current.parts.push(word.punctuated);
      current.end = word.end_sec;
      if (word.confidence !== null) current.confidences.push(word.confidence);
    }
    if (endsSentence || word.end_sec - current.start > SEGMENT_MAX_SECONDS) flush();
  }
  flush();

  return segments;
}

/**
 * Normalize the transcript JSON `tools/fetchCaptions.js` already writes.
 *
 * Its shape is `{ video_id, channel, title, segments: [{ start_ts, end_ts, text }] }`,
 * which is already close to canonical -- the field names differ and there is
 * no confidence.
 *
 * @param {object|string} payload
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:null}>}
 */
function normalizeTranscriptJson(payload) {
  const body = typeof payload === 'string' ? safeParseJson(payload) : payload;
  if (!body || typeof body !== 'object') return [];
  const segments = Array.isArray(body.segments) ? body.segments : [];
  return segments
    .map((segment) => ({
      start_sec: round3(Number(segment.start_sec ?? segment.start_ts) || 0),
      end_sec: round3(Number(segment.end_sec ?? segment.end_ts) || 0),
      text: stripVttTags(segment.text || ''),
      confidence: Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null,
    }))
    .filter((segment) => segment.text);
}

/**
 * Normalize a transcript from whichever provider produced it.
 *
 * The provider is inferred from the payload's own shape when it is not
 * given, so a mislabelled transcript still normalizes correctly.
 *
 * @param {object|string} payload
 * @param {string} [provider] - 'youtube_auto' | 'deepgram' | 'manual'
 * @returns {Array<{start_sec:number,end_sec:number,text:string,confidence:number|null}>}
 */
function normalizeTranscript(payload, provider) {
  const body = typeof payload === 'string' ? safeParseJson(payload) : payload;
  if (!body || typeof body !== 'object') return [];

  if (provider === 'deepgram') return normalizeDeepgram(body);
  if (provider === 'youtube_auto' || provider === 'manual') return normalizeTranscriptJson(body);

  // Infer it. A Deepgram response has `results` -- with either utterances
  // or a channels/alternatives word list. The project's own transcript JSON
  // has a top-level `segments` array.
  if (body.results && (body.results.utterances || body.results.channels)) {
    return normalizeDeepgram(body);
  }
  if (Array.isArray(body.segments)) return normalizeTranscriptJson(body);
  return [];
}

/**
 * The text of a transcript, with the segments joined by spaces.
 *
 * @param {Array<{text:string}>} segments
 * @returns {string}
 */
function transcriptText(segments) {
  return (segments || [])
    .map((segment) => String(segment.text || '').trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * A stable fingerprint of a transcript's TEXT.
 *
 * Two runs of the same provider over the same video produce the same text,
 * so this is what makes a re-run idempotent: the second run recognises the
 * checksum and does not create a second transcript row. The timing is NOT
 * part of it, because a re-transcription can shift the timing slightly
 * without changing a single word.
 *
 * @param {Array<{text:string}>} segments
 * @returns {string}
 */
function transcriptChecksum(segments) {
  return crypto
    .createHash('md5')
    .update(transcriptText(segments).toLowerCase().replace(/\s+/g, ' ').trim())
    .digest('hex');
}

function round3(value) {
  return Number(Number(value || 0).toFixed(3));
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = {
  SEGMENT_MAX_SECONDS,
  SEGMENT_MIN_SECONDS,
  groupWordsIntoSegments,
  normalizeDeepgram,
  normalizeTranscript,
  normalizeTranscriptJson,
  normalizeVtt,
  parseVttTimestamp,
  stripVttTags,
  transcriptChecksum,
  transcriptText,
};
