const fs = require('node:fs/promises');
const path = require('node:path');

const { loadCsvRows } = require('../io/readCsv');

const PORTFOLIO_COLORS = {
  GRO: '#bf360c',
  TURBO: '#0d47a1'
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSummaryRows(rows) {
  return rows.map((row) => ({
    ...row,
    assumed_equal_weight_entries: parseNumber(row.assumed_equal_weight_entries),
    baseline_positions: parseNumber(row.baseline_positions),
    cash_weight: parseNumber(row.cash_weight),
    closed_positions: parseNumber(row.closed_positions),
    estimated_equity_index: parseNumber(row.estimated_equity_index),
    explicit_weight_entries: parseNumber(row.explicit_weight_entries),
    invested_weight: parseNumber(row.invested_weight),
    open_positions: parseNumber(row.open_positions),
    review_rows: parseNumber(row.review_rows),
    total_adjustments: parseNumber(row.total_adjustments),
    unpriced_positions: parseNumber(row.unpriced_positions)
  }));
}

function normalizeTimeseriesRows(rows) {
  return rows.map((row) => ({
    ...row,
    cash_weight: parseNumber(row.cash_weight),
    estimated_equity_index: parseNumber(row.estimated_equity_index),
    open_positions: parseNumber(row.open_positions),
    priced_positions: parseNumber(row.priced_positions),
    unpriced_positions: parseNumber(row.unpriced_positions),
    weighted_exposure: parseNumber(row.weighted_exposure)
  }));
}

function groupByPortfolio(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const current = grouped.get(row.portfolio) || [];
    current.push(row);
    grouped.set(row.portfolio, current);
  }

  return grouped;
}

function formatMultiple(value) {
  return value === null ? 'n/a' : `${value.toFixed(2)}x`;
}

function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatCount(value) {
  return value === null ? 'n/a' : String(value);
}

