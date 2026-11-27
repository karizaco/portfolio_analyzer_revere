'use strict';

// Martin Klass's calls, read out of Czech.
//
// The rules here were measured on his corpus -- 1,013 messages across
// two channels of his own server, 2025-02 .. 2026-11 -- and the last
// test measures the PRECISION of the forward readings against a
// hand-labelled sample.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parsePost } = require('../src/discord/martinklass/parser');
const { loadLexicon } = require('../src/discord/symbols');

const ROOT = path.resolve(__dirname, '..');
// The market's OWN list: a company name is resolved through the
// registrants, so the reader needs all of them and not a handful.
const LEXICON = loadLexicon();

function read(content, channel = 'martinklass-investing') {
  return parsePost(content, { channel, lexicon: LEXICON, posted_at: '2026-01-02T10:00:00Z' });
}

test('a forward call is a call about the future', () => {
  const rows = read('**🚀 Akcie $KO bych rád přidal do mého portfolia na eToro, ovšem za lepší cenu, než je ATH.**');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'KO');
  assert.equal(rows[0].proxy_ticker, 'KO');
  assert.equal(rows[0].stance, 'bullish');
  assert.equal(rows[0].claim_kind, 'forward');
});

test('a report of what already happened is recorded, and NOT scored', () => {
  const rows = read('📉 Pokles akcií SanDisk Dnešní obchodování zahájily akcie společnosti SanDisk poklesem');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claim_kind, 'reported');
});

test('the commodities are his, in Czech', () => {
  const gold = read('🌽 Jednou ze základních komodit je i pšenice, jejíž cena prorazila výše.');
  assert.equal(gold[0].proxy_ticker, 'WEAT');
  const silver = read('Stříbro se aktuálně obchoduje na maximech z roku 2011, což je supportní úroveň, od které by se trh mohl odrazit.');
  assert.equal(silver[0].proxy_ticker, 'SLV');
  assert.equal(silver[0].stance, 'bullish');
});

test('a company name is resolved through the market\'s own list', () => {
  // The shared matcher, which is the market's own registrant file, and
  // which resolves some names and not others -- "Ambarella" is not in it,
  // and "CrowdStrike" is.
  const rows = read('**CrowdStrike kupuje Zscaler za 43,9 miliardy dolaru a akcie navzdory rekordním výsledkůů m klesají**');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proxy_ticker, 'CRWD');
  assert.equal(rows[0].claim_kind, 'reported');
});

test('the HEADLINE decides the subject, and the body cannot steal it', () => {
  // The message is about CRM; the body names another ticker, and reading
  // the body as a SECOND reading put two companies on one message.
  const rows = read('**🚀 Akcie $CRM prorazily klesající trendovou čaru** Tyto akcie sleduji kvůli nákupu do pozice $AAPL');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proxy_ticker, 'CRM');
  assert.equal(rows[0].stance, 'bullish');
});

test('a direction far from the subject is not a direction for it', () => {
  // "Velkou pozornost vyvolalo oznámení spolupráce se společností
  // Microsoft" is an announcement, and whatever word the next paragraph
  // uses is not a call on Microsoft.
  const rows = read('Velkou pozornost vyvolalo oznámení spolupráce se společností Microsoft, které bude využívat cloudové služby pro AI infrastrukturu. Růst tržeb pak pokračuje.');
  assert.equal(rows.length, 0);
});

test('the hand-labelled sample measures the precision', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'martinklass', 'labelled_readings.json'),
    'utf8',
  ));
  const readings = fixture.readings;
  assert.ok(readings.length >= 40, 'the sample is the whole forward corpus');

  let correct = 0;
  const wrong = [];
  for (const labelled of readings) {
    const parsed = read(labelled.text, labelled.channel);
    const row = parsed.find((entry) => entry.subject === labelled.subject
      && entry.stance === labelled.stance);
    if (!row) {
      wrong.push({ text: labelled.text.slice(0, 50), reason: 'the parser no longer reads it' });
      continue;
    }
    if (labelled.label === 'correct') correct += 1;
    else wrong.push({ text: labelled.text.slice(0, 50), reason: labelled.label_note });
  }
  const precision = correct / readings.length;
  // The measured precision is 73.3 %. The floor is 65 %: a parser change
  // that drops it below that has broken something.
  assert.ok(precision >= 0.65, `measured precision ${(precision * 100).toFixed(1)} %`);
  assert.equal(wrong.length, readings.length - correct);
});
