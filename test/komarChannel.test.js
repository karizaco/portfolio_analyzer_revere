'use strict';

// The Komar source's identity and its catalog ids.
//
// The rule that needs pinning is the NAMESPACE. This corpus has no
// video ids at all -- the files are local MP4s on a disk -- so its ids
// are built from what the files ARE: the kind and the key. If a document
// id and a video id could ever land on the same string, one would
// overwrite the other and the catalog would quietly lose a row.
//
// The second rule is the KIND in the id. The corpus holds a rule
// document ("core_strategy_v2.pdf") and a deck
// ("Trades-August-2025.pdf") whose names say nothing about what they
// are; the id has to carry the kind, because the kind is what decides
// how the document is read.
//
// The third is the FILENAME LIE. `komar_20260408.pdf` is named
// 2026-04-08 and its own title AND its own URL say 2025-04-08. The
// catalog prefers the document's own date and records the disagreement;
// a date resolver that trusted the filename would silently mis-date the
// document and everything linked to it.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DOCUMENT_KINDS,
  KOMAR_ARCHIVE_DIR,
  KOMAR_SOURCE,
  isKomarSourceUrl,
  komarDocId,
  komarSlug,
  komarSourceDir,
  komarVideoId,
  parseKomarId,
} = require('../src/komar/channel');

test('a document id carries its kind', () => {
  assert.equal(komarDocId('report', '20260509'), 'komar_doc_report_20260509');
  assert.equal(komarDocId('summary', '20250816'), 'komar_doc_summary_20250816');
  assert.equal(komarDocId('deck', 'trades_august_2025'), 'komar_doc_deck_trades_august_2025');
  assert.equal(komarDocId('rule', 'core_strategy_v2'), 'komar_doc_rule_core_strategy_v2');
});

test('a video id carries its kind', () => {
  assert.equal(komarVideoId('weekend', '226_stocks_analysis'), 'komar_vid_weekend_226_stocks_analysis');
  assert.equal(komarVideoId('lesson', 'position-sizing'), 'komar_vid_lesson_position-sizing');
  assert.equal(komarVideoId('midweek', '20260415'), 'komar_vid_midweek_20260415');
});

test('a document id and a video id can never be the same string', () => {
  // The same key under both entities.
  const doc = komarDocId('report', '20260509');
  const video = komarVideoId('lesson', '20260509');
  assert.notEqual(doc, video);
  assert.ok(doc.startsWith('komar_doc_'));
  assert.ok(video.startsWith('komar_vid_'));
});

test('an unknown kind is refused rather than guessed', () => {
  assert.throws(() => komarDocId('podcast', '20260509'), /Unknown Komar document kind/);
  assert.throws(() => komarVideoId('podcast', 'x'), /Unknown Komar video kind/);
});

test('an id with no key is refused', () => {
  assert.throws(() => komarDocId('report', ''), /needs a key/);
  assert.throws(() => komarVideoId('weekend', '   '), /needs a key/);
});

test('a catalog id round-trips through its parser', () => {
  assert.deepEqual(parseKomarId('komar_doc_report_20260509'), {
    entity: 'doc',
    key: '20260509',
    kind: 'report',
  });
  assert.deepEqual(parseKomarId('komar_vid_weekend_226_stocks_analysis'), {
    entity: 'vid',
    key: '226_stocks_analysis',
    kind: 'weekend',
  });
  assert.equal(parseKomarId('oconnell_20261112'), null);
  assert.equal(parseKomarId('asym_222466781'), null);
  assert.equal(parseKomarId('komar_nonsense'), null);
  assert.equal(parseKomarId('not-an-id'), null);
});

test('a slug keeps an underscore and loses everything else', () => {
  // The underscore is the separator between a report number and a part,
  // so it has to survive: `226_stocks_analysis` and `226-stocks-analysis`
  // are two different ids and only one of them is in the manifest.
  assert.equal(komarSlug('226_stocks_analysis'), '226_stocks_analysis');
  assert.equal(komarSlug('core_strategy_v2'), 'core_strategy_v2');
  assert.equal(komarSlug('My 4 Biggest Losses'), 'my-4-biggest-losses');
  assert.equal(komarSlug('  --leading and trailing--  '), 'leading-and-trailing');
  assert.equal(komarSlug('Trades-August-2025'), 'trades-august-2025');
});

test('the corpus folder is configurable and the default is the measured one', () => {
  assert.equal(komarSourceDir({ sourceDir: 'D:\\somewhere\\else' }), 'D:\\somewhere\\else');
  assert.match(komarSourceDir(), /julian_komar/);
});

test('the source name is namespaced and the host is recognised', () => {
  assert.equal(KOMAR_SOURCE, 'komar');
  assert.ok(isKomarSourceUrl('https://members.julian-komar.com/c/weekly-videos/may-9-2026-weeke...'));
  assert.equal(isKomarSourceUrl('https://members.julian-komar.com.evil.example/x'), false);
  assert.equal(isKomarSourceUrl(''), false);
});

test('the document kinds are the ones the catalog writes', () => {
  for (const kind of ['report', 'post', 'rule', 'lesson', 'summary', 'deck']) {
    assert.ok(DOCUMENT_KINDS.includes(kind), `${kind} is a document kind`);
  }
});

// ---------------------------------------------------------------------------
// The environment, the archive folder, and the URL test's edges.
// ---------------------------------------------------------------------------

test('the corpus folder comes from the environment when it is set', () => {
  const previous = process.env.KOMAR_SOURCE_DIR;
  process.env.KOMAR_SOURCE_DIR = 'D:\\elsewhere\\komar';
  try {
    assert.equal(komarSourceDir(), 'D:\\elsewhere\\komar');
    // An explicit option still wins over the environment.
    assert.equal(komarSourceDir({ sourceDir: 'D:\\explicit' }), 'D:\\explicit');
  } finally {
    if (previous === undefined) delete process.env.KOMAR_SOURCE_DIR;
    else process.env.KOMAR_SOURCE_DIR = previous;
  }
});

test('the archive folder is named, not guessed', () => {
  // The walker reads every sub-folder of the corpus root, and the name
  // is what the catalog stores on the row -- so it is a constant, not
  // something derived at runtime.
  assert.equal(KOMAR_ARCHIVE_DIR, '_finished');
});

test('the URL test survives a truncated print', () => {
  // The browser truncates the URL in the print, but not in the middle
  // of the host -- so a truncated URL is still recognisable.
  assert.equal(
    isKomarSourceUrl('https://members.julian-komar.com/c/weekly-videos/may-9-2026-weeke...'),
    true
  );
  // A bare host with no scheme is what a hand-typed value looks like.
  assert.equal(isKomarSourceUrl('members.julian-komar.com/c/x'), true);
  // And a value that is not a URL at all is not the site.
  assert.equal(isKomarSourceUrl('not a url'), false);
  assert.equal(isKomarSourceUrl('https://julian-komar.com/c/x'), false);
});

test('a slug never carries a path separator or a space', () => {
  assert.equal(komarSlug('a/b\\c'), 'a-b-c');
  assert.equal(komarSlug('   '), '');
  assert.equal(komarSlug('..'), '');
  assert.equal(komarSlug('Ünïcode'), 'n-code');
});

