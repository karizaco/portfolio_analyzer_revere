'use strict';

// The Phase-2 Komar document runner's write path.
//
// These tests pin the write contract:
// - this document's rows are REPLACED in one transaction
// - JSON sidecars are emitted under data/komar_records
// - the document selection only includes report/post/deck rows

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { attachDerived, ensureDerivedSchema } = require('../src/db/derivedStore');
const { ensureKomarSchema } = require('../src/komar/schema');
const {
  listDocuments,
  writeDocumentRows,
  writeRecord,
} = require('../tools/extractKomarDocuments');

function isolatedDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-docs-'));
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

test('listDocuments selects only report/post/deck/summary rows', () => {
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
    ins.run('komar_doc_report_20260509', 'report');
    ins.run('komar_doc_post_20260415', 'post');
    ins.run('komar_doc_deck_trades-august-2025', 'deck');
    ins.run('komar_doc_rule_core_strategy_v2', 'rule');
    ins.run('komar_doc_summary_20250816', 'summary');

    const docs = listDocuments(ctx.db);
    assert.deepEqual(docs.map((d) => d.doc_id).sort(), [
      'komar_doc_deck_trades-august-2025',
      'komar_doc_post_20260415',
      'komar_doc_report_20260509',
      'komar_doc_summary_20250816',
    ]);
  } finally {
    ctx.cleanup();
  }
});

test('writeDocumentRows replaces this document\'s rows', () => {
  const ctx = isolatedDb();
  try {
    const doc = { doc_id: 'komar_doc_report_20260509' };
    const first = {
      cards: [
        {
          confidence: 0.7,
          doc_id: doc.doc_id,
          exposure_pct: 50,
          image_height: 764,
          image_width: 1080,
          image_xref: 19,
          market_text: 'Money Maker Market',
          market_trend_nasdaq: '',
          market_trend_russell2000: '',
          market_trend_sp500: '',
          page: 2,
          parser_version: 'komar-docs-2',
          trend_nasdaq_dir: 'up',
          trend_russell2000_dir: 'up',
          trend_sp500_dir: 'down',
        },
      ],
      leaders: [
        {
          confidence: 0.6,
          doc_id: doc.doc_id,
          image_xref: 19,
          leader_index: 1,
          page: 2,
          parser_version: 'komar-docs-2',
          theme: 'Semis',
          ticker: 'SNDK',
        },
      ],
      notes: [],
    };
    writeDocumentRows(ctx.db, doc, first);

    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_market_cards').get().c, 1);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_theme_leaders').get().c, 1);

    const second = {
      cards: [
        {
          ...first.cards[0],
          confidence: 0.9,
          exposure_pct: 75,
          market_text: 'Updated text',
          trend_sp500_dir: 'up',
        },
      ],
      leaders: [
        { ...first.leaders[0], ticker: 'MU' },
      ],
      notes: [],
    };
    writeDocumentRows(ctx.db, doc, second);

    // Still exactly one row per table for this doc, with the updated values.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_market_cards').get().c, 1);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM komar_theme_leaders').get().c, 1);
    const card = ctx.db.prepare('SELECT exposure_pct, confidence, market_text, trend_sp500_dir FROM komar_market_cards').get();
    assert.equal(card.exposure_pct, 75);
    assert.equal(card.confidence, 0.9);
    assert.equal(card.market_text, 'Updated text');
    assert.equal(card.trend_sp500_dir, 'up');
    const leader = ctx.db.prepare('SELECT ticker FROM komar_theme_leaders').get();
    assert.equal(leader.ticker, 'MU');
  } finally {
    ctx.cleanup();
  }
});

test('writeDocumentRows writes the summary readings, and replaces them', () => {
  const ctx = isolatedDb();
  try {
    const doc = { doc_id: 'komar_doc_summary_20250824' };
    const first = {
      cards: [],
      leaders: [],
      notes: [],
      summaries: [
        {
          doc_id: doc.doc_id,
          kind: 'holding',
          name: '',
          page: 1,
          parser_version: 'komar-docs-2',
          raw_subject: 'IBMNR',
          reading_index: 2,
          section: 'Stocks Holding Up / Under Watch',
          stance: '',
          subject: 'BMNR',
          text: 'Showing relative strength, needs consolidation.',
          verdict: '',
        },
      ],
    };
    writeDocumentRows(ctx.db, doc, first);
    let rows = ctx.db.prepare('SELECT * FROM komar_summary_readings').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'BMNR');
    assert.equal(rows[0].raw_subject, 'IBMNR');

    // A re-read replaces the document's readings rather than adding to
    // them.
    writeDocumentRows(ctx.db, doc, {
      ...first,
      summaries: [{ ...first.summaries[0], reading_index: 0, subject: 'DFDV' }],
    });
    rows = ctx.db.prepare('SELECT * FROM komar_summary_readings').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subject, 'DFDV');
  } finally {
    ctx.cleanup();
  }
});

test('writeDocumentRows writes deck notes too', () => {
  const ctx = isolatedDb();
  try {
    const doc = { doc_id: 'komar_doc_deck_trades-august-2025' };
    writeDocumentRows(ctx.db, doc, {
      cards: [],
      leaders: [],
      notes: [
        {
          body_text: '4.5 stars ...',
          doc_id: doc.doc_id,
          heading: '4.5 stars. Really tight.',
          page: 3,
          parser_version: 'komar-docs-2',
          quick_checklist: [{ checked: true, item: 'Explosive look' }],
          stars: 4.5,
          trade_grade: 'B',
          trade_state: 'Open',
        },
      ],
    });
    const row = ctx.db.prepare('SELECT stars, trade_grade, trade_state, quick_checklist_json FROM komar_deck_notes').get();
    assert.equal(row.stars, 4.5);
    assert.equal(row.trade_grade, 'B');
    assert.equal(row.trade_state, 'Open');
    assert.deepEqual(JSON.parse(row.quick_checklist_json), [{ checked: true, item: 'Explosive look' }]);
  } finally {
    ctx.cleanup();
  }
});

test('writeRecord writes a stable JSON sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'komar-record-'));
  try {
    const payload = {
      cards: [{ doc_id: 'komar_doc_report_20260509', page: 2, image_xref: 19 }],
      leaders: [{ doc_id: 'komar_doc_report_20260509', ticker: 'SNDK' }],
      notes: [],
    };
    const doc = {
      doc_id: 'komar_doc_report_20260509',
      kind: 'report',
      pdf_checksum: 'abc',
      pdf_path: 'komar_20260509.pdf',
      session_date: '20260509',
      title: 'May 9, 2026 - Weekend-Report #226',
    };

    // Reuse the helper's own JSON contract, but in a temporary folder.
    const oldCwd = process.cwd();
    process.chdir(path.join(__dirname, '..'));
    const recordsDir = path.join('data', 'komar_records');
    const backup = path.join('data', 'komar_records.__bak_test__');
    if (fs.existsSync(recordsDir)) fs.renameSync(recordsDir, backup);
    fs.mkdirSync(recordsDir, { recursive: true });
    try {
      writeRecord(doc, payload);
      const outPath = path.join(recordsDir, `${doc.doc_id}.json`);
      assert.ok(fs.existsSync(outPath));
      const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      assert.equal(out.doc_id, doc.doc_id);
      assert.equal(out.kind, 'report');
      assert.equal(out.pdf_checksum, 'abc');
      assert.equal(Array.isArray(out.cards), true);
      assert.equal(Array.isArray(out.leaders), true);
      assert.equal(Array.isArray(out.notes), true);
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
