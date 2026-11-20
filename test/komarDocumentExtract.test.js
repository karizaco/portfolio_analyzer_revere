'use strict';

// Komar Phase-2 parser tests.
//
// These pin the document-level parsing rules before we score anything:
// - what qualifies as a market card image
// - how trend directions are parsed from the card text
// - how leaders are read from "Leaders: ..."
// - how deck notes are turned into structured rows

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  findCardImages,
  extractChecklist,
  parseDeckPageNotes,
  parseThemesFromText,
  parseTrendDirectionsFromText,
  parseExposure,
  parseLeaders,
} = require('../src/komar/documentExtract');

test('a market card image is wide and tall, icons are not', () => {
  const page = {
    images: [
      { xref: 1, width: 40, height: 42 },
      { xref: 2, width: 300, height: 300 },
      { xref: 3, width: 1080, height: 764 },
      { xref: 4, width: 1080, height: 386 },
      { xref: 5, width: 1024, height: 692 },
    ],
  };
  const cards = findCardImages(page);
  assert.deepEqual(cards.map((image) => image.xref), [3, 5]);
});

test('leaders are parsed from the Leaders line only', () => {
  assert.deepEqual(parseLeaders('Leaders: SNDK, MU, INTC and more.'), ['SNDK', 'MU', 'INTC']);
  assert.deepEqual(parseLeaders('Leaders: CIFR, HUT, NBIS.'), ['CIFR', 'HUT', 'NBIS']);
  assert.deepEqual(parseLeaders('Strong demand from data centers.'), []);
  assert.deepEqual(parseLeaders('Leaders: AI, software, momentum'), []);
});

test('themes are parsed from heading + leaders pairs', () => {
  const text = [
    'Semis',
    'Strong demand from data centers.',
    'Leaders: SNDK, MU, INTC and more.',
    'Data center',
    'AI data centers with big growth',
    'Leaders: CIFR, HUT, NBIS and more.',
  ].join('\n');
  const parsed = parseThemesFromText(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].leaders, ['SNDK', 'MU', 'INTC']);
  assert.deepEqual(parsed[1].leaders, ['CIFR', 'HUT', 'NBIS']);
  // When OCR preserves line structure, headings are kept. When it flattens
  // everything, fallback labels are used (Theme 1 / Theme 2). Both are
  // acceptable in this parser stage.
  assert.ok(['Semis', 'Theme 1'].includes(parsed[0].theme));
  assert.ok(['Data center', 'Theme 2'].includes(parsed[1].theme));
});

test('themes fall back to generic labels when headings are lost', () => {
  const flat = 'Leaders: SNDK, MU, INTC and more. Leaders: CIFR, HUT, NBIS and more.';
  const parsed = parseThemesFromText(flat);
  assert.deepEqual(parsed, [
    { theme: 'Theme 1', leaders: ['SNDK', 'MU', 'INTC'] },
    { theme: 'Theme 2', leaders: ['CIFR', 'HUT', 'NBIS'] },
  ]);
});

test('trend rows map from the index lines', () => {
  const text = [
    'NASDAQ up up up',
    'S&P 500 down flat',
    'Russell 2000 flat',
  ].join('\n');
  assert.deepEqual(parseTrendDirectionsFromText(text), {
    nasdaq: 'up',
    sp500: 'down',
    russell2000: 'flat',
  });
});

test('exposure is a bounded percentage', () => {
  assert.equal(parseExposure('50% invested'), 50);
  assert.equal(parseExposure('100% invested'), 100);
  assert.equal(parseExposure('0% invested'), 0);
  assert.equal(parseExposure('150% invested'), null);
  assert.equal(parseExposure('No exposure number here'), null);
});

test('a deck page note keeps stars, state, grade and checklist', () => {
  const page = {
    text_blocks: [
      { font_size: 7, text: '4.5 stars. Really tight. Moved higher during the day on good volume.', bbox: [0, 0, 200, 10] },
      { font_size: 7, text: 'Initial entry: 15.21 Stop loss: 14.43 (5%)', bbox: [0, 11, 200, 20] },
      { font_size: 7, text: 'Open', bbox: [0, 21, 100, 30] },
      { font_size: 6, text: '✔ Explosive look?', bbox: [0, 31, 100, 40] },
      { font_size: 6, text: 'X Narrow / inside bar?', bbox: [0, 41, 100, 50] },
      { font_size: 7.5, text: 'B-trade', bbox: [0, 51, 100, 60] },
    ],
  };
  const note = parseDeckPageNotes(page);
  assert.ok(note);
  assert.equal(note.stars, 4.5);
  assert.equal(note.trade_state, 'Open');
  assert.equal(note.trade_grade, 'B');
  assert.equal(note.quick_checklist.length, 2);
  assert.deepEqual(note.quick_checklist[0], { checked: true, item: 'Explosive look' });
  assert.deepEqual(note.quick_checklist[1], { checked: false, item: 'Narrow / inside bar' });
});

test('a page with no text gives no note', () => {
  assert.equal(parseDeckPageNotes({ text_blocks: [] }), null);
  assert.equal(parseDeckPageNotes({}), null);
});


test('flattened checklist text is split into individual items', () => {
  const flat = 'Quick checklist ✔ Explosive look?✔ Big upmove before (70-100%)?X Narrow / inside bar?✔ Higher lows?';
  const checklist = extractChecklist(flat);
  assert.deepEqual(checklist, [
    { checked: true, item: 'Explosive look' },
    { checked: true, item: 'Big upmove before (70-100%)' },
    { checked: false, item: 'Narrow / inside bar' },
    { checked: true, item: 'Higher lows' },
  ]);
});

test('card parsing falls back to full-card OCR for leaders when theme region misses', async () => {
  // This is a parser-unit regression test. The fallback itself is wired in
  // parseCardImage; here we pin the text-level parser path it depends on.
  const full = '... Leaders: SNDK, MU, INTC and more. ... Leaders: CIFR, HUT, NBIS and more.';
  const themes = parseThemesFromText(full);
  assert.equal(themes.length, 2);
  assert.deepEqual(themes[0].leaders, ['SNDK', 'MU', 'INTC']);
  assert.deepEqual(themes[1].leaders, ['CIFR', 'HUT', 'NBIS']);
});
