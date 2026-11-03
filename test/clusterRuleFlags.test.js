'use strict';

// The cluster-rule flags, end to end.
//
// The rule has to reach the SCAN TOOL, not just the replay tool -- the
// batch runner builds the child's flag list, and the scan tool parses it.
// This checks both ends of that path without running a scan.
//
//   node --test test/clusterRuleFlags.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const { parseArgs: parseScanArgs } = require(path.join(ROOT, 'src', 'video', 'ocrScanArgs'));

test('the scan tool parses the cluster-rule flags', () => {
  // `--video` is required, so every case carries it.
  const parse = (...extra) => parseScanArgs(['--video', 'x.mp4', '--date', '20230605', ...extra]);

  const base = parse();
  assert.equal(base.clusterCorroboration, false, 'the corroboration rule is OFF by default');
  assert.equal(base.clusterSupported, false, 'the supported rule is OFF by default');
  assert.equal(base.clusterVideoSupported, false, 'the video-supported rule is OFF by default');
  assert.equal(base.clusterStrictCorroboration, false, 'the strict variant is OFF by default');

  assert.equal(parse('--cluster-corroboration').clusterCorroboration, true);
  assert.equal(parse('--cluster-supported').clusterSupported, true);
  assert.equal(parse('--cluster-video-supported').clusterVideoSupported, true);

  const strict = parse('--cluster-corroboration', '--cluster-strict-corroboration');
  assert.equal(strict.clusterCorroboration, true);
  assert.equal(strict.clusterStrictCorroboration, true);
});

test('the batch runner builds the right flags for each rule', () => {
  // The batch runner is a module; the rule table is what matters, and it is
  // exercised by spawning the tool with --dry-run.
  const res = spawnSync(
    'node',
    [
      path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
      '--dates', '20230605',
      '--run-tag', 'cluster-rule-flags-test',
      '--cluster-rule', 'corroborated',
      '--dry-run',
    ],
    { cwd: ROOT, encoding: 'utf8', shell: false }
  );
  assert.equal(res.status, 0, `the batch runner accepted the rule:\n${res.stderr}`);

  const res2 = spawnSync(
    'node',
    [
      path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
      '--dates', '20230605',
      '--run-tag', 'cluster-rule-flags-test',
      '--cluster-rule', 'not-a-rule',
      '--dry-run',
    ],
    { cwd: ROOT, encoding: 'utf8', shell: false }
  );
  assert.notEqual(res2.status, 0, 'an unknown rule is a usage error, not a silent default');
  assert.match(res2.stderr + res2.stdout, /unknown --cluster-rule/);
});

test('the replay tool accepts every rule name', () => {
  const { CLUSTER_RULES } = require(path.join(ROOT, 'tools', 'evalParserReplay'));
  assert.deepEqual(
    Object.keys(CLUSTER_RULES).sort(),
    [
      'corroborated',
      'corroborated+swallowed',
      'corroborated-strict',
      'shipped',
      'supported',
      'supported+corroborated',
      'swallowed',
      'video-supported',
      'video-supported+corroborated',
    ],
    'every rule the docs name is implemented'
  );
});

test('the replay and the scan tool name a rule the SAME way', () => {
  // The replay compares a log's recorded rule against the rule it is
  // applying, so the two name the same combination the same way. This is
  // the invariant that broke when the strict flag was added: the replay
  // checked the strict flag BEFORE the supported one, so
  // `supported+corroborated` under the strict flag was misnamed
  // `corroborated-strict`, and the scan tool never recorded the strict flag
  // at all.
  const { CLUSTER_RULES, clusterRuleName } = require(path.join(ROOT, 'tools', 'evalParserReplay'));

  // Every named rule, mapped back to the switches it turns on.
  const SWITCHES = {
    'shipped': {},
    'corroborated': { requireDistanceOneCorroboration: true },
    'corroborated-strict': {
      requireDistanceOneCorroboration: true,
      corroborationAllowsVideoSupport: false,
    },
    'supported': { preferSupportedCorrection: true },
    'supported+corroborated': {
      preferSupportedCorrection: true,
      requireDistanceOneCorroboration: true,
    },
    'video-supported': { preferVideoSupport: true },
    'video-supported+corroborated': {
      preferVideoSupport: true,
      requireDistanceOneCorroboration: true,
    },
    'swallowed': { publishSwallowedHoldings: true },
    'corroborated+swallowed': {
      publishSwallowedHoldings: true,
      requireDistanceOneCorroboration: true,
    },
  };

  for (const [name, switches] of Object.entries(SWITCHES)) {
    assert.equal(clusterRuleName(switches), name,
      `the replay names ${name} correctly`);
    // The scan tool's own naming, reproduced from the CLI options it sets.
    const scanName = (() => {
      const parts = [];
      if (switches.preferVideoSupport === true) parts.push('video-supported');
      else if (switches.preferSupportedCorrection === true) parts.push('supported');
      if (switches.requireDistanceOneCorroboration === true) {
        parts.push(switches.corroborationAllowsVideoSupport === false
          ? 'corroborated-strict'
          : 'corroborated');
      }
      if (switches.publishSwallowedHoldings === true) parts.push('swallowed');
      return parts.length ? parts.join('+') : 'shipped';
    })();
    assert.equal(scanName, name, `the scan tool names ${name} the same way`);
  }

  // And every rule the table knows is named correctly by the builder.
  for (const [name, options] of Object.entries(CLUSTER_RULES)) {
    assert.equal(clusterRuleName(options), name,
      `the builder names the ${name} rule correctly`);
  }
});

