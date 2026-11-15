'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clusterRawOcrTokens
} = require('../src/parse/parseChartStream');

// Production options from tools/scanVideoWithOcr.js (QMG clusterer call).
const PRODUCTION_CLUSTER_OPTIONS = Object.freeze({ maxDistance: 1, minTokenLength: 2, minFrequency: 1 });

test('clusterRawOcrTokens keeps allowlisted single-letter tickers with production options', () => {
  const lexicon = { tickerSet: new Set(['U', 'X', 'TSLA']), tickers: ['U', 'X', 'TSLA'] };
  const withU = clusterRawOcrTokens(['U TSLA', 'U TSLA'], { ...PRODUCTION_CLUSTER_OPTIONS, lexicon });
  assert.deepEqual(withU.merged_list, ['TSLA', 'U']);
  const withX = clusterRawOcrTokens(['X TSLA', 'X TSLA'], { ...PRODUCTION_CLUSTER_OPTIONS, lexicon });
  assert.deepEqual(withX.merged_list, ['TSLA', 'X']);
});

test('clusterRawOcrTokens keeps single-letter tickers with the seed lexicon and production options', () => {
  const result = clusterRawOcrTokens(['U WEAT', 'U WEAT'], PRODUCTION_CLUSTER_OPTIONS);
  assert.ok(result.merged_list.includes('U'), `expected U in ${JSON.stringify(result.merged_list)}`);
});

test('clusterRawOcrTokens still drops non-allowlisted single letters and honors a stricter explicit minimum', () => {
  const lexicon = { tickerSet: new Set(['U', 'B']), tickers: ['U', 'B'] };
  assert.deepEqual(clusterRawOcrTokens(['B'], { ...PRODUCTION_CLUSTER_OPTIONS, lexicon }).merged_list, []);
  assert.deepEqual(clusterRawOcrTokens(['U'], { minTokenLength: 3, lexicon }).merged_list, []);
});

test('clusterRawOcrTokens does not canonicalize beyond the configured distance', () => {
  const result = clusterRawOcrTokens(['ABCD'], {
    maxDistance: 1,
    lexicon: {
      tickerSet: new Set(['ABCE']),
      tickers: ['ABCE']
    }
  });

  assert.deepEqual(result.merged_list, []);
});
