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

  // The seed lexicon is a SET of tickers, and it may carry the same ticker on
  // more than one row (a ticker that was seeded for two different reasons).
  // `loadSeedLexiconSync` de-duplicates it for the same reason.
  //
  // The duplicate mattered because the legacy repair scores each seed entry
  // (`addScore(seedTokenScores, ..., 20)`), so a ticker listed twice carried
  // DOUBLE the correction support of one listed once — and the score is
  // multiplied by 10 in `findBestCorrection`, which is far more than an edit
  // costs (25 per edit). 13 tickers had double support, and 71 correction
  // targets flipped on that alone. `TEM` corrected to `TEAM` (a duplicated
  // ticker) instead of to itself, `IBIS` to `NBIS` instead of `IBIT`.
  const tickerSeeds = [...new Set(
    seedRows
      .filter((row) => normalizeBoolean(row.enabled, true) && row.ticker)
      .map((row) => normalizeTicker(row.ticker))
      .filter(Boolean)
  )];

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
