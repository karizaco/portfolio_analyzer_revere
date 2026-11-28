'use strict';

// The swallowed member's OWN frame count -- the signal the rule's guard uses.
//
// The cluster table records a cluster's `frequency`, which is the SUM over
// its members' frame counts. For the cluster {AI, LI} that sum is 15, and
// for {NFLX, NFU} it is 3 -- which is what separated the swallowed HOLDING
// from the swallowed NOISE in the first measurement.
//
// But the rule needs the member's OWN count, not the sum: the canonical's
// frames must not be credited to the swallowed ticker.
//
// This measures the own count, on the logs whose frames REPRODUCE their own
// cluster table exactly -- the logs where the recorded frames ARE the whole
// production input. (clusterLogInputFidelity.test.js shows that most logs
// do NOT preserve the whole input, so a measurement over all of them would
// be measuring a different clustering than production ran.)
//
// It needs no OCR.
//
//   node --test test/manual/clusterSwallowedOwnFrames.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));
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

test('the swallowed member\'s OWN frame count, on the logs with the whole input', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  const norm = (clusters) => JSON.stringify(
    clusters
      .map((c) => ({
        canonical: c.canonical,
        members: [...c.members].sort(),
        frequency: c.frequency,
      }))
      .sort((a, b) => String(a.canonical).localeCompare(String(b.canonical)))
  );

  console.log('\n===== THE SWALLOWED MEMBER\'S OWN FRAME COUNT =====\n');
  console.log('Only on the logs whose recorded frames REPRODUCE their own cluster');
  console.log('table exactly -- there, the frames ARE the whole production input.\n');
  console.log('date        canonical  swallowed  a holding?  own frames  cluster freq');
  console.log('-'.repeat(78));

  const rows = [];
  let completeLogs = 0;

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
    if (!frames.length) continue;

    const out = clusterRawOcrTokens(frames, {
      maxDistance: 1,
      minTokenLength: 2,
      minFrequency: Math.min(2, Math.max(1, frames.length)),
      lexicon,
    });
    // Only trust this log if re-clustering its frames reproduces its own
    // cluster table EXACTLY. Otherwise the frames are not the whole input,
    // and the counts below would be of a different clustering.
    if (norm(out.clusters) !== norm(recorded)) continue;
    completeLogs += 1;

    const date = log.date_key;
    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    // The frames each token was read in, over the WHOLE input.
    const frameSets = frames.map((f) => new Set(
      f.split(/\s+/).map((t) => String(t).toUpperCase())
    ));
    const ownFrames = (token) => frameSets.filter((f) => f.has(token)).length;

    for (const cluster of recorded) {
      const canonical = String(cluster.canonical || '').toUpperCase();
      const members = (cluster.members || []).map((m) => String(m).toUpperCase());
      if (!canonical) continue;
      for (const other of new Set(members)) {
        if (other === canonical) continue;
        if (!lexicon.tickerSet.has(other)) continue;
        const own = ownFrames(other);
        const isHolding = held.has(other);
        rows.push({ date, canonical, other, isHolding, own, clusterFreq: cluster.frequency });
        console.log(
          `${date}  ${canonical.padEnd(9)}  ${other.padEnd(10)}  `
          + `${(isHolding ? 'YES' : 'no').padEnd(11)}  ${String(own).padStart(9)}  ${String(cluster.frequency).padStart(12)}`
        );
      }
    }
  }

  console.log('');
  console.log(`logs whose frames ARE the whole production input: ${completeLogs}`);
  const holdings = rows.filter((r) => r.isHolding);
  const noise = rows.filter((r) => !r.isHolding);
  console.log(`swallowed HOLDINGS, own frame counts: [${holdings.map((r) => r.own).join(', ')}]`);
  console.log(`swallowed NOISE,    own frame counts: [${noise.map((r) => r.own).join(', ')}]`);
  console.log('');

  if (holdings.length && noise.length) {
    const minHolding = Math.min(...holdings.map((r) => r.own));
    const maxNoise = Math.max(...noise.map((r) => r.own));
    console.log(`a threshold of ${maxNoise + 1}..${minHolding} separates them`);
    console.log(`  (a swallowed holding's own count >= ${minHolding}; a swallowed noise token's <= ${maxNoise})`);
    console.log('');
  }

  assert.ok(rows.length > 0, 'the corpus contains a complete log with a swallowed ticker');
});