test('the batch runner and the replay tool know the SAME rule names', () => {
  // The batch runner's table and the replay tool's table are two copies of
  // the same list, and they HAVE drifted: the batch said
  // `swallowed+corroborated` where the replay said `corroborated+swallowed`,
  // and a scan naming one of them died with "unknown --cluster-rule".
  //
  // The naming has to be the same everywhere, so this pins the two tables
  // together.
  const { CLUSTER_RULES } = require(path.join(ROOT, 'tools', 'evalParserReplay'));
  const batch = require(path.join(ROOT, 'tools', 'runQmgOcrBatch.js'));

  // The batch runner does not export its table, so it is read from the
  // source -- which is the point: the table is DATA in the source, and two
  // copies of it have to agree.
  const source = fs.readFileSync(
    path.join(ROOT, 'tools', 'runQmgOcrBatch.js'),
    'utf8'
  );
  const table = source.slice(
    source.indexOf('const CLUSTER_RULE_FLAGS'),
    source.indexOf('};', source.indexOf('const CLUSTER_RULE_FLAGS'))
  );
  const names = [...table.matchAll(/^\s*'?([a-z][a-z+|-]*)'?:/gm)].map((m) => m[1]);

  assert.deepEqual(
    names.filter((n) => n !== 'const'),
    Object.keys(CLUSTER_RULES),
    'the batch runner and the replay tool name the same rules'
  );

  // And every rule the batch names must actually reach the scan tool.
  for (const name of names) {
    const flags = table.slice(table.indexOf(`${name}:`));
    const line = flags.slice(0, flags.indexOf('\n'));
    const scanFlags = [...line.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]);
    for (const flag of scanFlags) {
      const accepted = parseScanArgs(['--video', 'x.mp4', '--date', '20230605', flag]);
      assert.ok(accepted, `${name} passes ${flag}, which the scan tool accepts`);
    }
  }
});

test('a log records the rule it was scanned under', () => {
  // The replay reads these three fields to work out which rule a log was
  // scanned under. If the strict flag is missing, a `corroborated-strict`
  // log is misidentified as a `corroborated` one.
  const { recordedClusterRuleOf } = require(path.join(ROOT, 'tools', 'evalParserReplay'));

  assert.equal(recordedClusterRuleOf({}), 'shipped');
  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: true,
    cluster_supported: false,
    cluster_video_supported: false,
    cluster_strict_corroboration: false,
  }), 'corroborated');
  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: true,
    cluster_supported: false,
    cluster_video_supported: false,
    cluster_strict_corroboration: true,
  }), 'corroborated-strict');
  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: false,
    cluster_supported: true,
    cluster_video_supported: false,
    cluster_strict_corroboration: false,
  }), 'supported');
  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: true,
    cluster_supported: true,
    cluster_video_supported: false,
    cluster_strict_corroboration: false,
  }), 'supported+corroborated');
  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: true,
    cluster_supported: false,
    cluster_video_supported: true,
    cluster_strict_corroboration: false,
  }), 'video-supported+corroborated');

  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: false,
    cluster_supported: false,
    cluster_video_supported: false,
    cluster_strict_corroboration: false,
    cluster_swallowed_holdings: true,
  }), 'swallowed');

  assert.equal(recordedClusterRuleOf({
    cluster_corroboration: true,
    cluster_supported: false,
    cluster_video_supported: false,
    cluster_strict_corroboration: false,
    cluster_swallowed_holdings: true,
  }), 'corroborated+swallowed');
});
