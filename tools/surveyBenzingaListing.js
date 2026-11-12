'use strict';
// Classify the full Benzinga listing with the project's own classifier.
// Read-only: it touches no database and writes no catalog row.
const fs = require('node:fs');
const { classifyBenzingaVideo, titleAirDate, titleTickers } = require('../src/benzinga/contentFilter');

function readTsv(file) {
  return fs.readFileSync(file, 'latin1').split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, duration, liveStatus, ...rest] = line.split('\t');
    return {
      id,
      duration_sec: Number(duration) || null,
      live_status: liveStatus === 'NA' ? '' : liveStatus,
      title: rest.join('\t'),
    };
  });
}

for (const tab of ['streams', 'videos', 'shorts']) {
  const file = `data/catalog_flat/benzinga_${tab}.tsv`;
  if (!fs.existsSync(file)) continue;
  const rows = readTsv(file);
  const byShow = new Map();
  const handling = new Map();
  let hours = 0;
  let withDate = 0;
  const samples = new Map();
  for (const row of rows) {
    const c = classifyBenzingaVideo(row);
    byShow.set(c.show, (byShow.get(c.show) || 0) + 1);
    handling.set(c.handling, (handling.get(c.handling) || 0) + 1);
    if (row.duration_sec) hours += row.duration_sec / 3600;
    if (titleAirDate(row.title)) withDate += 1;
    if (!samples.has(c.show)) samples.set(c.show, row.title);
  }
  console.log(`\n=== ${tab}: ${rows.length} rows, ${hours.toFixed(0)} h, titles with a date: ${withDate}`);
  for (const [show, n] of [...byShow.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${show.padEnd(20)} ${String(n).padStart(5)}  ${Math.round((n / rows.length) * 100)}%  | ${(samples.get(show) || '').slice(0, 80)}`);
  }
  console.log('  handling:', JSON.stringify(Object.fromEntries(handling)));
}

// The older eras: how many PreMarket episodes are there, and over which years?
const streams = readTsv('data/catalog_flat/benzinga_streams.tsv');
const pm = streams.filter((r) => classifyBenzingaVideo(r).show === 'premarket_playbook');
const years = new Map();
let pmNoDate = 0;
for (const row of pm) {
  const d = titleAirDate(row.title);
  if (!d) { pmNoDate += 1; continue; }
  years.set(d.slice(0, 4), (years.get(d.slice(0, 4)) || 0) + 1);
}
console.log(`\n=== PreMarket episodes: ${pm.length}; without a date in the title: ${pmNoDate}`);
console.log('  by year:', JSON.stringify(Object.fromEntries([...years.entries()].sort())));
const drift = streams.filter((r) => classifyBenzingaVideo(r).show === 'the_drift');
console.log(`=== The Drift episodes: ${drift.length}; first title: ${drift[drift.length - 1] ? drift[drift.length - 1].title : ''}`);

// The old names: PreMarket Prep, Live Trading With Benzinga, Marketopolis.
const oldNames = streams.filter((r) => /premarket\s+prep|live trading with benzinga|marketopolis/i.test(r.title));
console.log(`=== titles naming PreMarket Prep / Live Trading With Benzinga / Marketopolis: ${oldNames.length}`);
for (const row of oldNames.slice(0, 6)) console.log(`   ${row.duration_sec}s | ${row.title.slice(0, 100)}`);
