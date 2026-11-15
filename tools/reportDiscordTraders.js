'use strict';

/**
 * Write the Discord traders' dashboard.
 *
 *   node tools/reportDiscordTraders.js
 *
 * It reads `data/discord_traders.json` (written by
 * `tools/analyzeDiscordTraders.js`) and writes `data/discord_traders.html`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { renderDiscordReport } = require('../src/report/discordReport');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD_PATH = path.join(ROOT, 'data', 'discord_traders.json');
const OUT_PATH = path.join(ROOT, 'data', 'discord_traders.html');

function main() {
  if (!fs.existsSync(PAYLOAD_PATH)) {
    throw new Error('data/discord_traders.json is missing -- run: node tools/analyzeDiscordTraders.js');
  }
  const payload = JSON.parse(fs.readFileSync(PAYLOAD_PATH, 'utf8'));
  fs.writeFileSync(OUT_PATH, renderDiscordReport(payload));
  console.error(`Written: ${OUT_PATH}`);
}

main();
