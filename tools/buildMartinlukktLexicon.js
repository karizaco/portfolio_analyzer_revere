'use strict';

// The martinlukkt corpus's own tickers.
//
// Three sources, each with its own authority:
//   the screen  the on-screen book, read off the frames (pixel evidence)
//   the titles  the stream titles ("SOXX short | 28 Oct 2026")
//   the speech  the tickers the transcript reader produced
//
// Every row is verified against a provider, because a ticker nobody returns
// is not a holding: it is a misheard word.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'config', 'ticker_lexicon_martinlukkt.csv');

// The on-screen book, read off the frames on 2026-11-18.
const BOOK = {
  SSPC: '2026 book, long',
  SOXS: '2026 book, long',
  BMNR: '2026 book, short',
  DRAM: '2026 book, short',
  AXTI: '2026 book, short',
  SKHY: '2026 book, short',
  MP: '2025 book, held',
  UUUU: '2025 book, held',
  CVNA: '2025 book, held',
  UVXY: '2025 book, held',
  AMD: '2025 book, long',
  RIVN: '2025 book, long',
  OPEN: '2025 book, long',
  NVDA: '2025 book, short',
  TSLA: '2025 book, short',
  IREN: '2025 book, short',
  OKLO: '2025 book, short',
  SNDK: '2025 book, short',
  BE: '2025 book, short',
  HOOD: '2025 book, short',
};

const DAY = 86400;

async function verify(ticker) {
  const period1 = Math.floor(Date.now() / 1000) - 30 * DAY;
  const period2 = Math.floor(Date.now() / 1000) + DAY;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}`
    + `?interval=1d&period1=${period1}&period2=${period2}`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    if (!response.ok) return null;
    const result = (await response.json()).chart.result[0];
    if (!result || !result.meta) return null;
    return {
      name: result.meta.shortName || result.meta.longName || '',
      type: result.meta.instrumentType || '',
    };
  } catch {
    return null;
  }
}

async function main() {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'video_pipeline', 'derived.sqlite'), { readOnly: true });
  const spoken = new Map(
    db.prepare(
      "SELECT ticker, COUNT(*) AS n FROM martinlukkt_trade_actions WHERE ticker <> '' GROUP BY ticker",
    ).all().map((row) => [row.ticker, row.n]),
  );
  const titles = new Map();
  const catalog = new DatabaseSync(path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite'), { readOnly: true });
  for (const row of catalog.prepare("SELECT title FROM videos WHERE channel = 'martinlukkt'").all()) {
    const head = String(row.title || '').split('|')[0];
    for (const token of head.match(/\b[A-Z]{2,5}\b/g) || []) {
      titles.set(token, (titles.get(token) || 0) + 1);
    }
  }
  catalog.close();
  db.close();

  const candidates = new Set([...spoken.keys(), ...Object.keys(BOOK), ...titles.keys()]);
  const rows = [];
  const rejected = [];
  for (const ticker of [...candidates].sort()) {
    const meta = await verify(ticker);
    if (!meta) {
      rejected.push(ticker);
      continue;
    }
    const notes = [];
    if (BOOK[ticker]) notes.push(BOOK[ticker]);
    if (spoken.has(ticker)) notes.push(`spoken x${spoken.get(ticker)}`);
    if (titles.has(ticker)) notes.push(`title x${titles.get(ticker)}`);
    rows.push({ ticker, type: meta.type, name: meta.name, note: notes.join('; ') });
    await new Promise((resolve) => setTimeout(resolve, 110));
  }

  const lines = [
    '# The martinlukkt corpus\'s own tickers.',
    '#',
    '# The shared lexicon does not know this channel\'s names, and the speech',
    '# reader hears them its own way: "SNTK" is SNDK, "SK Hynix" is SKHY,',
    '# "AOI" is AAOI. A row here is a ticker the corpus really carries, so a',
    '# read is either it or a mishearing of it.',
    '#',
    '# Every row was verified against a provider. A ticker no provider returns',
    '# is not a holding.',
    '#',
    '# source column: the book = read off the frames (pixel evidence);',
    '# spoken = the transcript reader; title = the stream title.',
    'ticker,name,type,source',
  ];
  for (const row of rows) {
    lines.push(`${row.ticker},"${row.name.replace(/"/g, '""')}",${row.type},"${row.note}"`);
  }
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  console.log('written  :', OUT);
  console.log('rows     :', rows.length);
  console.log('rejected :', rejected.join(', '));
}

main();
