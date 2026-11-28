'use strict';

// WHICH branches does the clusterer's rule touch at all?
//
// The rule changes the clusterer's canonical selection. The clusterer feeds
// ONE artifact: `merged_position_list` (and the per-cluster diagnostics).
//
// So the question is: which scans PUBLISH that artifact, and which publish
// something else? A branch that never reads the clusterer's consensus is
// entirely unaffected by the rule, and "the rule improves every OCR" would
// be a false claim about it.
//
// This measures that from the logs themselves -- what each run's
// `merged_position_list` IS, and whether it equals the clusterer's output or
// something else.
//
//   node --test test/manual/clusterRuleBlastRadius.test.js

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROBE_ROOT = path.join(ROOT, 'data', 'video_scan_test', '_rerun');

test('which scans publish the clusterer\'s consensus', () => {
  const rows = [];

  for (const tag of fs.existsSync(PROBE_ROOT) ? fs.readdirSync(PROBE_ROOT) : []) {
    const dir = path.join(PROBE_ROOT, tag, 'ocr_probe', 'logs');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      let log;
      try {
        log = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      const merged = (log.merged_position_list || []).map((t) => String(t).toUpperCase()).sort();
      const clustered = (log.merged_raw_token_list || []).map((t) => String(t).toUpperCase()).sort();
      const captureTickers = (log.captures || []).flatMap((c) => c.tickers || []).map((t) => String(t).toUpperCase());

      // Is the published merged list the CLUSTERER's own output, or
      // something else (the whiteboard's structured holdings, or a table
      // scan's decoded holdings)?
      const isClustererOutput = JSON.stringify(merged) === JSON.stringify(clustered);
      rows.push({
        tag,
        date: log.date_key,
        kind: log.output_kind || '—',
        profile: log.prefilter_profile || '—',
        parser: log.chart_stream_parser ? 'chart_stream' : '—',
        mergedCount: merged.length,
        clusterCount: clustered.length,
        isClustererOutput,
        captureTickers: captureTickers.length,
        rule: log.cluster_rule || 'shipped',
      });
    }
  }

  console.log('\n===== THE BLAST RADIUS OF THE CLUSTER RULE =====\n');
  console.log('A scan publishes the clusterer\'s consensus only when its merged list');
  console.log('IS the clusterer\'s output. The others publish something else, and');
  console.log('the rule cannot touch them.\n');

  const byKind = new Map();
  for (const r of rows) {
    const key = `${r.kind} / ${r.profile} / ${r.parser}`;
    if (!byKind.has(key)) {
      byKind.set(key, { total: 0, clustererOutput: 0, hits: 0, misses: 0 });
    }
    const g = byKind.get(key);
    g.total += 1;
    if (r.isClustererOutput) g.clustererOutput += 1;
  }

  console.log('kind / profile / parser                        logs  publish the clusterer?');
  console.log('-'.repeat(80));
  for (const [key, g] of [...byKind.entries()].sort()) {
    console.log(
      `${key.padEnd(44)} ${String(g.total).padStart(4)}  `
      + `${g.clustererOutput === g.total ? 'YES -- all of them' : `${g.clustererOutput} of ${g.total}`}`
    );
  }
  console.log('');

  // The concrete answer for the whiteboard branch.
  const whiteboard = rows.filter((r) => r.kind !== 'snapshot');
  console.log(`logs that are NOT snapshot scans: ${whiteboard.length}`);
  if (whiteboard.length) {
    const publish = whiteboard.filter((r) => r.isClustererOutput);
    console.log(`  of those, publish the clusterer's consensus: ${publish.length}`);
    console.log('');
  }

  const snapshot = rows.filter((r) => r.kind === 'snapshot');
  const snapshotPublish = snapshot.filter((r) => r.isClustererOutput);
  console.log(`snapshot logs: ${snapshot.length}, of which publish the clusterer's consensus: ${snapshotPublish.length}`);
  console.log('');
});
