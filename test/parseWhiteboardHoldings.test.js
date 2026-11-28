'use strict';

// The Revere whiteboard parser, driven with REAL frames.
//
// The fixtures under test/fixtures/revere_whiteboard/ are three real captures
// — 20260922, 20260924 and 20260928 — with BOTH the pixels and the OCR result
// frozen. The OCR is frozen because Tesseract's output is what the parser
// reads; if the test re-OCRed the frame, a Tesseract upgrade would move the
// numbers and the test would stop meaning anything. The pixels are kept
// because the parser's geometry comes from them: the whiteboard window is
// detected by pixel analysis, and the holdings list is bounded by it.
//
// Every case below was a defect that cost a whole portfolio or a whole
// holding:
//
//   1. A misread portfolio LABEL costs everything. Tesseract reads "TURBO" as
//      "TURBG" (20260924); a parser that matches the label exactly never
//      finds the TURBO holdings row.
//   2. The action line then bleeds in. The action line is read with a quote
//      rather than with '* ', so a section that ends only at the next '* '
//      swallows it, and DELL and SMTC come in as holdings.
//   3. A lost separator fuses two holdings into one token ("TQQNCLD"), and a
//      separator read as a PERIOD does the same ("LITE.OOCN"). The token must
//      be split back into the tickers it holds.
//   4. A CORRECTION is only safe inside a list of holdings. The chart is
//      drawn beside the holdings list on the same OCR line, and its
//      annotations are one edit away from real tickers ("wal”" → HAL,
//      "by" → BE). Correcting an isolated word invents holdings out of the
//      chart.
//   5. A token with two equally close candidates is dropped, not guessed.
//      "IBT" is one edit from both IBIT and IOT, and the parser cannot know
//      which instrument was meant.
//   6. A holding the allow-list does not know is RESOLVED and then DROPPED.
//      SPXL was in the observed lexicon but not in the seed allow-list, so it
//      was found exactly and then thrown away — and because the screen writes
//      it as "UPRO/SPXL", the slash hid it from the rejection log as well.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseWhiteboardScreenshotWithBoxes,
  detectWhiteboardWindow,
} = require('../src/parse/parseWhiteboardScreenshotWithBoxes');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'revere_whiteboard');

/**
 * The holdings each fixture's frame really shows, as the parser reads them.
 *
 * These are the readings the ground truth (data/revere_ground_truth.json)
 * lists, minus the holdings the OCR lost outright: on 20260924 the screen
 * says "MU,P" and Tesseract read it as "UP.", so MU is gone and P cannot be
 * recovered from what is left. Guessing them would be inventing holdings.
 */
const EXPECTED = {
  '20260922': {
    GRO: ['AMD', 'BE', 'DOCN', 'HPE', 'LITE', 'MU', 'NCLD', 'P', 'PLTR', 'SNOW', 'SKHY', 'SPYM', 'TNA', 'TQQQ', 'U', 'UPRO'],
    TURBO: ['ETHA', 'IBIT', 'LABU', 'MRNA', 'P', 'PURR', 'SMTC', 'SPCX', 'SPXL', 'SPYM', 'UPRO'],
  },
  '20260924': {
    GRO: ['AMD', 'BE', 'DOCN', 'HPE', 'LITE', 'NCLD', 'PLTR', 'SKHY', 'SNOW', 'SPYM', 'TQQQ', 'UPRO'],
    TURBO: ['ETHA', 'HPE', 'MRNA', 'PURR', 'SPXL', 'SPYM', 'UPRO'],
  },
  '20260928': {
    GRO: ['AMD', 'BE', 'HPE', 'MU', 'NET', 'P', 'PLTR', 'SNOW', 'SPYM', 'TQQQ', 'UPRO'],
    TURBO: ['ETHA', 'HPE', 'IBIT', 'MRNA', 'P', 'SKHY', 'SPCX', 'SPXL', 'SPYM', 'UPRO'],
  },
};

/**
 * The holdings the ground truth lists that the parser cannot read, and why.
 *
 * Every one of them is an OCR loss, not a parser decision: the characters
 * are not on the screen in a form the parser could defend.
 */
const OCR_LOSSES = {
  '20260922': { GRO: [], TURBO: [] },
  '20260924': {
    // "MU,P" was read as "UP." — the M is gone and the comma became a period.
    GRO: ['MU', 'P'],
    // "IBIT" was read as "IBT" (one edit from IBIT and from IOT) and "SPCX"
    // as "SPO" (one edit from SPOT and from SSO); ",P," was dropped whole.
    TURBO: ['IBIT', 'P', 'SPCX'],
  },
  '20260928': { GRO: [], TURBO: [] },
};

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function readManifest() {
  const file = path.join(FIXTURE_DIR, 'manifest.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Parse one fixture and return the readings by portfolio.
 */
async function readFixture(capture) {
  const ocr = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, capture.ocr), 'utf8'));
  const framePath = path.join(FIXTURE_DIR, capture.frame);
  const rows = await parseWhiteboardScreenshotWithBoxes({
    metadata: { asOfDate: capture.date, fileName: capture.video, sequence: '' },
    ocr,
    framePath,
  });
  const readings = {};
  for (const row of rows || []) {
    const portfolio = String(row.portfolio || '').toUpperCase();
    readings[portfolio] = (row.tickers_from_bbox || []).map((t) => String(t).toUpperCase());
  }
  return readings;
}

