'use strict';

// The clusterer's canonical selection.
//
// THE DEFECT THIS FILE PINS
//
// `merged_position_list` -- the VIDEO-level consensus, and the artifact the
// production consumers read (tools/runQmgOcrBatch.js and
// tools/aggregateScanResults.js) -- is built by naming ONE canonical per
// cluster of garbled tokens. When the canonical is a member of the cluster
// and a lexicon ticker, that is a READING. When it is a CORRECTION -- the
// clusterer naming a ticker no frame of the video read -- it is a GUESS, and
// a guess in this project publishes a wrong holding, which is worse than
// missing one.
//
// The recorded instance: on 20230605 the cluster {AACO, ARCO} was published
// as `AAPL`. `AAPL` is in NO capture's reading of that video; it is a seed
// ticker the clusterer reached by correcting `AACO`.
//
// THE ARITHMETIC, MEASURED
//
//   lev(AACO, AAPL) = 2   (C->P, O->L)
//   lev(AACO, AAL)  = 2
//   lev(ARCO, ARQQ) = 2   (C->Q, O->Q)
//   lev(ARCO, ARKG) = 2
//
// EVERY candidate is TWO edits away. "Closest" therefore does not
// discriminate between them at all -- a rule that picks the closest
// correction is picking a tie, and the shipped tie-break ("prefer the longer
// ticker") decides it.
//
// What DOES discriminate is the video's own reading: on that date ARQQ was
// read in six of the video's frames, and AAPL in none.
//
// THE TWO CURES
//
//   corroborated: a corrected canonical must be within edit distance 1 of a
//     cluster member, or the cluster is DISCARDED. On this instance AAPL
//     fails (2 edits from every member), so the cluster is dropped and
//     AAPL never reaches the merged list.
//
//   supported: the canonical is the correction the VIDEO actually read, not
//     the first member's. On this instance that is ARQQ -- and ARQQ has its
//     OWN cluster in the same log (frequency 6), so resolving this cluster
//     to ARQQ publishes the holding the panel showed.
//
// The two are not the same cure, and the difference is measurable.
//
// Both are OFF by default.
//
// They change which holdings a scan publishes, so they have to be MEASURED
// before either is switched on -- tightening them also stops corrections
// that are real. `node tools/evalParserReplay.js --cluster-rule corroborated`
// and `--cluster-rule supported` measure them over the recorded logs, with no
// OCR and no change to any shared config file. This file pins the RULES'
// behaviour; it does not assert the corpus numbers, because the corpus is
// untracked.
//
// A capture-level metric cannot see any of this: CLAUDE.md records the same
// conclusion twice, for `REGN` on 20230609 and for `AAPL` on 20230605.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clusterRawOcrTokens,
  clusterVideoLevelReadings,
} = require('../src/parse/parseChartStream');
const { loadDecodeLexiconSync } = require('../src/normalize/tickerScan');

// A lexicon with no surprises: the tickers the tests below reason about, and
// nothing else. The production lexicon is 240-odd rows, and a test that
// depends on which of them happens to be nearest is a test that breaks when
// a holding is added to the seed.
//
// ARQQ is here because it is the ticker the 20230605 panel actually showed,
// and because it is what the SUPPORTED rule has to find: ARCO is two edits
// from it, exactly as AACO is two edits from AAPL.
//
// ARKG is here because it is the OTHER two-edit candidate for ARCO. Without
// it, the test would not know whether the rule picks ARQQ because the video
// supported it or because it was the only candidate.
//
// TSLB is here because it gives the two supported rules something to
// disagree about: it is TWO edits from TSUA, while TSLA is ONE. The
// `supported` rule keeps TSLA (closer wins, support only breaks ties); the
// `video-supported` rule takes TSLB (the video read it, TSLA it never did).
//
// AI and LI are here for the SWALLOWED-HOLDING rule: they are one edit
// apart, so the clusterer merges them, and on 20230522/20230523 they are
// BOTH rows of the panel. APLD is a bystander that must not be affected.
const SYNTHETIC = {
  tickers: [
    'AAPL', 'AAL', 'TSLA', 'TSLB', 'NFLX', 'FREY', 'ARQQ', 'ARKG',
    'AI', 'LI', 'APLD',
  ],
  tickerSet: new Set([
    'AAPL', 'AAL', 'TSLA', 'TSLB', 'NFLX', 'FREY', 'ARQQ', 'ARKG',
    'AI', 'LI', 'APLD',
  ]),
};

const SHIPPED = { lexicon: SYNTHETIC, minFrequency: 1 };
const CORROBORATED = { ...SHIPPED, requireDistanceOneCorroboration: true };
const SUPPORTED = { ...SHIPPED, preferSupportedCorrection: true };
const SUPPORTED_CORROBORATED = {
  ...SHIPPED,
  preferSupportedCorrection: true,
  requireDistanceOneCorroboration: true
};
const VIDEO_SUPPORTED = { ...SHIPPED, preferVideoSupport: true };

