const fs = require('node:fs/promises');
const path = require('node:path');

const { discoverScreenshots } = require('./io/discoverScreenshots');
const { loadTickerRepairConfig } = require('./io/loadTickerConfig');
const { resolveShortcutTarget } = require('./io/resolveShortcut');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIRECTORY = path.join(WORKSPACE_ROOT, 'config');
const DEFAULT_SHORTCUT = path.join(WORKSPACE_ROOT, 'sample_screenshots.lnk');
const OUTPUT_DIRECTORY = path.join(WORKSPACE_ROOT, 'data');

function parseArgs(argv) {
  const options = {
    command: 'extract'
  };
  const args = [...argv];

  if (args[0] && !args[0].startsWith('--')) {
    options.command = args.shift();
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const nextValue = args[index + 1];

    switch (argument) {
      case '--input':
      case '--input-dir':
        options.input = path.resolve(nextValue);
        index += 1;
        break;
      case '--shortcut':
        options.shortcut = path.resolve(nextValue);
        index += 1;
        break;
      case '--limit':
        options.limit = Number(nextValue);
        index += 1;
        break;
      case '--from':
        options.from = nextValue;
        index += 1;
        break;
      case '--to':
        options.to = nextValue;
        index += 1;
        break;
      case '--file':
        options.file = nextValue;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function ensureDirectoryExists(targetPath) {
  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    throw new Error(`${targetPath} is not a directory`);
  }
}

function normalizeDateKey(value) {
  return value ? value.replace(/-/g, '') : '';
}

function summarizeDateRange(rows) {
  let minDate = '';
  let maxDate = '';

  for (const row of rows) {
    if (!row || !row.as_of_date) {
      continue;
    }

    if (!minDate || row.as_of_date < minDate) {
      minDate = row.as_of_date;
    }

    if (!maxDate || row.as_of_date > maxDate) {
      maxDate = row.as_of_date;
    }
  }

  return {
    maxDate,
    minDate
  };
}

function collectPerformanceTickers(snapshots) {
  const tickers = [];

  for (const row of snapshots) {
    for (const portfolioKey of ['gro', 'turbo']) {
      const holdings = Array.isArray(row[`${portfolioKey}_holdings`]) ? row[`${portfolioKey}_holdings`] : [];
      tickers.push(...holdings);
    }
  }

  return tickers;
}

function filterScreenshots(screenshots, options) {
  const fromKey = normalizeDateKey(options.from);
  const toKey = normalizeDateKey(options.to);

  let filtered = screenshots;
  if (options.file) {
    filtered = filtered.filter((entry) => entry.fileName === options.file);
  }

  if (fromKey) {
    filtered = filtered.filter((entry) => entry.dateKey >= fromKey);
  }

  if (toKey) {
    filtered = filtered.filter((entry) => entry.dateKey <= toKey);
  }

  if (Number.isFinite(options.limit) && options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

async function resolveInputPath(options) {
  if (options.input) {
    return options.input;
  }

  const shortcutPath = options.shortcut || DEFAULT_SHORTCUT;
  return resolveShortcutTarget(shortcutPath);
}

async function runDiscover(options) {
  const inputPath = await resolveInputPath(options);
  await ensureDirectoryExists(inputPath);
  const screenshots = await discoverScreenshots(inputPath);
  const selectedScreenshots = filterScreenshots(screenshots, options);

  console.log(JSON.stringify({
    count: selectedScreenshots.length,
    files: selectedScreenshots,
    first: selectedScreenshots[0] || null,
    inputDir: inputPath,
    last: selectedScreenshots[selectedScreenshots.length - 1] || null
  }, null, 2));
}

async function runExtract(options) {
  const { PORTFOLIO_ACTION_COLUMNS, POSITION_EVENT_COLUMNS, SNAPSHOT_COLUMNS } = require('./config/schema');
  const { repairSnapshotRows } = require('./normalize/repairHoldings');
  const { closeWorker, ocrImage } = require('./ocr/ocrImage');
  const { parseScreenshot } = require('./parse/parseScreenshot');
  const { derivePortfolioActions } = require('./report/derivePortfolioActions');
  const { derivePositionEvents } = require('./report/derivePositionEvents');
  const { writeCsv } = require('./write/writeCsv');
  const inputPath = await resolveInputPath(options);
  await ensureDirectoryExists(inputPath);

  const screenshots = await discoverScreenshots(inputPath);
  const selectedScreenshots = filterScreenshots(screenshots, options);
  if (!selectedScreenshots.length) {
    throw new Error('No screenshots matched the current filters.');
  }
  const tickerRepairConfig = await loadTickerRepairConfig(CONFIG_DIRECTORY);

  console.log(`Resolved screenshot directory: ${inputPath}`);
  console.log(`Found ${screenshots.length} dated screenshot files.`);
  console.log(`Processing ${selectedScreenshots.length} screenshot(s)...`);

  const snapshotRows = [];
  for (const screenshot of selectedScreenshots) {
    console.log(`OCR ${screenshot.fileName}`);
    const ocr = await ocrImage(screenshot.fullPath);
    const parsed = parseScreenshot({ metadata: screenshot, ocr });
    snapshotRows.push(parsed);
  }

  const repairedSnapshotRows = repairSnapshotRows(snapshotRows, tickerRepairConfig);

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_snapshots.csv'),
    SNAPSHOT_COLUMNS,
    repairedSnapshotRows
  );

  const reviewRows = repairedSnapshotRows.filter((row) => row.parse_status !== 'ok' || row.issue_codes);
  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'review_queue.csv'),
    SNAPSHOT_COLUMNS,
    reviewRows
  );

  const portfolioActions = derivePortfolioActions(repairedSnapshotRows);
  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_actions.csv'),
    PORTFOLIO_ACTION_COLUMNS,
    portfolioActions.trustedRows
  );

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_actions_review.csv'),
    PORTFOLIO_ACTION_COLUMNS,
    portfolioActions.reviewRows
  );

  const positionEvents = derivePositionEvents(repairedSnapshotRows);
  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'position_events.csv'),
    POSITION_EVENT_COLUMNS,
    positionEvents.trustedEvents
  );

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'position_events_review.csv'),
    POSITION_EVENT_COLUMNS,
    positionEvents.reviewEvents
  );

  console.log(`Wrote ${repairedSnapshotRows.length} snapshot rows.`);
  console.log(`Wrote ${reviewRows.length} review rows.`);
  console.log(`Wrote ${portfolioActions.trustedRows.length} trusted action rows.`);
  console.log(`Wrote ${portfolioActions.reviewRows.length} review action rows.`);
  console.log(`Wrote ${positionEvents.trustedEvents.length} trusted position events.`);
  console.log(`Wrote ${positionEvents.reviewEvents.length} review position events.`);
}