const manifest = readManifest();
const CAPTURES = new Map(manifest.captures.map((c) => [c.date, c]));

test('the fixtures are the frames the manifest names', () => {
  // A frame's identity is its FILE, not its label: several directories hold
  // files with the same name and different contents. The md5 is what makes
  // the reading below a property of (code, frame).
  assert.ok(CAPTURES.size >= 3, 'three frames are pinned');
  for (const capture of manifest.captures) {
    assert.equal(md5(path.join(FIXTURE_DIR, capture.frame)), capture.frame_md5, `${capture.frame} is the pinned frame`);
    assert.equal(md5(path.join(FIXTURE_DIR, capture.ocr)), capture.ocr_md5, `${capture.ocr} is the pinned OCR`);
  }
});

test('every portfolio of every fixture is read', async () => {
  for (const [date, expected] of Object.entries(EXPECTED)) {
    const capture = CAPTURES.get(date);
    assert.ok(capture, `${date} has a fixture`);
    const readings = await readFixture(capture);
    for (const portfolio of ['GRO', 'TURBO']) {
      assert.ok(readings[portfolio], `${date} ${portfolio} is read`);
      assert.deepEqual(
        [...readings[portfolio]].sort(),
        [...expected[portfolio]].sort(),
        `${date} ${portfolio}: got ${JSON.stringify(readings[portfolio])}`,
      );
    }
  }
});

test('the ground truth and the parser agree, apart from the OCR losses', async () => {
  const gt = require('../data/revere_ground_truth.json');
  const frameIds = {
    '20260922': 'tWfLqBqt3RI_001136',
    '20260924': 'plSP0tefisg_000520',
    '20260928': 'Fxi2xAVpp-A_000900_B',
  };
  for (const [date, frameId] of Object.entries(frameIds)) {
    const truth = gt[date] && gt[date][frameId];
    assert.ok(truth, `${date} ${frameId} is in the ground truth`);
    const readings = await readFixture(CAPTURES.get(date));
    for (const portfolio of ['GRO', 'TURBO']) {
      const read = new Set(readings[portfolio] || []);
      const expected = new Set(truth[portfolio.toLowerCase()]);
      const missed = [...expected].filter((t) => !read.has(t)).sort();
      const extra = [...read].filter((t) => !expected.has(t)).sort();
      assert.deepEqual(missed, [...OCR_LOSSES[date][portfolio]].sort(), `${date} ${portfolio} misses`);
      assert.deepEqual(extra, [], `${date} ${portfolio} invents no holding`);
    }
  }
});

test('a misread portfolio label still finds the whole portfolio', async () => {
  // Tesseract reads the label of the 20260924 TURBO row as "TURBG". A parser
  // that matches the label exactly loses the portfolio completely.
  const capture = CAPTURES.get('20260924');
  const ocr = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, capture.ocr), 'utf8'));
  assert.ok(ocr.words.some((w) => w.text === 'TURBG'), 'the label really is misread');

  const readings = await readFixture(capture);
  assert.ok(readings.TURBO, 'the TURBO portfolio is found');
  assert.ok(readings.TURBO.includes('ETHA'), `ETHA is read: ${JSON.stringify(readings.TURBO)}`);
  assert.ok(readings.TURBO.includes('MRNA'), `MRNA is read: ${JSON.stringify(readings.TURBO)}`);
});

test('the action line does not bleed into the holdings', async () => {
  // The 20260924 TURBO action line is read with a quote, not with '* ', so a
  // section that ends only at the next '* ' swallows it — and DELL and SMTC
  // come in as holdings.
  const readings = await readFixture(CAPTURES.get('20260924'));
  assert.ok(readings.TURBO, 'the TURBO portfolio is read');
  assert.ok(!readings.TURBO.includes('DELL'), `DELL is not a holding: ${JSON.stringify(readings.TURBO)}`);
  assert.ok(!readings.TURBO.includes('SMTC'), `SMTC is not a holding: ${JSON.stringify(readings.TURBO)}`);
  // Nor does the GRO action line bleed into the GRO holdings.
  assert.ok(!readings.GRO.includes('TRIMBE'), `the GRO action line is excluded: ${JSON.stringify(readings.GRO)}`);
});

