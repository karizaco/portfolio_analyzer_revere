const test = require('node:test');
const assert = require('node:assert/strict');

const { calculatePerformance } = require('../src/analysis/calculatePerformance');

function createMockPriceProvider(priceTable) {
  return {
    async getPricePoint(ticker, targetDate) {
      const tickerTable = priceTable[ticker] || {};
      if (!tickerTable[targetDate]) {
        return {
          price: '',
          priceDate: '',
          priceSource: 'mock',
          priceStatus: 'missing_price'
        };
      }

      return {
        lookupMode: 'exact_or_same_day',
        price: tickerTable[targetDate],
        priceDate: targetDate,
        priceSource: 'mock',
        priceStatus: 'ok'
      };
    },
    async getPositionPrices(position) {
      const entryPoint = await this.getPricePoint(position.ticker, position.entry_date);
      const exitPoint = position.exit_date ? await this.getPricePoint(position.ticker, position.exit_date) : null;
      const markPoint = position.is_open === 'true' && position.mark_date
        ? await this.getPricePoint(position.ticker, position.mark_date)
        : null;

      return {
        entryPrice: entryPoint.price,
        entryPriceDate: entryPoint.priceDate,
        exitPrice: exitPoint ? exitPoint.price : '',
        exitPriceDate: exitPoint ? exitPoint.priceDate : '',
        markDate: markPoint ? markPoint.priceDate : position.mark_date,
        markPrice: markPoint ? markPoint.price : '',
        markPriceDate: markPoint ? markPoint.priceDate : '',
        priceSource: 'mock',
        priceStatus: 'ok'
      };
    }
  };
}

test('calculatePerformance synthesizes baseline entries and closes positions from trusted events', async () => {
  const snapshots = [
    {
      as_of_date: '2024-01-01',
      gro_holdings: ['AAPL', 'MSFT'],
      gro_metric_1: '1.00',
      gro_metric_2: '0.95',
      gro_metric_scalar: '',
      sequence: 1,
      source_file: 'revere_20240101.png',
      turbo_holdings: []
    },
    {
      as_of_date: '2024-01-10',
      gro_holdings: ['MSFT', 'NVDA'],
      gro_metric_1: '1.10',
      gro_metric_2: '1.02',
      gro_metric_scalar: '',
      sequence: 1,
      source_file: 'revere_20240110.png',
      turbo_holdings: []
    }
  ];

  const events = [
    {
      event_date: '2024-01-10',
      event_type: 'EXIT',
      portfolio: 'GRO',
      previous_source_file: 'revere_20240101.png',
      sequence: 1,
      source_file: 'revere_20240110.png',
      ticker: 'AAPL'
    },
    {
      event_date: '2024-01-10',
      event_type: 'ENTER',
      portfolio: 'GRO',
      previous_source_file: 'revere_20240101.png',
      sequence: 1,
      source_file: 'revere_20240110.png',
      ticker: 'NVDA'
    }
  ];

  const actionRows = [
    {
      action_context: 'SELL AAPL BUY 4% NVDA',
      action_date: '2024-01-10',
      action_status: 'trusted',
      action_type: 'SELL',
      parse_basis: 'single_ticker_fragment',
      parsed_percent_text: '',
      parsed_percent_value: '',
      portfolio: 'GRO',
      raw_fragment: 'AAPL',
      sequence: 1,
      source_file: 'revere_20240110.png',
      ticker: 'AAPL'
    },
    {
      action_context: 'SELL AAPL BUY 4% NVDA',
      action_date: '2024-01-10',
      action_status: 'trusted',
      action_type: 'BUY',
      parse_basis: 'single_ticker_fragment',
      parsed_percent_text: '4%',
      parsed_percent_value: 4,
      portfolio: 'GRO',
      raw_fragment: '4% NVDA',
      sequence: 1,
      source_file: 'revere_20240110.png',
      ticker: 'NVDA'
    }
  ];

  const priceProvider = createMockPriceProvider({
    AAPL: {
      '2024-01-01': 100,
      '2024-01-10': 110
    },
    MSFT: {
      '2024-01-01': 200,
      '2024-01-10': 210
    },
    NVDA: {
      '2024-01-10': 55,
      '2024-01-15': 57
    }
  });

  const result = await calculatePerformance({
    actionReviewRows: [],
    actionRows,
    events,
    priceProvider,
    snapshots
  });
  const rowsByTicker = new Map(result.positionRows.map((row) => [row.ticker, row]));

  assert.equal(result.positionRows.length, 3);
  assert.deepEqual(
    result.positionRows.map((row) => [row.ticker, row.entry_origin, row.is_open, row.entry_sizing_method, row.return_pct]),
    [
      ['AAPL', 'baseline', 'false', 'baseline_equal_weight', '10'],
      ['MSFT', 'baseline', 'true', 'baseline_equal_weight', '5'],
      ['NVDA', 'event', 'true', 'explicit_action_percent', '0']
    ]
  );
  assert.equal(result.summaryRows[0].closed_positions, 1);
  assert.equal(result.summaryRows[0].open_positions, 2);
  assert.equal(result.curveRows.length, 2);
  assert.equal(result.curveRows[1].estimated_equity_index, '1.075');
  assert.equal(result.curveRows[1].cash_weight, '0.471628');
  assert.equal(result.curveRows[1].weighted_exposure, '0.528372');
  assert.equal(rowsByTicker.get('MSFT').current_weight_fraction, '0.488372');
  assert.equal(rowsByTicker.get('NVDA').current_weight_fraction, '0.04');
});

