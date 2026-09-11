const path = require('node:path');

const { loadCsvRows } = require('./readCsv');

function splitPipeCell(value) {
  return String(value || '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseInteger(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumberOrBlank(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}

function mapSnapshotRow(row) {
  return {
    ...row,
    gro_actions: splitPipeCell(row.gro_actions),
    gro_holdings: splitPipeCell(row.gro_holdings),
    gro_repair_notes: splitPipeCell(row.gro_repair_notes),
    gro_suspicious_tickers: splitPipeCell(row.gro_suspicious_tickers),
    sequence: parseInteger(row.sequence),
    turbo_actions: splitPipeCell(row.turbo_actions),
    turbo_holdings: splitPipeCell(row.turbo_holdings),
    turbo_repair_notes: splitPipeCell(row.turbo_repair_notes),
    turbo_suspicious_tickers: splitPipeCell(row.turbo_suspicious_tickers)
  };
}

function mapPositionEventRow(row) {
  return {
    ...row,
    sequence: parseInteger(row.sequence)
  };
}

function mapPortfolioActionRow(row) {
  return {
    ...row,
    parsed_percent_value: parseNumberOrBlank(row.parsed_percent_value),
    sequence: parseInteger(row.sequence)
  };
}

function mapWhiteboardObservationRow(row) {
  return {
    ...row,
    actions: splitPipeCell(row.actions),
    ocr_confidence: parseNumberOrBlank(row.ocr_confidence),
    sequence: parseInteger(row.sequence)
  };
}

async function loadPortfolioSnapshots(dataDirectory) {
  const rows = await loadCsvRows(path.join(dataDirectory, 'portfolio_snapshots.csv'));
  return rows.map(mapSnapshotRow);
}

async function loadPositionEvents(dataDirectory, fileName = 'position_events.csv') {
  const rows = await loadCsvRows(path.join(dataDirectory, fileName));
  return rows.map(mapPositionEventRow);
}

async function loadPortfolioActions(dataDirectory, fileName = 'portfolio_actions.csv') {
  const rows = await loadCsvRows(path.join(dataDirectory, fileName));
  return rows.map(mapPortfolioActionRow);
}

async function loadWhiteboardObservations(dataDirectory, fileName = 'portfolio_whiteboard_observations.csv') {
  const rows = await loadCsvRows(path.join(dataDirectory, fileName));
  return rows.map(mapWhiteboardObservationRow);
}

module.exports = {
  loadPortfolioActions,
  loadPortfolioSnapshots,
  loadPositionEvents,
  loadWhiteboardObservations,
  parseNumberOrBlank,
  splitPipeCell
};