'use strict';

// Builds a copy of the curated OCR-confusion table with EXTRA rows appended,
// so a measurement can compare the shipped table against a candidate one
// WITHOUT editing config/ticker_ocr_confusions.csv (which every tool in the
// tree reads, and which two measurements would then race each other over).
//
// Usage:
//   node tools/buildAliasCandidateTable.js <output.csv> [garbled:canonical[:note] ...]
//
// The rows are written verbatim as `garbled,canonical,note`. A row whose
// note is omitted gets an empty note.
//
// NOTE: `tools/evalParserReplay.js` already offers `--drop-aliases A,B` (drop
// rows from the shipped table) and `--confusion-csv <path>` (use a table
// wholesale), so this tool is only needed when the CANDIDATE rows are ones
// the shipped table does not have yet -- which is exactly the case for a
// newly proposed alias.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'config', 'ticker_ocr_confusions.csv');

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/buildAliasCandidateTable.js <output.csv> [garbled:canonical[:note] ...]');
  process.exit(2);
}

const extra = process.argv.slice(3).map((spec) => {
  const [garbled, canonical, note = ''] = spec.split(':');
  if (!garbled || !canonical) {
    console.error(`not a row: ${spec} (expected garbled:canonical[:note])`);
    process.exit(2);
  }
  return `${garbled},${canonical},${note}`;
});

const raw = fs.readFileSync(SOURCE, 'utf8');
const body = raw.replace(/\s*$/, '');
const shippedRows = body.split(/\r?\n/).length - 1; // minus the header
fs.writeFileSync(out, `${body}\n${extra.join('\n')}\n`, 'utf8');
console.log(`wrote ${out} (${shippedRows} shipped rows + ${extra.length} extra)`);
