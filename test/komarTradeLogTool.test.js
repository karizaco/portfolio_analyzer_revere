'use strict';

// The Phase-3 Komar trade-log runner's write path.
//
// These tests pin the write contract:
// - this document's rows are REPLACED in one transaction
// - the parser version travels on every row
// - the reading check and the derived fields are stored, so a doubtful
//   row can be told from a clean one by a reader
// - the document selection only looks at decks

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');
const { ensureKomarSchema } = require('../src/komar/schema');
const { PARSER_VERSION } = require('../src/komar/tradeLogLayout');
const {
  listDocuments,
  writeRecord,
  writeTradeLogRows,
} = require('../tools/extractKomarTradeLog');

function isolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-tradelog-'));
  const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
  const derivedPath = path.join(dir, 'derived.sqlite');
  ensureDerivedSchema(derivedPath);
  db.prepare('ATTACH DATABASE ? AS derived').run(derivedPath);
  ensureKomarSchema(db, { derivedPath });
  return {
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
    db,
    dir,
  };
}

const ROW = {
  after_close_rating: 5,
  avg_close_price: 9.91,
  avg_open_price: 7.18,
  comment: 'Selling it on the EMA 8 would be the better strategy in hindsight.',
  confidence: 0.95,
  date_closed: '20250729',
  date_opened: '20250708',
  derived_fields: '',
  entry_type: 'Breakout short-term',
  exit_type: 'Break-even',
  initial_rating: 4.5,
  mmts_close: 'Green',
  mmts_opening: 'Green',
  page: 2,
  parser_version: PARSER_VERSION,
  reading_check: '',
  review: 'B-trade',
  risk_capital_pct: 0.56,
  row_index: 0,
  stop_loss_pct: 6,
  stop_loss_price: 6.7,
  ticker: 'QS',
  wl_pct: 38.02,
  wl_r: 5.64,
};

test('listDocuments only looks at decks', () => {
  const ctx = isolatedDb();
  try {
    const ins = ctx.db.prepare(`
      INSERT INTO komar_documents (
        doc_id, kind, title, series, session_date, session_date_precision,
        session_date_source, filename_date, date_conflict, report_number,
        page_count, source_url, print_stamp, chapters_json, pdf_path, pdf_bytes,
        pdf_checksum, provenance, folder, catalog_version, created_at, updated_at
      ) VALUES (?, ?, '', '', '', '', '', '', 0, '', 0, '', '', '[]', '', 0, '', 'primary', '', '', datetime('now'), datetime('now'))
    `);
    ins.run('komar_doc_deck_trades-august-2025', 'deck');
    ins.run('komar_doc_report_20260509', 'report');
    ins.run('komar_doc_post_20260415', 'post');

    const docs = listDocuments(ctx.db);
    assert.deepEqual(docs.map((doc) => doc.doc_id), ['komar_doc_deck_trades-august-2025']);
  } finally {
    ctx.cleanup();
  }
});

test('writeTradeLogRows replaces this document\'s rows', () => {
  const ctx = isolatedDb();
  try {
    const doc = { doc_id: 'komar_doc_deck_trades-august-2025' };
    writeTradeLogRows(ctx.db, doc, [ROW]);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_trade_log').get().c, 1);

    writeTradeLogRows(ctx.db, doc, [
      { ...ROW, comment: 'Re-read.', confidence: 0.5, row_index: 0 },
    ]);

    // Still exactly one row, with the updated values.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_trade_log').get().c, 1);
    const row = ctx.db.prepare('SELECT comment, confidence, ticker FROM komar_trade_log').get();
    assert.equal(row.comment, 'Re-read.');
    assert.equal(row.confidence, 0.5);
    assert.equal(row.ticker, 'QS');
  } finally {
    ctx.cleanup();
  }
});

test('a row carries its parser version, its check and its derived fields', () => {
  const ctx = isolatedDb();
  try {
    const doc = { doc_id: 'komar_doc_deck_trades-august-2025' };
    writeTradeLogRows(ctx.db, doc, [
      { ...ROW, row_index: 0 },
      {
        ...ROW,
        derived_fields: 'wl_pct',
        reading_check: 'W/L 1.67% disagrees with the prices (1.63%)',
        row_index: 1,
        ticker: 'GOGO',
      },
    ]);
    const rows = ctx.db.prepare('SELECT ticker, reading_check, derived_fields, parser_version FROM komar_trade_log ORDER BY row_index').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].reading_check, '');
    assert.equal(rows[0].derived_fields, '');
    assert.equal(rows[1].reading_check, 'W/L 1.67% disagrees with the prices (1.63%)');
    assert.equal(rows[1].derived_fields, 'wl_pct');
    for (const row of rows) assert.equal(row.parser_version, PARSER_VERSION);
  } finally {
    ctx.cleanup();
  }
});

test('writeRecord writes a stable JSON sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-tradelog-record-'));
  try {
    const doc = {
      doc_id: 'komar_doc_deck_trades-august-2025',
      kind: 'deck',
      pdf_checksum: 'abc',
      pdf_path: 'Trades-August-2025.pdf',
      session_date: '20250701',
      title: 'July 2025 Trades',
    };

    const oldCwd = process.cwd();
    process.chdir(path.join(__dirname, '..'));
    const recordsDir = path.join('data', 'komar_records');
    const backup = path.join('data', 'komar_records.__bak_test__');
    if (fs.existsSync(recordsDir)) fs.renameSync(recordsDir, backup);
    fs.mkdirSync(recordsDir, { recursive: true });
    try {
      writeRecord(doc, [ROW], ['a note']);
      const outPath = path.join(recordsDir, `${doc.doc_id}_tradelog.json`);
      assert.ok(fs.existsSync(outPath));
      const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.equal(out.doc_id, doc.doc_id);
      assert.equal(out.kind, 'deck');
      assert.equal(out.pdf_checksum, 'abc');
      assert.equal(out.rows.length, 1);
      assert.equal(out.rows[0].ticker, 'QS');
      assert.deepEqual(out.notes, ['a note']);
      assert.ok(out.generated_at);
    } finally {
      fs.rmSync(recordsDir, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, recordsDir);
      process.chdir(oldCwd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
