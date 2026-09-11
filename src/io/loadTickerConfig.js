const fs = require('node:fs/promises');
const path = require('node:path');

function normalizeBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return !['0', 'FALSE', 'NO', 'OFF'].includes(String(value).trim().toUpperCase());
}

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

async function loadCsvRows(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    if (!lines.length) {
      return [];
    }

    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseCsvLine(line);
      const row = {};
      for (let index = 0; index < headers.length; index += 1) {
        row[headers[index]] = values[index] || '';
      }

      return row;
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
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
