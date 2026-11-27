'use strict';

// plechac's portfolio TREEMAP, read out of a broker screenshot.
//
// The rules here were measured against the pixels of the 2026-04-15
// screenshot, and the fixture is a FROZEN copy of its OCR -- the media
// directory is gitignored and Discord's attachment URLs expire, so the
// frozen words are the only copy that can be tested against.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  readHeatmap, percentValue, sectorsOf, signFromColour,
} = require('../src/discord/plechac/heatmapReader');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'plechac_heatmap');

function fixture() {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(FIXTURE_DIR, manifest.words_file), 'utf8');
  const payload = raw.replace(/\n$/, '');
  // The fixture's own md5: a changed OCR must fail here rather than
  // silently moving the numbers.
  assert.equal(
    crypto.createHash('md5').update(payload).digest('hex'),
    manifest.words_md5,
    'the frozen OCR has changed',
  );
  return JSON.parse(payload);
}

test('the frozen OCR is the one the fixture claims', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  assert.equal(manifest.words, 233);
  assert.equal(manifest.image_size, '2133x1128');
});

test('the percentage is the DAILY CHANGE and not the weight', () => {
  const read = readHeatmap(fixture());
  // A WEIGHT CAN NEVER BE NEGATIVE, and three leaves carry a negative
  // percentage. So the percentage is a change and not a size.
  const negative = read.holdings.filter((holding) => holding.change_pct < 0);
  assert.ok(negative.length >= 3, 'the screenshot carries negative percentages');
  assert.ok(negative.some((holding) => holding.broker_ticker === 'MC.PA'));

  // And the screenshot's own header says "96 pozic", so the reader is
  // told how many there are.
  assert.equal(read.coverage.stated_positions, 96);
});

test('the sectors are read, with their own aggregate change', () => {
  const read = readHeatmap(fixture());
  const names = read.sectors.map((sector) => sector.name);
  assert.ok(names.includes('Technologie'));
  assert.ok(names.includes('Financni sluzby'));
  assert.ok(names.includes('Komunikacni sluzby'));
  const technologie = read.sectors.find((sector) => sector.name === 'Technologie');
  assert.equal(technologie.change_pct, 1.04);
});

test('the holdings are read, and the count is published', () => {
  const read = readHeatmap(fixture());
  // 65 of the screenshot's 96 leaves are read; the rest are tiles whose
  // text the OCR missed.
  assert.equal(read.coverage.holdings_read, 65);
  const byTicker = new Map(read.holdings.map((holding) => [holding.broker_ticker, holding]));
  // AMZN's tile reads "-0.12 %" on the screenshot, and the sign is the
  // broker's own minus glyph.
  assert.equal(byTicker.get('AMZN').change_pct, -0.12);
  assert.equal(byTicker.get('AMZN').ticker, 'AMZN');
  // The broker's own exchange suffix is translated to the market's.
  assert.equal(byTicker.get('IDUS.LSE').ticker, 'IDUS.L');
  assert.equal(byTicker.get('ASML.AS').ticker, 'ASML');
  assert.equal(byTicker.get('3CP.F').ticker, '1810.HK');
});

test('the sector of a leaf is the group above it', () => {
  const read = readHeatmap(fixture());
  const byTicker = new Map(read.holdings.map((holding) => [holding.broker_ticker, holding]));
  // These are the ones the pixels settle: the treemap's groups are
  // rectangles and the label is at the top-left of its own.
  assert.equal(byTicker.get('AMZN').sector, 'Spotirebni zbozi (cyklicke)');
  assert.equal(byTicker.get('PYPL').sector, 'Financni sluzby');
  assert.equal(byTicker.get('LEU').sector, 'Energetika');
  assert.equal(byTicker.get('MSFT').sector, 'Technologie');
});

test('the SIGN comes from the leaf\'s colour, not from the glyph', () => {
  // The broker's minus dash is lost by the OCR, so the sign is read from
  // the tile's background. The screenshot's own tiles measure:
  //
  //   green   rgb(26, 65, 45)
  //   red     rgb(75, 31, 32)
  //   flat    rgb(45, 51, 59)
  //
  // The pixels are synthetic here, because the screenshot itself is a
  // local artifact -- the media directory is gitignored and Discord's
  // attachment URLs expire -- and the reader's LOGIC is what this pins.
  const WIDTH = 40;
  const HEIGHT = 20;
  const info = { width: WIDTH, height: HEIGHT, channels: 3 };
  const leaf = {
    change_box: { left: 10, top: 5, width: 10, height: 5 },
  };

  const bufferOf = (rgb) => {
    const data = Buffer.alloc(WIDTH * HEIGHT * 3);
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
      data[i * 3] = rgb[0];
      data[i * 3 + 1] = rgb[1];
      data[i * 3 + 2] = rgb[2];
    }
    return data;
  };

  const green = signFromColour(leaf, bufferOf([26, 65, 45]), info, 1, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(green.sign, 1);
  assert.equal(green.source, 'colour');

  const red = signFromColour(leaf, bufferOf([75, 31, 32]), info, 1, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(red.sign, -1);
  assert.equal(red.source, 'colour');

  // A FLAT tile is not a witness: the leaves whose change is a fraction
  // of a point are drawn flat, and their sign has to come from the
  // glyph.
  const flat = signFromColour(leaf, bufferOf([45, 51, 59]), info, 1, { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(flat.sign, 0);
  assert.equal(flat.source, 'flat');
});

test('a percentage is read with the broker\'s lost minus sign', () => {
  // The broker draws a negative with a glyph the OCR reads as a tilde,
  // and a tilde is a minus here.
  assert.equal(percentValue('~0.29%'), -0.29);
  assert.equal(percentValue('-0.12%'), -0.12);
  assert.equal(percentValue('+1.50%'), 1.5);
  assert.equal(percentValue('4.22%'), 4.22);
  assert.equal(percentValue('not a percentage'), null);
});

test('a sector label is a NAME and not a ticker', () => {
  // The discriminator: a sector label has a lowercase letter in it and
  // its percentage is BESIDE it, while a leaf's percentage is BELOW its
  // ticker.
  const sectors = sectorsOf(fixture().words);
  assert.ok(sectors.length >= 7);
  assert.ok(sectors.every((sector) => /[a-z]/.test(sector.name)));
});
