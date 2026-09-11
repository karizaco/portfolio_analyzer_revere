const test = require('node:test');
const assert = require('node:assert/strict');

const { parseActionText, splitActionFragments } = require('../src/report/derivePortfolioActions');

test('splitActionFragments separates repeated percent instructions', () => {
  assert.deepEqual(splitActionFragments('2% FCX & 5% DIA'), ['2% FCX', '5% DIA']);
});

test('parseActionText emits one trusted row per distinct percent fragment', () => {
  const result = parseActionText({
    actionDate: '2022-09-22',
    actionText: 'SELL 4% CMG, 1.5% TSLA, 10% SSO',
    portfolio: 'GRO',
    referenceScores: new Map(),
    sequence: 1,
    sourceFile: 'revere_20220922.png'
  });

  assert.equal(result.reviewRows.length, 0);
  assert.deepEqual(
    result.trustedRows.map((row) => [row.action_type, row.ticker, row.parsed_percent_text, row.parsed_percent_value]),
    [
      ['SELL', 'CMG', '4%', '4'],
      ['SELL', 'TSLA', '1.5%', '1.5'],
      ['SELL', 'SSO', '10%', '10']
    ]
  );
});

test('parseActionText splits mixed BUY percentages into separate trusted rows', () => {
  const result = parseActionText({
    actionDate: '2022-12-27',
    actionText: 'BUY 2% FCX & 5% DIA',
    portfolio: 'GRO',
    referenceScores: new Map(),
    sequence: 1,
    sourceFile: 'revere_20221227.png'
  });

  assert.equal(result.reviewRows.length, 0);
  assert.deepEqual(
    result.trustedRows.map((row) => [row.action_type, row.ticker, row.parsed_percent_text]),
    [
      ['BUY', 'FCX', '2%'],
      ['BUY', 'DIA', '5%']
    ]
  );
});

test('parseActionText routes shared percent multi-ticker fragments to review', () => {
  const result = parseActionText({
    actionDate: '2024-01-01',
    actionText: 'BUY 5% QLD + TSLA',
    portfolio: 'GRO',
    referenceScores: new Map(),
    sequence: 1,
    sourceFile: 'sample.png'
  });

  assert.equal(result.trustedRows.length, 0);
  assert.deepEqual(
    result.reviewRows.map((row) => [row.action_type, row.ticker, row.parse_basis, row.parsed_percent_text]),
    [
      ['BUY', 'QLD', 'ambiguous_percent_multi_ticker', '5%'],
      ['BUY', 'TSLA', 'ambiguous_percent_multi_ticker', '5%']
    ]
  );
});

test('parseActionText ignores NO CHANGES', () => {
  const result = parseActionText({
    actionDate: '2024-01-01',
    actionText: 'NO CHANGES',
    portfolio: 'GRO',
    referenceScores: new Map(),
    sequence: 1,
    sourceFile: 'sample.png'
  });

  assert.equal(result.trustedRows.length, 0);
  assert.equal(result.reviewRows.length, 0);
});