'use strict';

// What happens to ONE date, cluster by cluster.
//
// The aggregate said the corroboration rule drops AAPL (a false positive) and
// loses no holdings. That is a surprising claim -- the first version of the
// audit said it lost GTLB and BOIL -- so it is checked here, cluster by
// cluster, for the three dates that matter.
//
//   node --test test/manual/clusterRulePerDate.test.js

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  loadQmgGroundTruth,
  listGroundTruthCaptures,
} = require(path.join(ROOT, 'src', 'qmg', 'qmgGroundTruth'));

function lev(a, b) {
  const m = a.length; const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

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

const DATES = ['20230605', '20230609', '20220607'];

test('three dates, cluster by cluster', () => {
  const gt = loadQmgGroundTruth();
  const files = [
    path.join(ROOT, 'data', 'video_ocr_probe'),
    path.join(ROOT, 'data', 'video_scan_test', '_rerun'),
  ].flatMap((r) => walk(r, []));

  for (const date of DATES) {
    const held = new Set();
    for (const capture of listGroundTruthCaptures(gt, { dates: [date] })) {
      for (const t of capture.tickers || []) held.add(String(t).toUpperCase());
    }

    console.log(`\n================ ${date} ================`);
    console.log(`ground truth (${held.size}): ${[...held].sort().join(' ')}`);

    for (const file of files) {
      let log;
      try {
        log = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (log.date_key !== date) continue;
      const clusters = log.merged_raw_token_clusters || [];
      const merged = log.merged_position_list || [];
      if (!clusters.length) continue;

      console.log(`\n  ${path.relative(ROOT, file)}`);
      console.log(`    published (${merged.length}): ${merged.join(' ')}`);

      const carriedBy = new Map();  // canonical -> the clusters that carried it
      for (const cluster of clusters) {
        const canonical = String(cluster.canonical || '').toUpperCase();
        const members = (Array.isArray(cluster.members) ? cluster.members : [])
          .map((m) => String(m).toUpperCase());
        if (!canonical) continue;
        const isReading = members.includes(canonical);
        let closest = Infinity;
        for (const m of members) {
          const d = lev(m, canonical);
          if (d < closest) closest = d;
        }
        const corroborated = isReading || closest <= 1;
        if (!carriedBy.has(canonical)) carriedBy.set(canonical, []);
        carriedBy.get(canonical).push({ members, isReading, closest, corroborated });
      }

      for (const [canonical, carriers] of carriedBy) {
        const survives = carriers.some((c) => c.corroborated);
        const verdict = held.has(canonical) ? 'a real holding' : 'a false positive';
        console.log(
          `    ${canonical.padEnd(6)} ${verdict.padEnd(18)} `
          + `${survives ? 'SURVIVES' : 'DROPPED  '} `
          + `carried by ${carriers.length} cluster(s): `
          + carriers.map((c) => `[${c.members.join(',')}]${c.isReading ? '(reading)' : `(d=${c.closest})`}`).join(' ')
        );
      }
    }
  }
});