test('a lost separator is split back into the tickers it holds', async () => {
  // "TQQNCLD" is TQQQ and NCLD with the comma lost, and "TGQQ," is TQQQ
  // with a Q read for a Q. Neither is a substring of the other, so an
  // exact-only partition cannot fire.
  const on24 = await readFixture(CAPTURES.get('20260924'));
  assert.ok(on24.GRO.includes('TQQQ'), `TQQQ is read: ${JSON.stringify(on24.GRO)}`);
  assert.ok(on24.GRO.includes('NCLD'), `NCLD is read: ${JSON.stringify(on24.GRO)}`);

  const on22 = await readFixture(CAPTURES.get('20260922'));
  assert.ok(on22.GRO.includes('TQQQ'), `TQQQ is read: ${JSON.stringify(on22.GRO)}`);
  assert.ok(on22.GRO.includes('NCLD'), `NCLD is read: ${JSON.stringify(on22.GRO)}`);
});

test('a separator read as a period is split back too', async () => {
  // "LITE.OOCN" is LITE and DOCN: the comma between them was read as a
  // period, and DOCN lost its D.
  const readings = await readFixture(CAPTURES.get('20260924'));
  assert.ok(readings.GRO.includes('LITE'), `LITE is read: ${JSON.stringify(readings.GRO)}`);
  assert.ok(readings.GRO.includes('DOCN'), `DOCN is read: ${JSON.stringify(readings.GRO)}`);
});

test('a chart annotation is not corrected into a holding', async () => {
  // The 20260922 frame draws the chart beside the holdings list, on the same
  // OCR lines. Its annotations are read as "wal”" and "by", each one edit
  // from a real ticker (HAL, BE). Correcting them invents holdings out of
  // the chart.
  const readings = await readFixture(CAPTURES.get('20260922'));
  assert.ok(!readings.GRO.includes('HAL'), `"wal”" is not corrected: ${JSON.stringify(readings.GRO)}`);
  assert.ok(!readings.GRO.includes('FANG'), 'no chart annotation is corrected');
  // The real holding BE is read, from the holdings list itself.
  assert.ok(readings.GRO.includes('BE'), `BE is read: ${JSON.stringify(readings.GRO)}`);
});

test('a token with two close candidates is dropped rather than guessed', async () => {
  // "IBT" is one edit from IBIT and from IOT; "SPO" is one edit from SPOT
  // and from SSO. The true instrument is known from the screen, but the
  // parser is not allowed to guess it: a wrong holding is worse than a
  // missing one.
  const readings = await readFixture(CAPTURES.get('20260924'));
  assert.ok(!readings.TURBO.includes('IBIT'), `IBIT is not guessed: ${JSON.stringify(readings.TURBO)}`);
  assert.ok(!readings.TURBO.includes('IOT'), `IOT is not guessed: ${JSON.stringify(readings.TURBO)}`);
  assert.ok(!readings.TURBO.includes('SPOT'), `SPOT is not guessed: ${JSON.stringify(readings.TURBO)}`);
  assert.ok(!readings.TURBO.includes('SSO'), `SSO is not guessed: ${JSON.stringify(readings.TURBO)}`);
});

test('a holding the allow-list did not know is reported, not dropped', async () => {
  // SPXL is on every TURBO screen, written as "UPRO/SPXL". It was in the
  // OBSERVED lexicon but not in the seed allow-list, so the resolver found it
  // exactly and the allow-list gate threw it away again — a holding the
  // parser could see and was forbidden to say.
  for (const date of ['20260922', '20260924', '20260928']) {
    const readings = await readFixture(CAPTURES.get(date));
    assert.ok(readings.TURBO.includes('SPXL'), `${date} SPXL is a TURBO holding: ${JSON.stringify(readings.TURBO)}`);
    // SPXL is a TURBO holding only — GRO never held it.
    assert.ok(!readings.GRO.includes('SPXL'), `${date} SPXL is not a GRO holding: ${JSON.stringify(readings.GRO)}`);
  }
});

test('the action line\'s own SPXL never contributes a second holding', async () => {
  // The 20260924 TURBO action line reads "ADD to SPXL". The section filter is
  // a SUBSTRING test, so an action-line token whose text also appears in the
  // holdings line passes it — the action line has to be excluded by position,
  // not by text.
  const readings = await readFixture(CAPTURES.get('20260924'));
  const turbo = readings.TURBO || [];
  assert.equal(turbo.filter((t) => t === 'SPXL').length, 1, `SPXL appears once: ${JSON.stringify(turbo)}`);
});

test('the whiteboard window is detected from the real pixels', async () => {
  // The geometry the holdings are bounded by comes from the pixels, so the
  // detector is part of what this test pins.
  const capture = CAPTURES.get('20260922');
  const bounds = await detectWhiteboardWindow(path.join(FIXTURE_DIR, capture.frame));
  assert.ok(bounds, 'a window is detected');
  assert.equal(bounds.windowLeft, 28);
  assert.ok(bounds.windowWidth >= 1200, `the window spans the panel: ${JSON.stringify(bounds)}`);
});
