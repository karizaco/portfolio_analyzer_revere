'use strict';

// The dashboard's own guarantees.
//
// WHY THESE TESTS EXIST
//
// The dashboard is the artifact a reader actually looks at, and it has
// three properties worth pinning:
//
//   1. It is SELF-CONTAINED. No CDN, no external stylesheet, no fetched
//      script. A report that needs a network to render is a report that
//      renders blank on a plane -- and the whole point of a dashboard is
//      that it can be opened.
//
//   2. The EVIDENCE is in it. A signal row can be expanded to the
//      transcript text it was read from. A dashboard that shows the
//      conclusion but not the evidence is asking to be trusted, and
//      nothing here should ask to be trusted.
//
//   3. It ESCAPES what it prints. The evidence is the speaker's own
//      words, and those words can contain angle brackets and ampersands.
//      Unescaped, they would break the page.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSevcikReportHtml, escapeHtml, formatTime } = require('../src/report/sevcikReport');

const PAYLOAD = {
  generated_at: '2026-11-04T00:00:00.000Z',
  signal_count: 2,
  video_count: 1,
  unique_tickers: 1,
  signals: [
    {
      video_id: 'vid1',
      upload_date: '20261104',
      provider: 'youtube_auto',
      event_time_sec: 125,
      ticker: 'TQQQ',
      action: 'buy',
      bias: 'bullish',
      confidence_label: 'high',
      confidence_score: 0.85,
      entry_price: 75,
      target_price_low: 82,
      target_price_high: '',
      stop_price: '',
      horizon_text: 'swing',
      rationale: 'I am going to buy TQQQ at 75.',
      evidence_text: 'I am going to buy TQQQ at 75, target is 82 <not a tag> & more.',
      parser_version: 'sevcik-signals-1',
    },
    {
      video_id: 'vid1',
      upload_date: '20261104',
      provider: 'youtube_auto',
      event_time_sec: 200,
      ticker: 'TQQQ',
      action: '',
      bias: 'bearish',
      confidence_label: 'low',
      confidence_score: 0.4,
      entry_price: '',
      target_price_low: '',
      target_price_high: '',
      stop_price: '',
      horizon_text: '',
      rationale: 'I am not bullish on it any more.',
      evidence_text: 'I am not bullish on it any more.',
      parser_version: 'sevcik-signals-1',
    },
  ],
  daily: [
    {
      upload_date: '20261104',
      video_id: 'vid1',
      title: 'A stream',
      provider: 'youtube_auto',
      signal_count: 2,
      bullish_count: 1,
      bearish_count: 1,
      neutral_count: 0,
      mixed_count: 0,
      unique_tickers: 1,
      avg_confidence: 0.625,
      high_confidence_count: 1,
      signals_with_entry: 1,
      signals_with_target: 1,
      tickers: 'TQQQ',
    },
  ],
  tickers: [
    {
      ticker: 'TQQQ',
      signal_count: 2,
      bullish_count: 1,
      bearish_count: 1,
      neutral_count: 0,
      mixed_count: 0,
      video_count: 1,
      first_date: '20261104',
      last_date: '20261104',
      avg_confidence: 0.625,
      max_confidence: 0.85,
      high_confidence_count: 1,
      signals_with_entry: 1,
      signals_with_target: 1,
      avg_entry_price: 75,
      avg_target_price: 82,
      bullish_ratio: 0.5,
    },
  ],
};