async function runPerformance() {
  const {
    PERFORMANCE_REVIEW_COLUMNS,
    PORTFOLIO_PERFORMANCE_TIMESERIES_COLUMNS,
    POSITION_PERFORMANCE_COLUMNS,
    POSITION_PERFORMANCE_SUMMARY_COLUMNS
  } = require('./config/schema');
  const { calculatePerformance } = require('./analysis/calculatePerformance');
  const { createUnconfiguredPriceProvider, createYahooPriceProvider } = require('./analysis/priceProvider');
  const {
    loadPortfolioActions,
    loadPortfolioSnapshots,
    loadPositionEvents
  } = require('./io/loadExtractedData');
  const { writeCsv } = require('./write/writeCsv');

  const snapshots = await loadPortfolioSnapshots(OUTPUT_DIRECTORY);
  const positionEvents = await loadPositionEvents(OUTPUT_DIRECTORY, 'position_events.csv');
  const portfolioActions = await loadPortfolioActions(OUTPUT_DIRECTORY, 'portfolio_actions.csv');
  const portfolioActionReviews = await loadPortfolioActions(OUTPUT_DIRECTORY, 'portfolio_actions_review.csv');

  if (!snapshots.length) {
    throw new Error('No extracted snapshot data found. Run `npm run extract` first.');
  }

  if (!portfolioActions.length && !portfolioActionReviews.length) {
    throw new Error('No extracted action-ledger data found. Re-run `npm run extract` with the current extractor first.');
  }

  const snapshotDateRange = summarizeDateRange(snapshots);

  const priceProvider = process.env.REVERE_PRICE_SOURCE === 'none'
    ? createUnconfiguredPriceProvider()
    : createYahooPriceProvider({
      cacheDirectory: path.join(OUTPUT_DIRECTORY, 'price_cache', 'yahoo'),
      defaultFromDate: snapshotDateRange.minDate,
      defaultToDate: snapshotDateRange.maxDate
    });

  if (typeof priceProvider.prefetchTickers === 'function') {
    await priceProvider.prefetchTickers(collectPerformanceTickers(snapshots));
  }

  const performance = await calculatePerformance({
    actionReviewRows: portfolioActionReviews,
    actionRows: portfolioActions,
    events: positionEvents,
    priceProvider,
    snapshots
  });

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'position_performance.csv'),
    POSITION_PERFORMANCE_COLUMNS,
    performance.positionRows
  );

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_performance_summary.csv'),
    POSITION_PERFORMANCE_SUMMARY_COLUMNS,
    performance.summaryRows
  );

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_performance_timeseries.csv'),
    PORTFOLIO_PERFORMANCE_TIMESERIES_COLUMNS,
    performance.curveRows
  );

  await writeCsv(
    path.join(OUTPUT_DIRECTORY, 'portfolio_performance_review.csv'),
    PERFORMANCE_REVIEW_COLUMNS,
    performance.reviewRows
  );

  console.log(`Wrote ${performance.positionRows.length} position performance rows.`);
  console.log(`Wrote ${performance.summaryRows.length} portfolio performance summary rows.`);
  console.log(`Wrote ${performance.curveRows.length} portfolio performance timeseries rows.`);
  console.log(`Wrote ${performance.reviewRows.length} portfolio performance review rows.`);
  console.log(`Price provider status: ${process.env.REVERE_PRICE_SOURCE === 'none' ? 'provider_unconfigured' : 'yahoo_chart'}`);
}

async function runReport() {
  const { generatePerformanceReport } = require('./report/generatePerformanceReport');

  const report = await generatePerformanceReport({
    dataDirectory: OUTPUT_DIRECTORY,
    outputDirectory: path.join(OUTPUT_DIRECTORY, 'report')
  });

  console.log(`Wrote performance report: ${report.outputPath}`);
  console.log(`Summary rows: ${report.summaryCount}`);
  console.log(`Timeseries rows: ${report.timeseriesCount}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === 'discover') {
    await runDiscover(options);
    return;
  }

  if (options.command === 'extract') {
    await runExtract(options);
    return;
  }

  if (options.command === 'performance') {
    await runPerformance(options);
    return;
  }

  if (options.command === 'report') {
    await runReport(options);
    return;
  }

  throw new Error(`Unsupported command: ${options.command}`);
}

async function shutdown() {
  try {
    const { closeWorker } = require('./ocr/ocrImage');
    await closeWorker();
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
  });