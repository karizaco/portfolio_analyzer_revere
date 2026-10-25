'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clusterRawOcrTokens
} = require('../src/parse/parseChartStream');

test('clusterRawOcrTokens respects an explicitly supplied minimum token length', () => {
  const result = clusterRawOcrTokens(['U'], {
    minTokenLength: 2,
    lexicon: {
      tickerSet: new Set(['U']),
      tickers: ['U']
    }
  });

  assert.deepEqual(result.merged_list, []);
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
