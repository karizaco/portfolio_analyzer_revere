'use strict';

// Is there a discriminator between a swallowed REAL HOLDING and a
// swallowed NOISE token?
//
// The census (clusterAbsorbedHolding.test.js) found five clusters that name
// one lexicon ticker and swallow another:
//
//   20230522  AI swallowed LI    -- LI IS a holding
//   20230523  AI swallowed LI    -- LI IS a holding
//   20220607  NFLX swallowed NFU (x3) -- NFU is NOT a holding
//
// A rule that publishes BOTH distinct lexicon tickers would recover the two
// LI holdings -- and publish NFU three times as a false positive. So the
// rule needs a discriminator, and this measures the candidates.
//
// The question is asked of the log's own readings: in how many DISTINCT
// FRAMES does the swallowed ticker appear on its own, rather than always
// alongside the canonical?
//
// It needs no OCR -- the logs record every frame's reading.
//
//   node --test test/manual/clusterAbsorbedDiscriminator.test.js

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

// Every frame's reading, from the log.
function frameReadings(log) {
  const frames = [];
  const push = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    frames.push(new Set(list.map((t) => String(t).toUpperCase())));
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

test('what separates a swallowed HOLDING from a swallowed NOISE token', () => {
  const gt = loadQmgGroundTruth();
  const lexicon = loadDecodeLexiconSync();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  console.log('\n===== SEPARATING A SWALLOWED HOLDING FROM A SWALLOWED NOISE TOKEN =====\n');

  const rows = [];
  for (const file of files) {
    let log;
    try {
      log = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const clusters = log.merged_raw_token_clusters;
    if (!Array.isArray(clusters) || !clusters.length) continue;
    const date = log.date_key;

    const held = new Set();
    let scored = false;
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      scored = true;
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }
    if (!scored) continue;

    const frames = frameReadings(log);

    for (const cluster of clusters) {
      const members = (cluster.members || []).map((m) => String(m).toUpperCase());
      const canonical = String(cluster.canonical || '').toUpperCase();
      if (!canonical || !members.length) continue;
      const others = [...new Set(members)].filter(
        (m) => m !== canonical && lexicon.tickerSet.has(m)
      );
      if (!others.length) continue;

      for (const other of others) {
        // In how many frames does the swallowed ticker appear?
        const framesWithOther = frames.filter((f) => f.has(other));
        const framesWithCanonical = frames.filter((f) => f.has(canonical));
        // In how many of those does the canonical ALSO appear? If the
        // swallowed ticker ALWAYS appears alongside the canonical, the two
        // are one cell read two ways. If it appears on its own, it is its
        // own cell.
        const together = framesWithOther.filter((f) => f.has(canonical));
        const alone = framesWithOther.length - together.length;
        rows.push({
          date,
          canonical,
          other,
          isHolding: held.has(other),
          framesWithOther: framesWithOther.length,
          framesWithCanonical: framesWithCanonical.length,
          together: together.length,
          alone,
          clusterFrequency: cluster.frequency,
        });
      }
    }
  }

  // Deduplicate: the same (date, canonical, other) can appear in several
  // logs of the same date.
  const seen = new Set();
  const unique = rows.filter((r) => {
    const key = `${r.date}|${r.canonical}|${r.other}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log('date        canonical  swallowed  a holding?  frames: swallowed  with  alone  cluster freq');
  console.log('-'.repeat(92));
  for (const r of unique) {
    console.log(
      `${r.date}  ${r.canonical.padEnd(9)}  ${r.other.padEnd(10)}  `
      + `${(r.isHolding ? 'YES' : 'no').padEnd(11)}  `
      + `${String(r.framesWithOther).padStart(15)}  ${String(r.together).padStart(4)}  `
      + `${String(r.alone).padStart(5)}  ${String(r.clusterFrequency).padStart(12)}`
    );
  }
  console.log('');

  const holdings = unique.filter((r) => r.isHolding);
  const noise = unique.filter((r) => !r.isHolding);
  console.log('A swallowed HOLDING:');
  for (const r of holdings) {
    console.log(`  ${r.date}  ${r.other}: read in ${r.framesWithOther} frame(s), ${r.alone} of them WITHOUT ${r.canonical}`);
  }
  console.log('A swallowed NOISE token:');
  for (const r of noise) {
    console.log(`  ${r.date}  ${r.other}: read in ${r.framesWithOther} frame(s), ${r.alone} of them WITHOUT ${r.canonical}`);
  }
  console.log('');

  // The discriminator, if there is one.
  const holdingAlone = holdings.map((r) => r.alone);
  const noiseAlone = noise.map((r) => r.alone);
  console.log(`the swallowed HOLDING is read alone in: [${holdingAlone.join(', ')}] frame(s)`);
  console.log(`the swallowed NOISE is read alone in:    [${noiseAlone.join(', ')}] frame(s)`);
  console.log('');

  assert.ok(unique.length > 0, 'the corpus contains the case this measures');
});
