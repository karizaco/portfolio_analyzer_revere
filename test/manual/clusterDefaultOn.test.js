'use strict';

// Does the new default actually take effect?
//
// The corroboration rule is ON by default now. This checks the three things
// that have to be true for that to be TRUE rather than merely intended:
//
//   1. a scan with no cluster flags runs the corroborated rule
//   2. `--no-cluster-corroboration` runs the old one
//   3. the rule NAME the scan records says which of the two ran
//
// It runs the scan tool's own option resolution, not a copy of it.
//
//   node --test test/manual/clusterDefaultOn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  parseArgs: parseScanArgs,
} = require(path.join(ROOT, 'src', 'video', 'ocrScanArgs'));
const {
  clusterRuleName,
  resolveClusterRuleOptions,
} = require(path.join(ROOT, 'src', 'parse', 'parseChartStream'));

test('the corroboration rule is ON by default, and can be turned off', () => {
  const parse = (...extra) => parseScanArgs(['--video', 'x.mp4', '--date', '20230605', ...extra]);

  // 1. No flags -> the corroborated rule.
  const dflt = resolveClusterRuleOptions(parse());
  assert.equal(dflt.requireDistanceOneCorroboration, true,
    'a scan with no cluster flags runs the corroboration rule');
  assert.equal(clusterRuleName(dflt), 'corroborated',
    'and it records that it did');

  // 2. --no-cluster-corroboration -> the old rule.
  const off = resolveClusterRuleOptions(parse('--no-cluster-corroboration'));
  assert.equal(off.requireDistanceOneCorroboration, false,
    '--no-cluster-corroboration turns the rule off');
  assert.equal(clusterRuleName(off), 'shipped',
    'and it records the old rule');

  // 3. The other rules are still OFF by default.
  assert.equal(dflt.preferSupportedCorrection, false);
  assert.equal(dflt.preferVideoSupport, false);
  assert.equal(dflt.publishSwallowedHoldings, false);

  // The replay tool's default must be the SAME rule the scan tool runs by
  // default, or the `rebuilt` arm measures a pipeline that does not exist.
  const { CLUSTER_RULES } = require(path.join(ROOT, 'tools', 'evalParserReplay'));
  assert.equal(CLUSTER_RULES.corroborated.requireDistanceOneCorroboration, true);
  assert.equal(CLUSTER_RULES.shipped.requireDistanceOneCorroboration, false,
    'shipped still means the pre-2026-11-03 behaviour');
});

test('the scan tool and the shared resolver agree on the default', () => {
  // The scan tool resolves the options itself. If it ever stops using the
  // shared resolver, the default silently changes back.
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'scanVideoWithOcr.js'), 'utf8');
  assert.ok(source.includes('resolveClusterRuleOptions(options)'),
    'the scan tool uses the shared resolver');
  assert.ok(source.includes('clusterRuleNameFor(clusterRule)'),
    'the scan tool uses the shared name builder');
});
