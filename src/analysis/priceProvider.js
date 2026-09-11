const fs = require('node:fs/promises');
const https = require('node:https');
const path = require('node:path');

const LOOKUP_PADDING_DAYS = 10;
const REQUEST_TIMEOUT_MS = 15000;

function parseDateKey(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date key: ${value}`);
  }

  return parsed;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDateKey(value, days) {
  const shifted = parseDateKey(value);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return formatDateKey(shifted);
}

function toUnixSeconds(value, addOneDay = false) {
  const parsed = parseDateKey(value);
  if (addOneDay) {
    parsed.setUTCDate(parsed.getUTCDate() + 1);
  }

  return Math.floor(parsed.getTime() / 1000);
}

function normalizeTickerSymbol(ticker) {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/\./g, '-');
}

function buildCacheFilePath(cacheDirectory, symbol) {
  return path.join(cacheDirectory, `${symbol}.json`);
}

async function readCacheFile(cacheFilePath) {
  try {
    const content = await fs.readFile(cacheFilePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function writeCacheFile(cacheFilePath, payload) {
  await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
  await fs.writeFile(cacheFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function mergePricePoints(existingPoints, incomingPoints) {
  const merged = new Map();

  for (const point of [...existingPoints, ...incomingPoints]) {
    if (!point || !point.date || !Number.isFinite(point.price)) {
      continue;
    }

    merged.set(point.date, point);
  }

  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function cacheCoversRange(cacheEntry, fromDate, toDate) {
  return Boolean(
    cacheEntry
    && cacheEntry.from_date
    && cacheEntry.to_date
    && Array.isArray(cacheEntry.prices)
    && cacheEntry.prices.length > 0
    && cacheEntry.from_date <= fromDate
    && cacheEntry.to_date >= toDate
  );
}

function defaultRequestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 ReverePortfolioAnalyzer'
      }
    }, (response) => {
      const { statusCode } = response;
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (statusCode !== 200) {
          reject(new Error(`Yahoo Finance request failed with status ${statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('Yahoo Finance request timed out'));
    });
    request.on('error', reject);
  });
}

function buildPricePoints(responsePayload) {
  const result = responsePayload && responsePayload.chart && Array.isArray(responsePayload.chart.result)
    ? responsePayload.chart.result[0]
    : null;
  if (!result || !Array.isArray(result.timestamp)) {
    return [];
  }

  const timestamps = result.timestamp;
  const closeSeries = result.indicators
    && Array.isArray(result.indicators.quote)
    && result.indicators.quote[0]
    && Array.isArray(result.indicators.quote[0].close)
    ? result.indicators.quote[0].close
    : [];
  const adjustedSeries = result.indicators
    && Array.isArray(result.indicators.adjclose)
    && result.indicators.adjclose[0]
    && Array.isArray(result.indicators.adjclose[0].adjclose)
    ? result.indicators.adjclose[0].adjclose
    : [];

  const points = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const adjustedClose = Number(adjustedSeries[index]);
    const close = Number(closeSeries[index]);
    const price = Number.isFinite(adjustedClose)
      ? adjustedClose
      : close;
    if (!Number.isFinite(price)) {
      continue;
    }

    points.push({
      date: formatDateKey(new Date(timestamp * 1000)),
      price: Number(price.toFixed(6)),
      source: Number.isFinite(adjustedClose) ? 'adjclose' : 'close'
    });
  }

  return points;
}

function selectPricePoint(points, targetDate) {
  if (!Array.isArray(points) || !points.length) {
    return null;
  }

  let bestPastOrSame = null;
  let bestFuture = null;
  for (const point of points) {
    if (point.date <= targetDate) {
      bestPastOrSame = point;
      continue;
    }

    bestFuture = point;
    break;
  }

  if (bestPastOrSame) {
    return {
      ...bestPastOrSame,
      lookupMode: bestPastOrSame.date === targetDate ? 'exact_or_same_day' : 'previous_trading_day'
    };
  }

  if (!bestFuture) {
    return null;
  }

  return {
    ...bestFuture,
    lookupMode: 'next_trading_day'
  };
}

function isOkStatus(value) {
  return String(value || '').startsWith('ok');
}

function summarizePositionPriceStatus(points) {
  const failedPoint = points.find((point) => point && !isOkStatus(point.priceStatus));
  if (failedPoint) {
    return failedPoint.priceStatus;
  }

  const modes = new Set(points.filter(Boolean).map((point) => point.lookupMode));
  if (modes.has('next_trading_day')) {
    return 'ok_with_forward_fill';
  }

  if (modes.has('previous_trading_day')) {
    return 'ok_with_previous_close';
  }

  return 'ok';
}

function createUnconfiguredPriceProvider() {
  return {
    async getPositionPrices(position) {
      return {
        entryPrice: '',
        entryPriceDate: '',
        exitPrice: '',
        exitPriceDate: '',
        markDate: position.mark_date || '',
        markPrice: '',
        markPriceDate: '',
        priceSource: 'none',
        priceStatus: 'provider_unconfigured'
      };
    },
    async getPricePoint() {
      return {
        price: '',
        priceDate: '',
        priceSource: 'none',
        priceStatus: 'provider_unconfigured'
      };
    }
  };
}