function buildLinePath(values, width, height, padding) {
  const validValues = values.filter((value) => value !== null);
  if (!validValues.length) {
    return '';
  }

  let minValue = Math.min(...validValues);
  let maxValue = Math.max(...validValues);
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const stepX = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  let pathData = '';
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null) {
      continue;
    }

    const x = padding.left + (stepX * index);
    const normalizedY = (value - minValue) / (maxValue - minValue);
    const y = padding.top + innerHeight - (normalizedY * innerHeight);
    pathData += `${pathData ? ' L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  return pathData;
}

function buildGridLines(values, width, height, padding, formatter) {
  const validValues = values.filter((value) => value !== null);
  if (!validValues.length) {
    return '';
  }

  let minValue = Math.min(...validValues);
  let maxValue = Math.max(...validValues);
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }

  const innerHeight = height - padding.top - padding.bottom;
  const tickCount = 4;
  const lines = [];
  for (let tickIndex = 0; tickIndex <= tickCount; tickIndex += 1) {
    const ratio = tickIndex / tickCount;
    const y = padding.top + innerHeight - (innerHeight * ratio);
    const value = minValue + ((maxValue - minValue) * ratio);
    lines.push(`
      <line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${width - padding.right}" y2="${y.toFixed(2)}" />
      <text x="${padding.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(formatter(value))}</text>
    `);
  }

  return lines.join('');
}

function buildChart({ dates, formatter, series, title }) {
  const width = 760;
  const height = 260;
  const padding = { bottom: 36, left: 64, right: 18, top: 24 };
  const allValues = series.flatMap((item) => item.values);
  const gridLines = buildGridLines(allValues, width, height, padding, formatter);

  const lineMarkup = series.map((item) => `
    <path d="${buildLinePath(item.values, width, height, padding)}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
  `).join('');

  return `
    <section class="chart-card">
      <div class="chart-head">
        <h3>${escapeHtml(title)}</h3>
        <div class="legend">${series.map((item) => `<span><i style="background:${item.color}"></i>${escapeHtml(item.label)}</span>`).join('')}</div>
      </div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
        <g class="grid">${gridLines}</g>
        <g class="series">${lineMarkup}</g>
        <text x="${padding.left}" y="${height - 10}">${escapeHtml(dates[0] || '')}</text>
        <text x="${width - padding.right}" y="${height - 10}" text-anchor="end">${escapeHtml(dates[dates.length - 1] || '')}</text>
      </svg>
    </section>
  `;
}

function buildPortfolioSection(summaryRow, timeseriesRows) {
  const color = PORTFOLIO_COLORS[summaryRow.portfolio] || '#455a64';
  const dates = timeseriesRows.map((row) => row.as_of_date);

  return `
    <section class="portfolio-panel">
      <header class="portfolio-head" style="--portfolio-accent:${color}">
        <div>
          <p class="eyebrow">Portfolio</p>
          <h2>${escapeHtml(summaryRow.portfolio)}</h2>
          <p class="status">As of ${escapeHtml(summaryRow.as_of_date)} · ${escapeHtml(summaryRow.price_status)}</p>
        </div>
        <div class="headline-metrics">
          <div><span>Equity Index</span><strong>${escapeHtml(formatMultiple(summaryRow.estimated_equity_index))}</strong></div>
          <div><span>Invested</span><strong>${escapeHtml(formatPercent(summaryRow.invested_weight))}</strong></div>
          <div><span>Cash</span><strong>${escapeHtml(formatPercent(summaryRow.cash_weight))}</strong></div>
        </div>
      </header>
      <div class="mini-grid">
        <article><span>Open Positions</span><strong>${escapeHtml(formatCount(summaryRow.open_positions))}</strong></article>
        <article><span>Closed Positions</span><strong>${escapeHtml(formatCount(summaryRow.closed_positions))}</strong></article>
        <article><span>Adjustments</span><strong>${escapeHtml(formatCount(summaryRow.total_adjustments))}</strong></article>
        <article><span>Review Rows</span><strong>${escapeHtml(formatCount(summaryRow.review_rows))}</strong></article>
        <article><span>Unpriced Positions</span><strong>${escapeHtml(formatCount(summaryRow.unpriced_positions))}</strong></article>
        <article><span>Fallback Entries</span><strong>${escapeHtml(formatCount(summaryRow.assumed_equal_weight_entries))}</strong></article>
      </div>
      <div class="chart-grid">
        ${buildChart({
          dates,
          formatter: (value) => `${value.toFixed(2)}x`,
          series: [
            {
              color,
              label: 'Equity Index',
              values: timeseriesRows.map((row) => row.estimated_equity_index)
            }
          ],
          title: `${summaryRow.portfolio} Estimated Equity Index`
        })}
        ${buildChart({
          dates,
          formatter: (value) => `${(value * 100).toFixed(0)}%`,
          series: [
            {
              color,
              label: 'Invested',
              values: timeseriesRows.map((row) => row.weighted_exposure)
            },
            {
              color: '#d7ccc8',
              label: 'Cash',
              values: timeseriesRows.map((row) => row.cash_weight)
            }
          ],
          title: `${summaryRow.portfolio} Capital Mix`
        })}
      </div>
    </section>
  `;
}

function buildReportHtml({ generatedAt, summaryRows, timeseriesRows }) {
  const groupedTimeseries = groupByPortfolio(timeseriesRows);
  const portfolioPanels = summaryRows.map((row) => buildPortfolioSection(row, groupedTimeseries.get(row.portfolio) || [])).join('');
  const totalReviewRows = summaryRows.reduce((sum, row) => sum + (row.review_rows || 0), 0);
  const totalUnpriced = summaryRows.reduce((sum, row) => sum + (row.unpriced_positions || 0), 0);
  const averageEquity = summaryRows.length
    ? summaryRows.reduce((sum, row) => sum + (row.estimated_equity_index || 0), 0) / summaryRows.length
    : null;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Revere Portfolio Report</title>
  <style>
    :root {
      --bg: #f3ede2;
      --panel: rgba(255,255,255,0.72);
      --ink: #17212b;
      --muted: #5f6d79;
      --line: rgba(23,33,43,0.12);
      --shadow: 0 18px 40px rgba(32, 21, 10, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(255, 214, 165, 0.65), transparent 34%),
        radial-gradient(circle at top right, rgba(179, 229, 252, 0.7), transparent 30%),
        linear-gradient(180deg, #f3ede2 0%, #efe6d9 45%, #e4eef5 100%);
      font-family: Aptos, "Segoe UI", Tahoma, sans-serif;
      min-height: 100vh;
    }
    main {
      width: min(1160px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 32px 0 64px;
    }
    .hero, .portfolio-panel, .data-footnote {
      background: var(--panel);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.45);
      border-radius: 28px;
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 32px;
      overflow: hidden;
      position: relative;
    }
    .hero::after {
      content: '';
      position: absolute;
      inset: auto -60px -70px auto;
      width: 240px;
      height: 240px;
      border-radius: 999px;
      background: rgba(191, 54, 12, 0.08);
    }
    .kicker {
      font-size: 0.8rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 10px;
    }
    h1, h2, h3 {
      font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif;
      margin: 0;
    }
    h1 { font-size: clamp(2rem, 4vw, 3.3rem); line-height: 1.05; max-width: 11ch; }
    .hero p.copy {
      max-width: 70ch;
      color: var(--muted);
      line-height: 1.55;
      margin: 14px 0 0;
    }
    .hero-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-top: 24px;
    }
    .hero-grid article, .mini-grid article {
      border-radius: 18px;
      background: rgba(255,255,255,0.72);
      padding: 16px 18px;
      border: 1px solid rgba(23,33,43,0.06);
    }
    .hero-grid span, .mini-grid span, .headline-metrics span {
      display: block;
      color: var(--muted);
      font-size: 0.82rem;
      margin-bottom: 6px;
    }
    .hero-grid strong, .mini-grid strong, .headline-metrics strong {
      font-size: 1.25rem;
      font-weight: 700;
    }
    .portfolio-stack {
      display: grid;
      gap: 24px;
      margin-top: 26px;
    }
    .portfolio-panel { padding: 24px; }
    .portfolio-head {
      display: flex;
      gap: 18px;
      justify-content: space-between;
      align-items: end;
      border-bottom: 1px solid rgba(23,33,43,0.08);
      padding-bottom: 18px;
    }
    .eyebrow {
      margin: 0 0 6px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--portfolio-accent);
      font-size: 0.75rem;
    }
    .status {
      margin: 8px 0 0;
      color: var(--muted);
    }
    .headline-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr));
      gap: 12px;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-top: 18px;
    }
    .chart-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
      margin-top: 18px;
    }
    .chart-card {
      border-radius: 22px;
      padding: 18px;
      background: rgba(255,255,255,0.72);
      border: 1px solid rgba(23,33,43,0.06);
    }
    .chart-head {
      display: flex;
      gap: 12px;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 8px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      justify-content: end;
      gap: 10px;
      font-size: 0.82rem;
      color: var(--muted);
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend i {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      display: inline-block;
    }
    svg {
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .grid line {
      stroke: var(--line);
      stroke-dasharray: 4 6;
    }
    .grid text, svg > text {
      fill: var(--muted);
      font-size: 12px;
      font-family: Aptos, "Segoe UI", Tahoma, sans-serif;
    }
    .data-footnote {
      padding: 20px 24px;
      margin-top: 24px;
      color: var(--muted);
      line-height: 1.5;
    }
    code {
      font-family: Consolas, "Courier New", monospace;
      font-size: 0.95em;
      background: rgba(23,33,43,0.06);
      padding: 2px 6px;
      border-radius: 6px;
    }
    @media (max-width: 720px) {
      main { width: min(100vw - 20px, 1160px); padding-top: 18px; }
      .hero, .portfolio-panel { padding: 20px; border-radius: 22px; }
      .portfolio-head { flex-direction: column; align-items: start; }
      .headline-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="kicker">Revere Portfolio Analyzer</p>
      <h1>Static performance report from extracted CSVs</h1>
      <p class="copy">This report is generated from <code>data/portfolio_performance_summary.csv</code> and <code>data/portfolio_performance_timeseries.csv</code>. It is a lightweight presentation layer for the processed data, with no external services or browser fetches required.</p>
      <div class="hero-grid">
        <article><span>Portfolios</span><strong>${escapeHtml(formatCount(summaryRows.length))}</strong></article>
        <article><span>Average Equity Index</span><strong>${escapeHtml(formatMultiple(averageEquity))}</strong></article>
        <article><span>Total Review Rows</span><strong>${escapeHtml(formatCount(totalReviewRows))}</strong></article>
        <article><span>Total Unpriced</span><strong>${escapeHtml(formatCount(totalUnpriced))}</strong></article>
      </div>
    </section>
    <section class="portfolio-stack">
      ${portfolioPanels}
    </section>
    <section class="data-footnote">
      Generated at ${escapeHtml(generatedAt)}. Open this file directly in a browser at <code>data/report/index.html</code>. Source CSVs remain the system of record for downstream notebooks, BI tools, and any future dashboard work.
    </section>
  </main>
</body>
</html>`;
}

async function generatePerformanceReport({ dataDirectory, outputDirectory }) {
  const summaryRows = normalizeSummaryRows(
    await loadCsvRows(path.join(dataDirectory, 'portfolio_performance_summary.csv'))
  );
  const timeseriesRows = normalizeTimeseriesRows(
    await loadCsvRows(path.join(dataDirectory, 'portfolio_performance_timeseries.csv'))
  );

  if (!summaryRows.length) {
    throw new Error('No performance summary rows found. Run `npm run performance` first.');
  }

  if (!timeseriesRows.length) {
    throw new Error('No performance timeseries rows found. Run `npm run performance` first.');
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'index.html');
  const html = buildReportHtml({
    generatedAt: new Date().toISOString(),
    summaryRows,
    timeseriesRows
  });

  await fs.writeFile(outputPath, html, 'utf8');

  return {
    outputPath,
    summaryCount: summaryRows.length,
    timeseriesCount: timeseriesRows.length
  };
}

module.exports = {
  buildLinePath,
  buildReportHtml,
  generatePerformanceReport,
  normalizeSummaryRows,
  normalizeTimeseriesRows
};