const path = require('node:path');

const { loadCsvRows } = require('./readCsv');

function normalizeBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return !['0', 'FALSE', 'NO', 'OFF'].includes(String(value).trim().toUpperCase());
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

async function loadTickerRepairConfig(configDirectory) {
  const lexiconPath = path.join(configDirectory, 'ticker_lexicon_seed.csv');
  const overridesPath = path.join(configDirectory, 'manual_ticker_overrides.csv');

  const seedRows = await loadCsvRows(lexiconPath);
  const overrideRows = await loadCsvRows(overridesPath);

  const tickerSeeds = seedRows
    .filter((row) => normalizeBoolean(row.enabled, true) && row.ticker)
    .map((row) => normalizeTicker(row.ticker))
    .filter(Boolean);

  const manualOverrides = overrideRows
    .filter((row) => normalizeBoolean(row.enabled, true) && row.raw_token)
    .map((row) => ({
      note: row.note || '',
      portfolio: normalizeTicker(row.portfolio || ''),
      rawToken: normalizeTicker(row.raw_token),
      replacementTokens: String(row.replacement || '')
        .split('|')
        .map(normalizeTicker)
        .filter(Boolean),
      sourceFile: String(row.source_file || '').trim()
    }));

  return {
    manualOverrides,
    tickerSeeds
  };
}

module.exports = {
  loadTickerRepairConfig
};