test('calculatePerformance attaches trusted ADD/TRIM rows as lifecycle adjustments', async () => {
  const snapshots = [
    {
      as_of_date: '2024-02-01',
      gro_holdings: ['UBER', 'MSFT'],
      gro_metric_1: '1.00',
      gro_metric_2: '0.90',
      gro_metric_scalar: '',
      sequence: 1,
      source_file: 'revere_20240201.png',
      turbo_holdings: []
    },
    {
      as_of_date: '2024-02-15',
      gro_holdings: ['UBER', 'MSFT'],
      gro_metric_1: '1.02',
      gro_metric_2: '0.92',
      gro_metric_scalar: '',
      sequence: 1,
      source_file: 'revere_20240215.png',
      turbo_holdings: []
    }
  ];

  const actionRows = [
    {
      action_context: 'ADD 5% UBER',
      action_date: '2024-02-15',
      action_status: 'trusted',
      action_type: 'ADD',
      parse_basis: 'single_ticker_fragment',
      parsed_percent_text: '5%',
      parsed_percent_value: 5,
      portfolio: 'GRO',
      raw_fragment: '5% UBER',
      sequence: 1,
      source_file: 'revere_20240215.png',
      ticker: 'UBER'
    }
  ];

  const result = await calculatePerformance({
    actionReviewRows: [],
    actionRows,
    events: [],
    priceProvider: createMockPriceProvider({
      UBER: {
        '2024-02-01': 10,
        '2024-02-15': 10.5
      },
      MSFT: {
        '2024-02-01': 20,
        '2024-02-15': 20
      }
    }),
    snapshots
  });
  const rowsByTicker = new Map(result.positionRows.map((row) => [row.ticker, row]));

  assert.equal(result.positionRows.length, 2);
  assert.equal(rowsByTicker.get('UBER').adjustment_count, 1);
  assert.equal(rowsByTicker.get('UBER').adjustment_percent_total, '5');
  assert.equal(result.reviewRows.length, 0);
  assert.equal(result.curveRows[1].estimated_equity_index, '1.025');
  assert.equal(result.curveRows[1].cash_weight, '0');
  assert.equal(result.curveRows[1].weighted_exposure, '1');
  assert.equal(rowsByTicker.get('UBER').current_weight_fraction, '0.562195');
  assert.equal(rowsByTicker.get('MSFT').current_weight_fraction, '0.437805');
});