test('a member that IS a lexicon ticker is the canonical, under both rules', () => {
  const shipped = clusterRawOcrTokens(['NFLX 100 5.5%'], SHIPPED);
  assert.deepEqual(shipped.merged_list, ['NFLX']);

  const corroborated = clusterRawOcrTokens(['NFLX 100 5.5%'], CORROBORATED);
  assert.deepEqual(corroborated.merged_list, ['NFLX'],
    'an exact reading is corroborated by definition');
});

test('a distance-1 correction survives the corroboration rule', () => {
  // TSUA -> TSLA is distance 1: one misread glyph. The member corroborates
  // the correction, so the rule must not touch it.
  const shipped = clusterRawOcrTokens(['TSUA 240 1.5%'], SHIPPED);
  assert.deepEqual(shipped.merged_list, ['TSLA']);

  const corroborated = clusterRawOcrTokens(['TSUA 240 1.5%'], CORROBORATED);
  assert.deepEqual(corroborated.merged_list, ['TSLA'],
    'a correction one edit from its member is corroborated');
});

test('the shipped rule publishes a canonical no frame read', () => {
  // The recorded 20230605 cluster. AACO is 2 edits from AAPL and 2 from AAL;
  // the longer-on-a-tie rule chooses AAPL. Neither member is within distance
  // 1 of AAPL.
  const shipped = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], SHIPPED);
  assert.deepEqual(shipped.merged_list, ['AAPL'],
    'this is the defect: a holding no frame of the video showed');
});

test('the corroboration rule drops a canonical no member corroborates', () => {
  const corroborated = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], CORROBORATED);
  assert.deepEqual(corroborated.merged_list, [],
    'AAPL is 2 edits from AACO and 3 from ARCO, so nothing corroborates it');
});

test('the corroboration rule reports why it dropped a cluster', () => {
  const result = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], {
    ...CORROBORATED,
    explainDropped: true
  });
  const dropped = result.dropped.find((entry) => entry.reason === 'uncorroborated_correction');
  assert.ok(dropped, 'the drop was reported');
  assert.equal(dropped.canonical, 'AAPL');
  assert.deepEqual(dropped.members, ['AACO', 'ARCO']);
  assert.equal(dropped.distance, 2, 'the closest member is 2 edits away');
});

test('the corroboration rule is OFF unless it is asked for', () => {
  // The default has to be the shipped behaviour: the rule changes what a
  // scan publishes, and it is switched on only once it has been measured.
  const defaulted = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.deepEqual(defaulted.merged_list, ['AAPL']);

  const viaHelper = clusterVideoLevelReadings(['AACO ARCO', 'AACO ARCO'], {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.deepEqual(viaHelper.merged_list, ['AAPL'],
    'the shared helper does not turn the rule on by itself');
  assert.deepEqual(viaHelper.dropped, [],
    'nothing was dropped, so there is nothing to report');
});

// ---------------------------------------------------------------------------
// The SUPPORTED rule: the correction the VIDEO actually read
// ---------------------------------------------------------------------------

test('the supported rule breaks a tie with the video\'s support', () => {
  // Both of AACO's candidates are two edits away, so "closest" cannot
  // choose. The video read ARQQ in two frames and AAPL in none, so the
  // support decides.
  //
  // The candidate enumeration matters here: `findCloseTickerMatch` names ONE
  // ticker per member, and the tie-break inside it ("prefer the longer
  // ticker") picks between candidates that are EQUALLY close. ARCO has two
  // such candidates -- ARQQ and ARKG -- and the one it names is decided by
  // the lexicon's own order, not by the pixels. So the rule has to consider
  // ALL of a member's admissible corrections, not the one the shipped
  // helper happens to return.
  const supported = clusterRawOcrTokens(
    ['AACO ARCO ARQQ', 'AACO ARCO ARQQ'],
    SUPPORTED
  );
  assert.deepEqual(supported.merged_list, ['ARQQ'],
    'the supported correction wins the tie');
});

test('the supported rule keeps the closest candidate when nothing supports it', () => {
  // The video read neither ARQQ nor AAPL here, so there is no evidence to
  // break the tie and the rule falls back to the shipped choice.
  const supported = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], SUPPORTED);
  assert.deepEqual(supported.merged_list, ['AAPL'],
    'with no support anywhere, the rule agrees with the shipped one');
});

