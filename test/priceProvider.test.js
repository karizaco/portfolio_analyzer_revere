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

test('createYahooPriceProvider caches empty histories and avoids repeated network fetches', async () => {
  let requestCount = 0;
  const provider = createYahooPriceProvider({
    cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-empty-')),
    requestJson: async () => {
      requestCount += 1;
      return {
        chart: {
          result: []
        }
      };
    }
  });

  const first = await provider.getPricePoint('BI', '2024-01-05');
  const second = await provider.getPricePoint('BI', '2024-01-10');

  assert.equal(first.priceStatus, 'no_market_data');
  assert.equal(second.priceStatus, 'no_market_data');
  assert.equal(requestCount, 1);
});

test('createYahooPriceProvider uses dataset-wide default ranges to avoid repeated range expansion', async () => {
  let requestCount = 0;
  const provider = createYahooPriceProvider({
    cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-range-')),
    defaultFromDate: '2022-09-22',
    defaultToDate: '2026-09-10',
    requestJson: async () => {
      requestCount += 1;
      return {
        chart: {
          result: [
            {
              indicators: {
                adjclose: [
                  {
                    adjclose: [100, 110]
                  }
                ],
                quote: [
                  {
                    close: [100, 110]
                  }
                ]
              },
              timestamp: [1663804800, 1788998400]
            }
          ]
        }
      };
    }
  });

  const first = await provider.getPricePoint('AAPL', '2022-09-22');
  const second = await provider.getPricePoint('AAPL', '2026-09-10');

  assert.equal(first.priceStatus, 'ok');
  assert.equal(second.priceStatus, 'ok');
  assert.equal(requestCount, 1);
});

test('createYahooPriceProvider retries a ticker after a transient network_error cache entry', async () => {
  const cacheDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-retry-'));
  let requestIndex = 0;
  const responses = [
    () => { throw new Error('transient network error'); },
    () => ({
      chart: {
        result: [
          {
            indicators: {
              adjclose: [{ adjclose: [100, 105] }],
              quote: [{ close: [100, 105] }]
            },
            timestamp: [1704326400, 1704412800]
          }
        ]
      }
    })
  ];
  const provider = createYahooPriceProvider({
    cacheDirectory,
    requestJson: async () => {
      const handler = responses[Math.min(requestIndex, responses.length - 1)];
      requestIndex += 1;
      return handler();
    }
  });

  const first = await provider.getPricePoint('RETRY', '2024-01-05');
  assert.equal(first.priceStatus, 'network_error');

  // Second lookup must re-attempt the fetch. Both the in-memory series cache
  // (cacheCoversRange must NOT treat an empty-prices `network_error` entry as
  // covering the range) AND the per-(ticker,date) point lookup cache must
  // evict the failed promise — otherwise the cached rejected lookup is
  // returned without ever calling loadTickerSeries again.
  const second = await provider.getPricePoint('RETRY', '2024-01-05');
  assert.equal(second.priceStatus, 'ok');
  assert.equal(second.price, 105);
  assert.equal(requestIndex, 2);

  // Successful lookups for the same (ticker, date) are still cached — a third
  // call must hit the in-flight cache and not trigger another fetch.
  const third = await provider.getPricePoint('RETRY', '2024-01-05');
  assert.equal(third.priceStatus, 'ok');
  assert.equal(third.price, 105);
  assert.equal(requestIndex, 2);
});

test('createYahooPriceProvider still caches empty histories (no_market_data) terminally', async () => {
  // Sanity check that the network_error retry fix did not regress the
  // `no_market_data` terminal-cache behaviour: a genuinely empty Yahoo
  // response must still be cached as terminal so we do not hammer Yahoo
  // for tickers it will never have.
  let requestCount = 0;
  const provider = createYahooPriceProvider({
    cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-nomd-')),
    requestJson: async () => {
      requestCount += 1;
      return { chart: { result: [] } };
    }
  });

  const first = await provider.getPricePoint('NOMD', '2024-01-05');
  const second = await provider.getPricePoint('NOMD', '2024-01-10');
  assert.equal(first.priceStatus, 'no_market_data');
  assert.equal(second.priceStatus, 'no_market_data');
  assert.equal(requestCount, 1);
});

test('createYahooPriceProvider prefetches multiple tickers with shared ranges', async () => {
  let requestCount = 0;
  const provider = createYahooPriceProvider({
    cacheDirectory: await fs.mkdtemp(path.join(os.tmpdir(), 'revere-price-cache-prefetch-')),
    defaultFromDate: '2022-09-22',
    defaultToDate: '2026-09-10',
    prefetchConcurrency: 2,
    requestJson: async () => {
      requestCount += 1;
      return {
        chart: {
          result: [
            {
              indicators: {
                adjclose: [
                  {
                    adjclose: [100, 110]
                  }
                ],
                quote: [
                  {
                    close: [100, 110]
                  }
                ]
              },
              timestamp: [1663804800, 1788998400]
            }
          ]
        }
      };
    }
  });

  await provider.prefetchTickers(['AAPL', 'MSFT', 'AAPL']);

  const aapl = await provider.getPricePoint('AAPL', '2026-09-10');
  const msft = await provider.getPricePoint('MSFT', '2026-09-10');
  assert.equal(aapl.priceStatus, 'ok');
  assert.equal(msft.priceStatus, 'ok');
  assert.equal(requestCount, 2);
});