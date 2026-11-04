'use strict';

// The video-level consensus can publish a ticker no selected capture accepted.
//
// AR on 20231201 and ALB on 20231215 were that case: the selected captures
// were exact, and the false positive existed only in the merge. The blunt
// rule — drop anything absent from every capture — also drops GTLB on
// 20230609, which the captures read as GULE and the clusterer recovered.
// A canonical stays when a capture read it, or read a member of its cluster.
//
//   node --test test/chartStreamConsensusAttestation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { attestConsensusToCaptures } = require('../src/parse/parseChartStream');

test('a ticker a capture read is kept', () => {
  const kept = attestConsensusToCaptures(
    ['BITX', 'DDOG'],
    [['BITX', 'DDOG', 'PATH']],
    []
  );
  assert.deepEqual(kept, ['BITX', 'DDOG']);
});

test('a ticker no capture read, and whose cluster has no capture member, is dropped', () => {
  // AR on 20231201: members ['AR'], frequency 2, in no selected capture.
  const kept = attestConsensusToCaptures(
    ['BITX', 'AR'],
    [['BITX', 'DDOG']],
    [{ canonical: 'AR', members: ['AR'] }]
  );
  assert.deepEqual(kept, ['BITX']);
});

test('a recovered holding is kept when a capture read a member of its cluster', () => {
  // GTLB on 20230609: the captures read GULE, not GTLB.
  const kept = attestConsensusToCaptures(
    ['AI', 'GTLB'],
    [['AI', 'GULE']],
    [
      { canonical: 'GTLB', members: ['GTLB'] },
      { canonical: 'GTLB', members: ['GULE'] },
    ]
  );
  assert.deepEqual(kept, ['AI', 'GTLB']);
});

test('a ticker with no cluster record and no capture reading is dropped', () => {
  const kept = attestConsensusToCaptures(['ALB'], [['BITX']], []);
  assert.deepEqual(kept, []);
});

test('the scan tool records dropped clusters under the default rule', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'tools', 'scanVideoWithOcr.js'),
    'utf8'
  );
  assert.match(source, /cluster_dropped: explainDropped/);
  assert.doesNotMatch(source, /options\.clusterCorroboration === true/);
});