test('the video-supported rule prefers support over closeness', () => {
  // One cluster, two members, and the two rules disagree:
  //
  //   TSUA   -> TSLA  (1 edit, and the video never read TSLA)
  //   TSUAB  -> TSLB  (2 edits, and the video read TSLB in both frames)
  //
  // TSUA and TSUAB are one edit apart, so they cluster together, and the
  // cluster has candidates at two different distances.
  //
  //   the `supported` rule      -- distance first, so TSLA
  //   the `video-supported` rule -- support first, so TSLB
  //
  // That difference IS the two rules, and it is why both are measured.
  const frames = ['TSUA TSUAB TSLB', 'TSUA TSUAB TSLB'];

  const supported = clusterRawOcrTokens(frames, SUPPORTED);
  assert.deepEqual(supported.merged_list, ['TSLA', 'TSLB'],
    'the closer correction wins when the support only breaks ties');

  const videoSupported = clusterRawOcrTokens(frames, VIDEO_SUPPORTED);
  assert.deepEqual(videoSupported.merged_list, ['TSLB'],
    'the supported correction wins whatever its distance');
});

test('the video-supported rule keeps a member that IS a lexicon ticker', () => {
  // A member that is itself a lexicon ticker is a READING, and Strategy 1
  // claims it before any correction is considered.
  const supported = clusterRawOcrTokens(['ARQQ ARCO', 'ARQQ ARCO'], VIDEO_SUPPORTED);
  assert.deepEqual(supported.merged_list, ['ARQQ']);
});

test('the shipped rules are OFF unless they are asked for', () => {
  const defaulted = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.deepEqual(defaulted.merged_list, ['AAPL'],
    'the default is the shipped behaviour');

  const viaHelper = clusterVideoLevelReadings(['AACO ARCO', 'AACO ARCO'], {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.deepEqual(viaHelper.merged_list, ['AAPL'],
    'the shared helper does not turn the rule on by itself');
});

// ---------------------------------------------------------------------------
// The SWALLOWED-HOLDING rule
// ---------------------------------------------------------------------------

test('the swallowed-holding rule publishes a well-attested swallowed ticker', () => {
  // AI and LI are one edit apart, so the clusterer merges them -- but both
  // are rows of the panel, and LI was read in six frames of its own.
  //
  // The frames are what the rule counts, and the counts are the token's OWN
  // frames: the canonical's frames must not be credited to the swallowed
  // ticker, or every member of a well-attested cluster would look
  // well-attested.
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push('AI APLD LI');
  frames.push('AI APLD');

  const result = clusterRawOcrTokens(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1,
    publishSwallowedHoldings: true,
    swallowedHoldingMinFrames: 4
  });
  assert.ok(result.merged_list.includes('LI'),
    'a swallowed ticker the video read in 6 frames of its own is published');
  assert.ok(result.merged_list.includes('AI'),
    'and the canonical is still published');
});

test('the swallowed-holding rule rejects a one-off garble', () => {
  // The same cluster shape, but the swallowed ticker appears in ONE frame of
  // its own: a garble, not a holding.
  const frames = ['AI APLD LI', 'AI APLD', 'AI APLD', 'AI APLD', 'AI APLD'];

  const result = clusterRawOcrTokens(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1,
    publishSwallowedHoldings: true,
    swallowedHoldingMinFrames: 4
  });
  assert.ok(!result.merged_list.includes('LI'),
    'a swallowed ticker read in one frame is a garble, and is not published');
});

test('the swallowed-holding rule is OFF unless it is asked for', () => {
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push('AI APLD LI');
  frames.push('AI APLD');

  const defaulted = clusterRawOcrTokens(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.ok(!defaulted.merged_list.includes('LI'),
    'with the rule off, the swallowed ticker is not published');

  const viaHelper = clusterVideoLevelReadings(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1
  });
  assert.ok(!viaHelper.merged_list.includes('LI'),
    'the shared helper does not turn the rule on by itself');
});

test('the swallowed-holding rule records its evidence', () => {
  // The clusterer's input is NOT recorded in the probe log, so the log's own
  // frames cannot reproduce the clustering. The evidence for the decision has
  // to travel WITH the cluster, or a later reader cannot tell why one
  // swallowed ticker was published and another was not.
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push('AI APLD LI');
  frames.push('AI APLD');

  const result = clusterRawOcrTokens(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1,
    publishSwallowedHoldings: true,
    swallowedHoldingMinFrames: 4
  });
  const cluster = result.clusters.find((c) => c.canonical === 'AI');
  assert.ok(cluster, 'the AI cluster is there');
  assert.deepEqual(cluster.extraCanonicals, ['LI'],
    'the published swallowed ticker is recorded');
  const evidence = cluster.swallowedEvidence.find((e) => e.ticker === 'LI');
  assert.ok(evidence, 'the evidence is recorded');
  assert.equal(evidence.ownFrames, 6, 'and it carries the frame count it was judged on');
  assert.equal(evidence.published, true);
});

