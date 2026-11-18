'use strict';

// The TERMS parameter of the Deepgram request.
//
// WHY IT EXISTS, AND WHY IT IS NOT USED BY DEFAULT
//
// A ticker said out loud is the hardest thing in the corpus for a
// speech model. Measured on the Komar corpus: the provider's own
// tokenisation split a holding across a boundary -- "I bought into
// DF," | "DV. I see a lot of positive momentum" -- and the provider's
// word list shows it wrote "df" and "dv" as TWO words, so the split is
// the provider's TOKENISATION and not its endpointing.
//
// The request-level answer is the provider's terms parameter. It works:
// with the corpus's own tickers sent as terms, the provider wrote
// "dfdv" as one word.
//
// It is MEASURED and REJECTED for this corpus, and the reason is the
// finding this test pins: a terms list made of TICKERS is a
// hallucination machine, because tickers ARE ordinary words. With the
// terms sent, the provider replaced ordinary speech with corpus
// tickers -- "I got stopped out" became "I got stopped OUST", "right
// now in the" became "right now INVZ the", "this explosive verb"
// became "this explosive VERB", "a new source of into" became "a new
// source of INTA". Every one of those is a ticker the corpus really
// trades, so the error is invisible -- and it is a wrong holding,
// which the project treats as worse than a missing one.
//
// So the mechanism is HERE, additive and off by default, and the
// DECISION is the source's: the Komar corpus uses the local repair
// (`src/komar/transcriptRepair.js`) instead.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  keytermParamName,
  requestKeyterms,
  requestParams,
} = require('../src/transcript/deepgramClient');

test('a request with no terms asks for no terms', () => {
  assert.deepEqual(requestKeyterms(), []);
  assert.deepEqual(requestKeyterms({ keyterms: [] }), []);
  assert.deepEqual(requestKeyterms({ keyterms: '' }), []);
});

test('the terms come from the caller, and the environment is a fallback', () => {
  assert.deepEqual(requestKeyterms({ keyterms: ['DFDV', 'ONDS'] }), ['DFDV', 'ONDS']);
  assert.deepEqual(requestKeyterms({ keyterms: 'DFDV, ONDS' }), ['DFDV', 'ONDS']);
  const saved = process.env.DEEPGRAM_KEYTERMS;
  try {
    process.env.DEEPGRAM_KEYTERMS = 'DFDV ONDS';
    assert.deepEqual(requestKeyterms(), ['DFDV', 'ONDS']);
    // The caller's terms win over the environment.
    assert.deepEqual(requestKeyterms({ keyterms: ['X'] }), ['X']);
  } finally {
    if (saved === undefined) delete process.env.DEEPGRAM_KEYTERMS;
    else process.env.DEEPGRAM_KEYTERMS = saved;
  }
});

test('the parameter name depends on the model, because Deepgram says so', () => {
  // Deepgram's own error: "`keyterm` is only supported for Nova-3 and
  // Flux. Please use `keywords` instead." A request that sends
  // `keyterm` to nova-2 is refused with HTTP 400.
  assert.equal(keytermParamName('nova-2'), 'keywords');
  assert.equal(keytermParamName('nova-3'), 'keyterm');
  assert.equal(keytermParamName('flux'), 'keyterm');
  assert.equal(keytermParamName('Nova-3'), 'keyterm');
});

test('a request without terms is the request that was always sent', () => {
  // The terms are a PARAMETER, so the request's own shape is
  // unchanged for every source that does not use them.
  const params = requestParams();
  assert.equal(params.utterances, 'true');
  assert.equal(params.smart_format, 'true');
  assert.equal(params.punctuate, 'true');
  assert.equal(Object.keys(params).includes('keyterm'), false);
  assert.equal(Object.keys(params).includes('keywords'), false);
});
