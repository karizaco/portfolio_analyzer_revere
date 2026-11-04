'use strict';

// Generate the Sevcik allow-list lexicon.
//
// WHY A SEPARATE LEXICON
//
// The shared seed lexicon (`config/ticker_lexicon_seed.csv`) is the
// allow list for the OCR paths, and it is built around Revere's
// whiteboard and Qullamaggie's position list. It has 240 rows.
//
// The Sevcik speaker names large caps plainly -- Apple, Tesla, Intel,
// Microsoft, Adobe -- and 10,170 of the 10,410 US-listed tickers are
// not in the shared seed. So gating this source on the seed would drop
// names the speaker says out loud.
//
// This tool writes `config/ticker_lexicon_sevcik.csv`: the seed, plus
// the generated SEC name table, plus the curated non-US table.
//
// WHAT IT DOES NOT DO
//
// It does not widen what may be RECOGNISED. A ticker is still only
// reported when it was actually said, and the name matcher still refuses
// an ambiguous name. The allow list is a filter on what may be
// PUBLISHED, and this widens that filter for this source only.
//
// Usage:
//   node tools/buildSevcikLexicon.js
//   node tools/buildSevcikLexicon.js --json

const path = require('node:path');

const { loadSevcikLexicon, writeSevcikLexicon } = require('../src/sevcik/lexicon');
const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');
const { loadCompanyNames, loadNonUsNames } = require('../src/sevcik/companyNames');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const seed = new Set(loadSeedLexiconSync().tickers);
  const generated = loadCompanyNames();
  const nonUs = loadNonUsNames();

  const result = writeSevcikLexicon();

  const combined = loadSevcikLexicon();
  const added = [...combined].filter((ticker) => !seed.has(ticker)).length;

  console.log(`[sevcik-lexicon] seed=${seed.size} generated=${generated.length} `
    + `non-us=${nonUs.length} -> ${combined.size} tickers `
    + `(+${added} beyond the seed)`);
  console.log(`[sevcik-lexicon] wrote ${path.relative(ROOT, result.path)}`);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...result, total: combined.size, added }, null, 2));
  }
}

if (require.main === module) main();

module.exports = { main };
