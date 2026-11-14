'use strict';

// The O'Connell source's identity and its catalog ids.
//
// The id is the SOURCE DATE the document is about -- the date in its
// FILENAME -- and not the date it was published. The two are different:
// the 20261112 issue was published on 2026-11-13 at 10:20, because the
// newsletter goes out the morning after the session it covers.
//
// The rule that needs pinning is the DISCRIMINATOR. The corpus holds
// both `20260407.pdf` and `20260407_grand_finale.pdf`, and both are
// about 2026-04-07. A date-only id would silently overwrite one of them
// with the other, and the corpus would report 300 documents where the
// folder holds 302.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isOconnellSourceUrl,
  oconnellDocId,
  oconnellSourceDir,
  parseOconnellDocId,
} = require('../src/oconnell/channel');
const {
  parseDocumentName,
  parsePositionsName,
} = require('../src/newsletter/documentCatalog');

test('the catalog id is the source date, not the publish date', () => {
  assert.equal(oconnellDocId('20261112'), 'oconnell_20261112');
  assert.equal(oconnellDocId('20261112', ''), 'oconnell_20261112');
});

test('a source date that is not a date is refused', () => {
  assert.throws(() => oconnellDocId('2026-11-12'), /must be YYYYMMDD/);
  assert.throws(() => oconnellDocId(''), /must be YYYYMMDD/);
});

test('two documents for one date get two ids', () => {
  // The pair that collapsed into one id before the discriminator was
  // part of the scheme.
  assert.equal(oconnellDocId('20260407'), 'oconnell_20260407');
  assert.equal(
    oconnellDocId('20260407', 'grand_finale'),
    'oconnell_20260407_grand_finale'
  );
  assert.notEqual(oconnellDocId('20260407'), oconnellDocId('20260407', 'grand_finale'));
});

test('a catalog id round-trips through its parser', () => {
  assert.deepEqual(parseOconnellDocId('oconnell_20261112'), {
    discriminator: '',
    sourceDate: '20261112',
  });
  assert.deepEqual(parseOconnellDocId('oconnell_20260407_grand_finale'), {
    discriminator: 'grand_finale',
    sourceDate: '20260407',
  });
  assert.equal(parseOconnellDocId('asym_222466781'), null);
  assert.equal(parseOconnellDocId('not-an-id'), null);
});

test('a document filename gives its date and its discriminator', () => {
  assert.deepEqual(parseDocumentName('20261112.pdf'), {
    discriminator: '',
    sequence: '',
    slug: '',
    sourceDate: '20261112',
  });
  assert.deepEqual(parseDocumentName('20260303_2.pdf'), {
    discriminator: '2',
    sequence: '2',
    slug: '',
    sourceDate: '20260303',
  });
});

test('a slug is not read as a sequence', () => {
  // "2024" is a number, but it is not the sequence of a second document
  // on that date -- it is the start of a slug.
  const parsed = parseDocumentName('20250101_2024_PNL_review.pdf');
  assert.equal(parsed.sourceDate, '20250101');
  assert.equal(parsed.sequence, '');
  assert.equal(parsed.slug, '2024_PNL_review');
  assert.equal(parsed.discriminator, '2024_PNL_review');
});

test('a name that is not one of ours is refused', () => {
  assert.equal(parseDocumentName('positions.png'), null);
  assert.equal(parseDocumentName('README.txt'), null);
});

test('a position screenshot filename gives its date', () => {
  assert.deepEqual(parsePositionsName('20261112_positions.png'), {
    copy: '',
    sourceDate: '20261112',
  });
  assert.deepEqual(parsePositionsName('20260318_positions_2.webp'), {
    copy: '2',
    sourceDate: '20260318',
  });
  assert.equal(parsePositionsName('20261112.png'), null);
});

test("the publication's hosts are recognised", () => {
  assert.ok(isOconnellSourceUrl('https://www.pristinecapital.net/p/nvda-earnings'));
  assert.ok(isOconnellSourceUrl('https://pristinecapital.substack.com/p/2024-pnl-review'));
  assert.ok(!isOconnellSourceUrl('https://www.youtube.com/@Qullamaggie'));
});

test('the corpus folder is configurable', () => {
  assert.equal(oconnellSourceDir({ sourceDir: 'D:\\elsewhere' }), 'D:\\elsewhere');
  const fromEnv = process.env.OCONNELL_SOURCE_DIR;
  if (fromEnv) assert.equal(oconnellSourceDir(), fromEnv);
});
