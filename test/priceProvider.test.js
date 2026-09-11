const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createYahooPriceProvider, selectPricePoint } = require('../src/analysis/priceProvider');

test('selectPricePoint chooses the previous trading day when the target date has no quote', () => {
  const point = selectPricePoint([
    { date: '2024-01-04', price: 100, source: 'adjclose' },
    { date: '2024-01-05', price: 101, source: 'adjclose' },
    { date: '2024-01-08', price: 102, source: 'adjclose' }
  ], '2024-01-06');

  assert.equal(point.date, '2024-01-05');
  assert.equal(point.lookupMode, 'previous_trading_day');
});

test('createYahooPriceProvider caches fetched series and reuses them offline', async () => {
  const cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-'));
  const sampleResponse = {
    chart: {
      result: [
        {
          indicators: {
            adjclose: [
              {
                adjclose: [100, 101, 102]
              }
            ],
            quote: [
              {
                close: [100, 101, 102]
              }
            ]
          },
          timestamp: [1704326400, 1704412800, 1704672000]
        }
      ]
    }
  };

  const onlineProvider = createYahooPriceProvider({
    cacheDirectory,
    requestJson: async () => sampleResponse
  });

  const onlineResult = await onlineProvider.getPositionPrices({
    entry_date: '2024-01-06',
    exit_date: '',
    is_open: 'true',
    mark_date: '2024-01-07',
    ticker: 'AAPL'
  });

  assert.equal(onlineResult.entryPrice, 101);
  assert.equal(onlineResult.entryPriceDate, '2024-01-05');
  assert.equal(onlineResult.markPrice, 101);
  assert.equal(onlineResult.priceStatus, 'ok_with_previous_close');

  const offlineProvider = createYahooPriceProvider({
    cacheDirectory,
    requestJson: async () => {
      throw new Error('network should not be hit after cache warmup');
    }
  });

  const offlinePoint = await offlineProvider.getPricePoint('AAPL', '2024-01-05');
  assert.equal(offlinePoint.price, 101);
  assert.equal(offlinePoint.priceStatus, 'ok');
});