function createYahooPriceProvider(options = {}) {
  const cacheDirectory = options.cacheDirectory || path.join(process.cwd(), 'data', 'price_cache', 'yahoo');
  const requestJson = options.requestJson || defaultRequestJson;
  const inMemoryCache = new Map();

  async function loadTickerSeries(ticker, fromDate, toDate) {
    const symbol = normalizeTickerSymbol(ticker);
    if (!symbol) {
      return {
        prices: [],
        source: 'yahoo_chart',
        status: 'missing_ticker',
        symbol
      };
    }

    const cacheFilePath = buildCacheFilePath(cacheDirectory, symbol);
    let cacheEntry = inMemoryCache.get(symbol) || await readCacheFile(cacheFilePath);
    if (cacheEntry) {
      inMemoryCache.set(symbol, cacheEntry);
    }

    if (!cacheCoversRange(cacheEntry, fromDate, toDate)) {
      const requestedFrom = cacheEntry && cacheEntry.from_date && cacheEntry.from_date < fromDate
        ? cacheEntry.from_date
        : fromDate;
      const requestedTo = cacheEntry && cacheEntry.to_date && cacheEntry.to_date > toDate
        ? cacheEntry.to_date
        : toDate;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${toUnixSeconds(requestedFrom)}&period2=${toUnixSeconds(requestedTo, true)}&includeAdjustedClose=true`;

      try {
        const payload = await requestJson(url);
        const incomingPrices = buildPricePoints(payload);
        const mergedPrices = mergePricePoints(cacheEntry && Array.isArray(cacheEntry.prices) ? cacheEntry.prices : [], incomingPrices);
        cacheEntry = {
          fetched_at: new Date().toISOString(),
          from_date: requestedFrom,
          prices: mergedPrices,
          symbol,
          to_date: requestedTo
        };
        inMemoryCache.set(symbol, cacheEntry);
        await writeCacheFile(cacheFilePath, cacheEntry);
      } catch (error) {
        if (cacheEntry && Array.isArray(cacheEntry.prices) && cacheEntry.prices.length) {
          return {
            ...cacheEntry,
            source: 'yahoo_chart',
            status: 'cache_stale_network_error'
          };
        }

        return {
          error: error.message,
          prices: [],
          source: 'yahoo_chart',
          status: 'network_error',
          symbol
        };
      }
    }

    if (!cacheEntry || !Array.isArray(cacheEntry.prices) || cacheEntry.prices.length === 0) {
      return {
        ...(cacheEntry || { prices: [], symbol }),
        source: 'yahoo_chart',
        status: 'no_market_data'
      };
    }

    return {
      ...(cacheEntry || { prices: [], symbol }),
      source: 'yahoo_chart',
      status: 'ok'
    };
  }

  async function getPricePoint(ticker, targetDate) {
    if (!ticker || !targetDate) {
      return {
        price: '',
        priceDate: '',
        priceSource: 'yahoo_chart',
        priceStatus: 'missing_lookup_input'
      };
    }

    const fromDate = shiftDateKey(targetDate, -LOOKUP_PADDING_DAYS);
    const toDate = shiftDateKey(targetDate, LOOKUP_PADDING_DAYS);
    const series = await loadTickerSeries(ticker, fromDate, toDate);
    if (!Array.isArray(series.prices) || !series.prices.length) {
      return {
        price: '',
        priceDate: '',
        priceSource: 'yahoo_chart',
        priceStatus: series.status || 'no_market_data'
      };
    }

    const selectedPoint = selectPricePoint(series.prices, targetDate);
    if (!selectedPoint) {
      return {
        price: '',
        priceDate: '',
        priceSource: 'yahoo_chart',
        priceStatus: 'price_not_found'
      };
    }

    return {
      lookupMode: selectedPoint.lookupMode,
      price: selectedPoint.price,
      priceDate: selectedPoint.date,
      priceSource: `yahoo_chart_${selectedPoint.source}`,
      priceStatus: selectedPoint.lookupMode === 'exact_or_same_day'
        ? 'ok'
        : `ok_${selectedPoint.lookupMode}`
    };
  }

  async function getPositionPrices(position) {
    const entryPoint = await getPricePoint(position.ticker, position.entry_date);
    const exitPoint = position.exit_date
      ? await getPricePoint(position.ticker, position.exit_date)
      : null;
    const markPoint = position.is_open === 'true' && position.mark_date
      ? await getPricePoint(position.ticker, position.mark_date)
      : null;

    return {
      entryPrice: entryPoint.price,
      entryPriceDate: entryPoint.priceDate,
      exitPrice: exitPoint ? exitPoint.price : '',
      exitPriceDate: exitPoint ? exitPoint.priceDate : '',
      markDate: markPoint && markPoint.priceDate ? markPoint.priceDate : (position.mark_date || ''),
      markPrice: markPoint ? markPoint.price : '',
      markPriceDate: markPoint ? markPoint.priceDate : '',
      priceSource: [entryPoint, exitPoint, markPoint]
        .filter(Boolean)
        .map((point) => point.priceSource)
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join('|') || 'yahoo_chart',
      priceStatus: summarizePositionPriceStatus([entryPoint, exitPoint, markPoint])
    };
  }

  return {
    getPositionPrices,
    getPricePoint
  };
}

module.exports = {
  createUnconfiguredPriceProvider,
  createYahooPriceProvider,
  normalizeTickerSymbol,
  selectPricePoint
};