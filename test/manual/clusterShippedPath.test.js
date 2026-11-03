'use strict';

// Does the shipped path still behave EXACTLY as it did before the change?
//
// The change added three options to the clusterer. With all of them off, the
// clusterer must produce byte-identical output to the pre-change code --
// otherwise a flag that is OFF by default has still changed the default.
//
// This runs the PRE-CHANGE clusterer (extracted from git) and the CURRENT
// one over the same recorded corpus and compares the cluster tables they
// produce, log by log.
//
// The pre-change module is written to a scratch directory and required from
// there, so the two implementations really are two implementations.
//
//   node --test test/manual/clusterShippedPath.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

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

// The pre-change clusterer, extracted from git into a scratch module.
//
// The file is written with its `require` of the sibling modules rewritten to
// absolute paths, so it loads the CURRENT lexicon and token-scan modules --
// which are unchanged -- and only the CLUSTERER differs. That is exactly
// the comparison wanted: the clusterer's behaviour, before and after.
function extractPreChangeClusterer(scratch) {
  const source = execFileSync(
    'git',
    ['show', 'HEAD:src/parse/parseChartStream.js'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );
  const rewritten = source
    .replace(
      /require\('\.\/([A-Za-z0-9_]+)'\)/g,
      (_m, name) => `require(${JSON.stringify(path.join(ROOT, 'src', 'parse', name + '.js'))})`
    )
    .replace(
      /require\('\.\.\/normalize\/([A-Za-z0-9_]+)'\)/g,
      (_m, name) => `require(${JSON.stringify(path.join(ROOT, 'src', 'normalize', name + '.js'))})`
    );
  const file = path.join(scratch, 'parseChartStreamPreChange.js');
  fs.writeFileSync(file, rewritten);
  // eslint-disable-next-line import/no-dynamic-require
  return require(file);
}

test('the shipped path is unchanged', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-shipped-'));
  try {
    const pre = extractPreChangeClusterer(scratch);
    const cur = require(path.join(ROOT, 'src', 'parse', 'parseChartStream'));

    assert.equal(typeof pre.clusterRawOcrTokens, 'function', 'the pre-change clusterer loaded');
    assert.equal(typeof cur.clusterRawOcrTokens, 'function', 'the current clusterer loaded');

    // The recorded corpus: every probe log's per-frame readings.
    const files = [
      path.join(ROOT, 'data', 'video_ocr_probe'),
      path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
    ].flatMap((r) => walk(r, []));

    const { loadDecodeLexiconSync } = require(path.join(ROOT, 'src', 'normalize', 'tickerScan'));
    const lexicon = loadDecodeLexiconSync();

    let compared = 0;
    const differing = [];
    let clustersTotal = 0;

    for (const file of files) {
      let log;
      try {
        log = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      // The clusterer's input: the per-frame readings, exactly as the
      // snapshot branch builds it.
      const frames = [];
      for (const capture of log.captures || []) {
        const list = capture.chart_stream && capture.chart_stream.position_list;
        if (Array.isArray(list) && list.length) frames.push(list.join(' '));
      }
      for (const candidate of log.top_candidates || []) {
        const list = candidate.chart_stream && candidate.chart_stream.position_list;
        if (Array.isArray(list) && list.length) frames.push(list.join(' '));
      }
      if (!frames.length) continue;

      const options = {
        maxDistance: 1,
        minTokenLength: 2,
        minFrequency: Math.min(2, Math.max(1, frames.length)),
        lexicon,
      };
      const a = pre.clusterRawOcrTokens(frames, options);
      const b = cur.clusterRawOcrTokens(frames, options);
      compared += 1;
      clustersTotal += a.clusters.length;

      const norm = (r) => JSON.stringify({
        merged: r.merged_list,
        clusters: r.clusters.map((c) => ({
          canonical: c.canonical,
          members: [...c.members].sort(),
          frequency: c.frequency,
        })),
      });
      if (norm(a) !== norm(b)) {
        differing.push({ file: path.relative(ROOT, file), before: norm(a), after: norm(b) });
      }
    }

    console.log('\n=== the shipped path, before and after ===');
    console.log(`logs compared: ${compared}   clusters compared: ${clustersTotal}`);
    console.log(`logs whose reading DIFFERS: ${differing.length}`);
    console.log('');

    for (const d of differing.slice(0, 8)) {
      console.log(`  ${d.file}`);
      console.log(`    before: ${d.before}`);
      console.log(`    after:  ${d.after}`);
    }
    if (differing.length) console.log('');

    assert.ok(compared > 0, 'the comparison actually compared something');
    assert.equal(
      differing.length,
      0,
      'the shipped path must be identical with every new option off'
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