test('the dashboard is self-contained', () => {
  const html = buildSevcikReportHtml(PAYLOAD);
  assert.ok(!/<script[^>]+src=/i.test(html), 'no script may be fetched from the network');
  assert.ok(!/<link[^>]+href=/i.test(html), 'no stylesheet may be fetched from the network');
  assert.ok(!/https?:\/\//.test(html), 'no external URL may appear at all');
});

test('the dashboard carries the evidence text', () => {
  const html = buildSevcikReportHtml(PAYLOAD);
  assert.ok(html.includes('I am going to buy TQQQ at 75, target is 82'),
    'the signal evidence must be in the dashboard');
});

test('the dashboard escapes what it prints', () => {
  const html = buildSevcikReportHtml(PAYLOAD);
  assert.ok(html.includes('&lt;not a tag&gt;'), 'angle brackets must be escaped');
  assert.ok(html.includes('&amp; more'), 'ampersands must be escaped');
  assert.ok(!html.includes('<not a tag>'), 'the raw tag must not survive');
});

test('the dashboard shows every signal', () => {
  const html = buildSevcikReportHtml(PAYLOAD);
  assert.ok(html.includes('TQQQ'));
  assert.ok(html.includes('bullish'));
  assert.ok(html.includes('bearish'));
});

test('the dashboard says plainly when there is nothing yet', () => {
  const html = buildSevcikReportHtml({
    generated_at: 'now',
    signal_count: 0,
    video_count: 0,
    unique_tickers: 0,
    signals: [],
    daily: [],
    tickers: [],
  });
  assert.ok(html.includes('No signals have been extracted yet'),
    'an empty dashboard must say so, rather than looking like a broken one');
});

test('the dashboard does not break on an empty payload', () => {
  const html = buildSevcikReportHtml({});
  assert.ok(html.includes('<!DOCTYPE html>'));
});

// -- THE SETUPS --------------------------------------------------------

const SETUP_PAYLOAD = {
  generated_at: '2026-11-05T00:00:00.000Z',
  signal_count: 0,
  video_count: 1,
  unique_tickers: 0,
  setup_count: 2,
  signals: [],
  daily: [],
  tickers: [],
  setups: [
    {
      video_id: 'vid1',
      upload_date: '20261104',
      provider: 'youtube_auto',
      event_time_sec: 125,
      ticker: 'TSLA',
      spoken_name: 'Tesla',
      state: 'failed',
      states: 'worked,new,running,failed',
      mentions: 5,
      certainty_level: 'even',
      certainty_confidence: 0.55,
      certainty_marker: '50 na 50',
      probability: 50,
      direction_uncertain: 1,
      still_running: 0,
      invalidated: 0,
      worked: 1,
      failed: 1,
      evidence_text: 'Tesla predikce vyšla.\nAle pak nevyšla.',
      parser_version: 'sevcik-setups-1',
    },
    {
      video_id: 'vid1',
      upload_date: '20261104',
      provider: 'youtube_auto',
      event_time_sec: 400,
      ticker: 'AAPL',
      spoken_name: 'Apple',
      state: 'running',
      states: 'running',
      mentions: 2,
      certainty_level: 'conditional',
      certainty_confidence: 0.5,
      certainty_marker: 'podmíněná',
      probability: '',
      direction_uncertain: 0,
      still_running: 1,
      invalidated: 0,
      worked: 0,
      failed: 0,
      evidence_text: 'Apple predikce běží.',
      parser_version: 'sevcik-setups-1',
    },
  ],
  setup_daily: [],
  setup_tickers: [
    {
      ticker: 'TSLA',
      spoken_name: 'Tesla',
      setup_count: 1,
      video_count: 1,
      first_date: '20261104',
      last_date: '20261104',
      worked_count: 1,
      failed_count: 1,
      invalidated_count: 0,
      still_running_count: 0,
      avg_certainty: 0.55,
      high_certainty_count: 0,
      conditional_count: 0,
      even_count: 1,
      low_certainty_count: 0,
      direction_uncertain_count: 1,
      mentions: 5,
    },
  ],
};

test('the dashboard shows the SETUPS and their states', () => {
  const html = buildSevcikReportHtml(SETUP_PAYLOAD);
  assert.ok(html.includes('TSLA'), 'the setup ticker must be in the dashboard');
  assert.ok(html.includes('Tesla'), 'the name he SAID must be in the dashboard');
  assert.ok(html.includes('failed'), 'the state must be in the dashboard');
  assert.ok(html.includes('conditional'), 'the certainty must be in the dashboard');
});

test('the dashboard carries the setup evidence', () => {
  const html = buildSevcikReportHtml(SETUP_PAYLOAD);
  assert.ok(html.includes('Tesla predikce vyšla.'),
    'the setup evidence must be in the dashboard');
});

test('the dashboard shows the setup lifecycle in order', () => {
  const html = buildSevcikReportHtml(SETUP_PAYLOAD);
  assert.ok(html.includes('worked → new → running → failed'),
    'the states must be shown in the order they happened');
});

test('the dashboard counts the setups', () => {
  const html = buildSevcikReportHtml(SETUP_PAYLOAD);
  assert.ok(html.includes('setups'), 'the headline must count the setups');
});

test('the dashboard does not break with setups but no signals', () => {
  const html = buildSevcikReportHtml(SETUP_PAYLOAD);
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('TSLA'));
});

test('HTML is escaped', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml(null), '');
});

test('a timestamp is formatted as a time', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
});