test('the swallowed-holding rule records a REJECTED swallowed ticker too', () => {
  // The evidence has to record what was rejected as well -- otherwise a log
  // cannot tell "the rule never saw it" from "the rule saw it and said no".
  const frames = ['AI APLD LI', 'AI APLD', 'AI APLD', 'AI APLD', 'AI APLD'];

  const result = clusterRawOcrTokens(frames, {
    lexicon: SYNTHETIC,
    minFrequency: 1,
    publishSwallowedHoldings: true,
    swallowedHoldingMinFrames: 4
  });
  const cluster = result.clusters.find((c) => c.canonical === 'AI');
  assert.ok(cluster, 'the AI cluster is there');
  assert.deepEqual(cluster.extraCanonicals, [],
    'a rejected swallowed ticker is not published');
  const evidence = cluster.swallowedEvidence.find((e) => e.ticker === 'LI');
  assert.ok(evidence, 'the evidence is recorded even for a rejection');
  assert.equal(evidence.ownFrames, 1, 'with the frame count it was judged on');
  assert.equal(evidence.published, false);
});

test('the supported rule survives the corroboration rule when the video read it', () => {
  // ARQQ is 2 edits from every member, so on its own it would fail the
  // corroboration gate -- but the video read it, which is corroboration of
  // a different and stronger kind.
  const both = clusterRawOcrTokens(
    ['AACO ARCO ARQQ', 'AACO ARCO ARQQ'],
    SUPPORTED_CORROBORATED
  );
  assert.deepEqual(both.merged_list, ['ARQQ']);
});

test('the corroboration rule accepts a canonical the video read', () => {
  // The corroboration gate asks "is this canonical corroborated?". A
  // canonical the VIDEO read in another frame is corroborated by the video,
  // whether or not it is one edit from this cluster's members.
  //
  // Note WHICH canonical is chosen here: the shipped rule still names AAPL
  // (the first member's correction), and AAPL is two edits from every
  // member and was never read by the video -- so the cluster is DROPPED,
  // and AAPL never reaches the merged list. ARQQ is published by its own
  // cluster, which is where it comes from.
  const result = clusterRawOcrTokens(
    ['AACO ARCO ARQQ', 'AACO ARCO ARQQ'],
    { ...CORROBORATED, explainDropped: true }
  );
  assert.deepEqual(result.merged_list, ['ARQQ']);
  assert.ok(
    result.dropped.some((entry) => entry.reason === 'uncorroborated_correction'),
    'the uncorroborated cluster was dropped'
  );
});

test('Filter A counts DISTINCT FRAMES, not occurrences', () => {
  // One frame, two occurrences of the same ticker: one frame, so a
  // threshold of 2 drops it.
  const oneFrame = clusterRawOcrTokens(['NFLX NFLX'], { lexicon: SYNTHETIC, minFrequency: 2 });
  assert.deepEqual(oneFrame.merged_list, [], 'one frame cannot satisfy a threshold of two');

  const twoFrames = clusterRawOcrTokens(['NFLX', 'NFLX'], { lexicon: SYNTHETIC, minFrequency: 2 });
  assert.deepEqual(twoFrames.merged_list, ['NFLX']);
});

test('a blocklisted canonical is dropped under both rules', () => {
  // FREY is a seed ticker and is on TICKER_BLOCKLIST: it is a chart ETF, not
  // a position. The blocklist is applied after the canonical is chosen.
  const shipped = clusterRawOcrTokens(['FREY 12 3%'], SHIPPED);
  assert.deepEqual(shipped.merged_list, []);

  const corroborated = clusterRawOcrTokens(['FREY 12 3%'], CORROBORATED);
  assert.deepEqual(corroborated.merged_list, []);
});

test('the production lexicon reaches the same AAPL the log recorded', () => {
  // The synthetic lexicon above fixes the arithmetic. This one checks the
  // REAL decode lexicon (seed + observed) against the recorded production
  // result, so a change to the seed cannot silently move the answer.
  const lexicon = loadDecodeLexiconSync();
  const shipped = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], {
    lexicon,
    minFrequency: 1
  });
  assert.deepEqual(shipped.merged_list, ['AAPL']);

  const corroborated = clusterRawOcrTokens(['AACO ARCO', 'AACO ARCO'], {
    lexicon,
    minFrequency: 1,
    requireDistanceOneCorroboration: true
  });
  assert.deepEqual(corroborated.merged_list, []);

  // The supported rule, on the real lexicon: the video read ARQQ, so that is
  // the correction it publishes.
  const supported = clusterRawOcrTokens(['AACO ARCO ARQQ', 'AACO ARCO ARQQ'], {
    lexicon,
    minFrequency: 1,
    preferSupportedCorrection: true
  });
  assert.deepEqual(supported.merged_list, ['ARQQ']);
});
