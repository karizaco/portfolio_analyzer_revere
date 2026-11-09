'use strict';

// The language a Deepgram request ACTUALLY used.
//
// WHY THIS MATTERS
//
// `language` is not a hint to Deepgram -- it selects the ACOUSTIC MODEL.
// The Sevcik channel is Czech, and the measured difference is enormous:
//
//   language=en   ->  15 segments of isolated words on a 50-minute stream
//   language=cs   -> 881 segments of full sentences on the same audio
//
// So two facts have to be true, and both were false:
//
//   1. The REQUEST used the configured language. The request parameters
//      were a module-level const, so they froze at require time -- and
//      the caller requires the module BEFORE it loads `.env`. A
//      `DEEPGRAM_LANGUAGE` in `.env` was therefore read too late and
//      silently ignored.
//
//   2. The TRANSCRIPT ROW recorded the language that was used. The row
//      used to record `en` for every Deepgram transcript, whatever the
//      request did, so all 15 rows of the shipped catalog claimed to be
//      English transcripts of Czech audio.
//
// Both are pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deepgramLanguage,
  requestParams,
  DEFAULT_LANGUAGE,
} = require('../src/transcript/deepgramClient');

test('the language defaults to Czech, because the channel is Czech', () => {
  // The default is not a formality: it selects the acoustic model, and
  // the wrong one produces no transcript rather than a bad one.
  assert.equal(DEFAULT_LANGUAGE, 'cs');
});

test('the language is read at CALL time, so .env is honoured', () => {
  // The defect: `REQUEST_PARAMS` was a module-level const, evaluated
  // when the module was required. The fetch tool requires this module
  // on line 51 and calls `loadEnv()` on line 56, so the environment was
  // not loaded yet when the parameters were frozen -- and a
  // DEEPGRAM_LANGUAGE in .env never reached the request.
  const saved = process.env.DEEPGRAM_LANGUAGE;
  try {
    process.env.DEEPGRAM_LANGUAGE = 'de';
    assert.equal(deepgramLanguage(), 'de');
    assert.equal(requestParams().language, 'de');

    process.env.DEEPGRAM_LANGUAGE = 'en';
    assert.equal(requestParams().language, 'en');
  } finally {
    if (saved === undefined) delete process.env.DEEPGRAM_LANGUAGE;
    else process.env.DEEPGRAM_LANGUAGE = saved;
  }
});

test('a per-call language wins over the environment', () => {
  // One process transcribes two channels. DEEPGRAM_LANGUAGE is one value,
  // and it must not force Czech onto an English T3Live upload: the wrong
  // acoustic model returns a handful of isolated words, not a transcript.
  const saved = process.env.DEEPGRAM_LANGUAGE;
  try {
    process.env.DEEPGRAM_LANGUAGE = 'cs';
    assert.equal(requestParams({ language: 'en' }).language, 'en');
    assert.equal(requestParams().language, 'cs');
  } finally {
    if (saved === undefined) delete process.env.DEEPGRAM_LANGUAGE;
    else process.env.DEEPGRAM_LANGUAGE = saved;
  }
});

test('the request parameters are built fresh on every call', () => {
  // If they were cached at module load, this could never change.
  const saved = process.env.DEEPGRAM_MODEL;
  try {
    process.env.DEEPGRAM_MODEL = 'nova-3';
    assert.equal(requestParams().model, 'nova-3');
    delete process.env.DEEPGRAM_MODEL;
    assert.equal(requestParams().model, 'nova-2');
  } finally {
    if (saved !== undefined) process.env.DEEPGRAM_MODEL = saved;
  }
});

test('the request asks for the shapes the normalizer needs', () => {
  const params = requestParams();
  // `utterances` is what gives the per-sentence segmentation; `smart_format`
  // gives the punctuation the sentence splitter relies on.
  assert.equal(params.utterances, 'true');
  assert.equal(params.smart_format, 'true');
  assert.equal(params.punctuate, 'true');
});
