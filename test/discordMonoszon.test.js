'use strict';

// David Monoszon's calls, read out of Czech.
//
// Every rule here was measured on his corpus -- 4,500 of his messages in
// the `⚡｜indexy` channel of the TradeCZ server, 2025-07 .. 2026-11 --
// and every rule here exists because its absence produced a WRONG
// reading somewhere in it.
//
// The measured precision is in the last test: the hand-labelled sample
// says how many of the forward readings are a call on the instrument in
// the direction the parser says.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseMessage } = require('../src/discord/monoszon/parser');
const { SUBJECTS, SUBJECT_PATTERNS } = require('../src/discord/monoszon/subjects');
const { PARSER_VERSION, SOURCE_NAME } = require('../src/discord/monoszon/sources');

const ROOT = path.resolve(__dirname, '..');

function read(text) {
  return parseMessage(text, {
    message_id: 1,
    posted_at: '2026-01-02T10:00:00Z',
    parser_version: PARSER_VERSION,
    source_name: SOURCE_NAME,
  });
}

function first(text) {
  const rows = read(text);
  return rows.length ? rows[0] : null;
}

test('a forward call is a call about the future', () => {
  const row = first('Takže bych řekle že dne znovu se pokusí o SPX 6200 - a tam budu vyhlížet kupce, ke kterým bych se intradenně přidal');
  assert.ok(row);
  assert.equal(row.subject, 'SPX');
  assert.equal(row.stance, 'bullish');
  assert.equal(row.claim_kind, 'forward');
  assert.equal(row.proxy_ticker, 'SPY');
  assert.equal(row.horizon, 'intraday');
});

test('a retrospective call is a fact, and it is not scored', () => {
  const row = first('Tenhle TLT long byl krásně docekany swing trade');
  assert.ok(row);
  assert.equal(row.claim_kind, 'retrospective');
  assert.equal(row.subject, 'TLT');
});

test('a LIVE position is not a call either', () => {
  // "dnes uzavírám třetinu BTAL longu" -- the position he holds, which
  // has already had its move.
  const row = first('dnes uzavírám třetinu BTAL longu a budu sledovat, jestli mi trh dá možnost vyprostit se se zbytkem za lepší cenu');
  assert.ok(row);
  assert.equal(row.claim_kind, 'present');
});

test('the direction attaches to the instrument, and to ONE instrument', () => {
  // The ZB is the thing being defended; the call is on the TLT.
  const rows = read('makro trhy: bondy nyní potřebují podržet aby nepokračovaly propad pod týdenní linku ZB, TLT má ještě kousek k týdenní lince a mohl by tam být zajímavý swing long');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'TLT');
  assert.equal(rows[0].stance, 'bullish');
  assert.equal(rows[0].horizon, 'swing');
});

test('an option spread reverses the direction', () => {
  // "já budu nakupovat put spready na SPX 6580" is a BEARISH call on SPX,
  // and reading the "nakupovat" as bullish gets it exactly wrong.
  const row = first('já budu nakupovat put spready na SPX 6580, možná se tam dostaneme už dnes');
  assert.ok(row);
  assert.equal(row.stance, 'bearish');
  assert.equal(row.subject, 'SPX');
});

test('a negation reverses the direction', () => {
  // "určitě bych dnes nespěchal do longu" is not a long.
  const row = first('SI futures kreverzní týden  - určitě bych dnes nespěchal do longu, nechal bych to na pondělek');
  assert.ok(row);
  assert.equal(row.stance, 'bearish');
  assert.equal(row.subject, 'SI');
});

test('a regime is not a call', () => {
  // "v bull marketu" and "komoditního bull cyklu" describe the tape.
  assert.equal(read('v bull marketu nečekám až na tick na target').length, 0);
  assert.equal(read('tak si myslím že jsme v třetině komoditního bull cyklu, tak výlet zlata k 2000 je méně pravděpodobný').length, 0);
});

test('a short covering is a squeeze, and a squeeze is UP', () => {
  // The Czech case ending rides on the noun: "short coveringu".
  const row = first('spx 6550 bychom mohli vidět zahájení short coveringu');
  assert.ok(row);
  assert.equal(row.stance, 'bullish');
  assert.equal(row.subject, 'SPX');
});

test('the caps symbols are matched in BOTH cases, and "SI" is not', () => {
  // He writes "spx" and "nq" in lower case, and both are the instrument.
  assert.equal(first('pokud nyní nemám téměř žádné SPY a plánuji nakoupit na denní lince').subject, 'SPY');
  assert.equal(first('takže zvažuju že půjdu swing long na qqq pokud uvidíme větší intradenní pullback').subject, 'QQQ');
  // But "si" is the reflexive pronoun in Czech, and a case-insensitive
  // "SI" matched it on 421 messages.
  const si = SUBJECTS.find((subject) => subject.spoken === 'SI');
  const siPattern = SUBJECT_PATTERNS.find((entry) => entry.subject.spoken === 'SI');
  assert.ok(si);
  assert.ok(si.caseSensitive);
  assert.ok(siPattern);
  assert.ok(!siPattern.pattern.test('přál bych si aby mohl prodat'));
  assert.ok(siPattern.pattern.test('SI futures kreverzní týden'));
});

test('the subject is the one the direction hangs off', () => {
  // "pokud uvidím nástup kupců na spx 6700 a nq nwogu, tak se přidám" --
  // one call, two instruments, and each gets its own reading.
  const rows = read('neob jinak, pokud uvidím nástup kupců na spx 6700 a nq nwogu, tak se přidám');
  const subjects = rows.map((row) => row.subject).sort();
  assert.deepEqual(subjects, ['NQ', 'SPX']);
  for (const row of rows) assert.equal(row.stance, 'bullish');
});

test('the level he names is recorded, and it is not the entry', () => {
  const row = first('abych změnil na bearish, potřeboval bych vidět spx uzavírat pod 6550');
  assert.ok(row);
  assert.equal(row.level, '6550');
  assert.equal(row.stance, 'bearish');
});

test('the reading carries the sentence it was read from', () => {
  const row = first('na open budu uvažovat o swing long TLT');
  assert.ok(row);
  assert.ok(row.evidence_text.includes('swing long TLT'));
  assert.equal(row.evidence_text.length > 0, true);
});

test('the hand-labelled sample measures the precision', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'test', 'fixtures', 'monoszon', 'labelled_readings.json'),
    'utf8',
  ));
  const readings = fixture.readings;
  assert.ok(readings.length >= 60, 'the sample is the whole forward corpus');

  // Every labelled sentence is re-read through the parser, and the
  // reading has to come back the way the label says it was.
  let correct = 0;
  const wrong = [];
  for (const labelled of readings) {
    const parsed = read(labelled.text).find((row) => row.subject === labelled.subject
      && row.stance === labelled.stance);
    if (!parsed) {
      wrong.push({ text: labelled.text.slice(0, 60), reason: 'the parser no longer reads it' });
      continue;
    }
    if (labelled.label === 'correct') correct += 1;
    else wrong.push({ text: labelled.text.slice(0, 60), reason: labelled.label_note });
  }
  const precision = correct / readings.length;
  // The measured precision is 88.4 %. The floor is 80 %: a parser change
  // that drops it below that has broken something.
  assert.ok(precision >= 0.8, `measured precision ${(precision * 100).toFixed(1)} %`);
  assert.equal(wrong.length, readings.length - correct);
});
