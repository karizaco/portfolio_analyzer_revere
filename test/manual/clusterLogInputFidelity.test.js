'use strict';

// Does the LOG carry the production clusterer's whole input?
//
// The clusterer is fed EVERY OCR'd candidate frame. The log keeps the
// selected captures, the top candidates and the rejected ones -- each a
// SUMMARY with its own `chart_stream.position_list`.
//
// If re-clustering the log's frames reproduces the log's own cluster table
// exactly, then the log DOES carry the whole input, and the frames can be
// counted per token -- which is what the swallowed-holding rule's guard
// needs.
//
// If it does NOT reproduce, the log keeps only part of the input, and any
// measurement built on the log's frames is measuring a DIFFERENT clustering
// than production ran. That distinction decides whether the rule's numbers
// can be believed.
//
// It needs no OCR.
//
//   node --test test/manual/clusterLogInputFidelity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { loadDecodeLexiconSync } = require(path.join(ROOT, 'src', 'normalize', 'tickerScan'));
const { clusterRawOcrTokens } = require(path.join(ROOT, 'src', 'parse', 'parseChartStream'));

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// The clusterer's input, as the production run built it.
function clusterInputOf(log) {
  const frames = [];
  const push = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    frames.push(list.join(' '));
  };
  for (const capture of log.captures || []) {
    push(capture.chart_stream && capture.chart_stream.position_list);
  }
  for (const candidate of log.top_candidates || []) {
    push(candidate.chart_stream && candidate.chart_stream.position_list);
  }
  for (const candidate of log.top_rejected_candidates || []) {
    push(candidate.chart_stream && candidate.chart_stream.position_list);
  }
  return frames;
}

test('does the log carry the production clusterer\'s whole input?', () => {
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  let identical = 0;
  let different = 0;
  let noFrames = 0;
  const examples = [];

  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const recorded = log.merged_raw_token_clusters;
    if (!Array.isArray(recorded) || !recorded.length) continue;

    const frames = clusterInputOf(log);
    if (!frames.length) { noFrames += 1; continue; }

    const out = clusterRawOcrTokens(frames, {
      maxDistance: 1,
      minTokenLength: 2,
      minFrequency: Math.min(2, Math.max(1, frames.length)),
      lexicon,
    });

    const norm = (clusters) => JSON.stringify(
      clusters
        .map((c) => ({
          canonical: c.canonical,
          members: [...c.members].sort(),
          frequency: c.frequency,
        }))
        .sort((a, b) => String(a.canonical).localeCompare(String(b.canonical)))
    );
    const recordedNorm = JSON.stringify(
      recorded
        .map((c) => ({
          canonical: c.canonical,
          members: [...c.members].sort(),
          frequency: c.frequency,
        }))
        .sort((a, b) => String(a.canonical).localeCompare(String(b.canonical)))
    );

    if (norm(out.clusters) === recordedNorm) {
      identical += 1;
    } else {
      different += 1;
      if (examples.length < 3) {
        examples.push({
          file: path.relative(ROOT, file),
          frames: frames.length,
          recorded: recorded.length,
          rebuilt: out.clusters.length,
        });
      }
    }
  }

  console.log('\n===== DOES THE LOG CARRY THE WHOLE CLUSTERER INPUT? =====\n');
  console.log(`logs whose cluster table the log's own frames REPRODUCE exactly: ${identical}`);
  console.log(`logs whose cluster table the log's own frames do NOT reproduce : ${different}`);
  console.log(`logs with no frames at all                                    : ${noFrames}`);
  console.log('');

  if (examples.length) {
    console.log('examples of a log that does not reproduce:');
    for (const e of examples) {
      console.log(`  ${e.file}`);
      console.log(`    ${e.frames} frame(s) in the log -> ${e.rebuilt} clusters; production recorded ${e.recorded}`);
    }
    console.log('');
  }

  if (identical === 0) {
    console.log('THE LOG DOES NOT CARRY THE WHOLE INPUT. Any measurement built on the');
    console.log("log's frames is measuring a DIFFERENT clustering than production ran.");
  } else if (different === 0) {
    console.log('The log DOES carry the whole input, and every log reproduces exactly.');
  } else {
    console.log('MIXED: some logs reproduce, some do not.');
  }
  console.log('');

  assert.ok(identical + different > 0, 'the corpus was examined');
});
