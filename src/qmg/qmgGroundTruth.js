'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_GT_PATH = path.join(PROJECT_ROOT, 'data', 'qmg_ground_truth.json');

const MODE_DATE_SETS = Object.freeze({
  trade_ideas: new Set(['20220218', '20220222', '20220318']),
  sparse: new Set(['20220425', '20220426', '20221104']),
  dense_2023: new Set(['20230518', '20230523', '20230601', '20230602', '20230608', '20230609']),
});

function loadQmgGroundTruth(gtPath = DEFAULT_GT_PATH) {
  return JSON.parse(fs.readFileSync(gtPath, 'utf8'));
}

function isNumericCaptureKey(key) {
  return /^\d+$/.test(String(key || ''));
}

function listCaptureIndexesForDate(gt, dateKey) {
  const entry = gt && gt[dateKey];
  if (!entry || Array.isArray(entry)) return [];
  return Object.keys(entry)
    .filter(isNumericCaptureKey)
    .map((key) => Number(key))
    .sort((a, b) => a - b);
}

function normalizeGroundTruthEntry(entry) {
  if (!entry) return { crop: null, tickers: [] };
  if (Array.isArray(entry)) return { crop: null, tickers: entry.slice() };
  return {
    crop: Array.isArray(entry.crop) ? entry.crop.slice() : null,
    tickers: Array.isArray(entry.tickers) ? entry.tickers.slice() : [],
  };
}

function getGroundTruthForCapture(gt, dateKey, captureIndex) {
  const dateEntry = gt && gt[dateKey];
  if (!dateEntry) {
    return { captureIndex, crop: null, dateKey, mode: getGroundTruthMode(dateKey), tickers: [] };
  }
  if (Array.isArray(dateEntry)) {
    return { captureIndex, crop: null, dateKey, mode: getGroundTruthMode(dateKey), tickers: dateEntry.slice() };
  }
  const normalized = normalizeGroundTruthEntry(dateEntry[String(captureIndex)]);
  return {
    captureIndex,
    crop: normalized.crop,
    dateKey,
    mode: getGroundTruthMode(dateKey),
    tickers: normalized.tickers,
  };
}

function listGroundTruthCaptures(gt, options = {}) {
  const datesFilter = options.dates ? new Set(options.dates) : null;
  const modesFilter = options.modes ? new Set(options.modes) : null;
  const includeEmpty = Boolean(options.includeEmpty);
  const captures = [];

  for (const dateKey of Object.keys(gt || {}).sort()) {
    if (dateKey.startsWith('_')) continue;
    if (datesFilter && !datesFilter.has(dateKey)) continue;
    const mode = getGroundTruthMode(dateKey);
    if (modesFilter && !modesFilter.has(mode)) continue;

    const entry = gt[dateKey];
    if (Array.isArray(entry)) {
      if (includeEmpty || entry.length) {
        captures.push({ captureIndex: 0, crop: null, dateKey, mode, tickers: entry.slice() });
      }
      continue;
    }

    for (const captureIndex of listCaptureIndexesForDate(gt, dateKey)) {
      const capture = getGroundTruthForCapture(gt, dateKey, captureIndex);
      if (!includeEmpty && (!capture.tickers || capture.tickers.length === 0)) continue;
      captures.push(capture);
    }
  }

  return captures;
}

function getGroundTruthMode(dateKey) {
  for (const [mode, dateSet] of Object.entries(MODE_DATE_SETS)) {
    if (dateSet.has(dateKey)) return mode;
  }
  return 'normal_2022';
}

module.exports = {
  DEFAULT_GT_PATH,
  MODE_DATE_SETS,
  getGroundTruthForCapture,
  getGroundTruthMode,
  listCaptureIndexesForDate,
  listGroundTruthCaptures,
  loadQmgGroundTruth,
};
