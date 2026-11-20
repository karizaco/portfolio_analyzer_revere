'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  readRecapJudgments,
  weekWindowFromRecapDate,
  applyRecapJudgments,
} = require('../src/fundedmind/recapRead');
const { extractSignals, PARSER_VERSION } = require('../src/fundedmind/signalExtractor');
const { sessionKind, FUNDEDMIND_KINDS } = require('../src/fundedmind/contentFilter');

test('week window is the 7 days ending on the recap title date', () => {
  assert.deepEqual(weekWindowFromRecapDate('20250509'), {
    start: '20250503',
    end: '20250509',
  });
});

test('recap reader finds past short and no-trade claims', () => {
  const judgments = readRecapJudgments([
    { text: 'Já jsem short na Nasdak.', start_sec: 10 },
    { text: 'Co se týče euro dolarů, tak tenhlecten týden jsem nevzal žádnej obchod.', start_sec: 40 },
    { text: 'Zde jsem hral právě longovou pozici na Bitcoinu.', start_sec: 70 },
  ]);
  const byTicker = Object.fromEntries(judgments.map((j) => [j.ticker || 'NONE', j.verdict]));
  assert.equal(byTicker.NAS100, 'confirm');
  assert.equal(byTicker.EURUSD || byTicker.NONE || judgments.find((j) => j.verdict === 'no_trade')?.verdict, 'no_trade');
  assert.equal(byTicker.BTC, 'confirm');
});

test('week_recap extract path emits retrospective judgments not live spam', () => {
  assert.equal(sessionKind('Week Recap - Petr Můčka | 9.5. 2025'), FUNDEDMIND_KINDS.WEEK_RECAP);
  const signals = extractSignals(
    [
      { text: 'Já jsem short na Nasdak.', start_sec: 12 },
      { text: 'týden jsem nevzal žádnej obchod na euro dolaru', start_sec: 20 },
    ],
    { title: 'Week Recap - Petr Můčka | 9.5. 2025', video_id: 'recap1' },
  );
  assert.ok(signals.length >= 1);
  assert.ok(signals.every((s) => s.claim_kind === 'retrospective'));
  assert.ok(signals.every((s) => s.parser_version === PARSER_VERSION));
  assert.ok(signals.some((s) => /recap_verdict=/.test(s.rationale)));
});

test('applyRecapJudgments stamps matching week setups', () => {
  const setups = [
    {
      video_id: 'live1',
      session_date: '20250507',
      kind: 'live_trading',
      ticker: 'NAS100',
      side: 'short',
      score: 3,
      status: 'still_open',
      recap_verdict: '',
    },
    {
      video_id: 'live2',
      session_date: '20250401',
      kind: 'live_trading',
      ticker: 'NAS100',
      side: 'short',
      score: 3,
      status: 'closed',
      recap_verdict: '',
    },
  ];
  const { applied } = applyRecapJudgments(
    setups,
    [{ ticker: 'NAS100', side: 'short', verdict: 'confirm', evidence_text: 'short nas', video_id: 'recap' }],
    weekWindowFromRecapDate('20250509'),
  );
  assert.equal(applied, 1);
  assert.equal(setups[0].recap_verdict, 'confirm');
  assert.equal(setups[0].recap_video_id, 'recap');
  assert.equal(setups[1].recap_verdict, '');
});
