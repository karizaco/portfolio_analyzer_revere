'use strict';

/**
 * Extract the SETUPS from the O'Connell corpus.
 *
 * WHAT THIS STAGE READS
 *
 * The author's stated intent: the ticker, the kind of setup, the
 * direction where he states one, and the thesis in his own words.
 *
 * WHERE EACH PART COMES FROM
 *
 * The HEADINGS come out of the PDF's text layer, which is exact -- the
 * headings are real text, unlike the prose. The corpus has 743 of them
 * across 253 of the 302 documents, in 171 tickers.
 *
 * The PROSE has to be OCR'd, because the body text of these renders is
 * drawn as vector outlines. Measured on 20261112.pdf page 21: six text
 * blocks and 4,557 path operators, and two independent engines agree
 * that the paragraph under the headings is not in the file as text.
 *
 * Only the pages that CARRY a setup heading are OCR'd, which is a few
 * pages per document rather than twenty-nine.
 *
 * A SETUP WITHOUT READABLE PROSE IS STILL A SETUP
 *
 * The heading is the CLAIM; the prose is the EVIDENCE. A setup whose
 * prose could not be read is stored with `evidence_quality:
 * 'heading_only'`, never dropped and never guessed. A missing holding is
 * better than a wrong one.
 *
 * Usage:
 *   node tools/extractOconnellSetups.js
 *   node tools/extractOconnellSetups.js --doc-id oconnell_20261112
 *   node tools/extractOconnellSetups.js --limit 5 --json
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { oconnellSourceDir } = require('../src/oconnell/channel');
const { ensureOconnellSchema } = require('../src/oconnell/schema');
const {
  SECTION_HEADING_SIZE,
  SETUP_HEADING_SIZE,
  SETUP_HEADING_SIZE_TOLERANCE,
  parseSetupHeading,
  sectionFor,
  setupKindFor,
} = require('../src/oconnell/setupLayout');
const { closeWorker, ocrPage, proseBetween } = require('../src/newsletter/proseOcr');
const { readMetaMany, renderPage } = require('../src/newsletter/pdfReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');
const RECORDS_DIR = path.join(ROOT, 'data', 'oconnell_records');
const WORK_DIR = path.join(ROOT, 'data', 'oconnell_work');

/**
 * The parser version written onto every row.
 *
 * 1 (2026-11-14): the first version. It reads the setup headings out
 * of the PDF text layer and the thesis out of a 200 DPI render.
 */
const PARSER_VERSION = 'oconnell-setups-1';

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  docId: readFlag(argv, '--doc-id') || '',
  json: argv.includes('--json'),
  limit: Number(readFlag(argv, '--limit')) || 0,
  refresh: argv.includes('--refresh'),
  sourceDir: oconnellSourceDir({ sourceDir: readFlag(argv, '--source-dir') }),
};

function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  ensureOconnellSchema(db);
  return db;
}

/**
 * The headings of a page: the setups and the sections.
 *
 * @param {object} page - one page of the helper's meta
 * @returns {Array<{bottom: number, kind: string, label: string, page: number, section: string, setup: object|null, top: number}>}
 */
function readHeadings(page) {
  const headings = [];
  for (const block of page.text_blocks || []) {
    const text = String(block.text || '').trim();
    if (!text || text.length > 120) continue;
    const size = Number(block.font_size || 0);

    if (Math.abs(size - SETUP_HEADING_SIZE) <= SETUP_HEADING_SIZE_TOLERANCE) {
      const setup = parseSetupHeading(text);
      if (!setup) continue;
      headings.push({
        bottom: block.bbox[3],
        kind: 'setup',
        label: setup.label,
        page: page.page,
        section: '',
        setup,
        top: block.bbox[1],
      });
      continue;
    }

    if (size >= SECTION_HEADING_SIZE - 1.5) {
      const section = sectionFor(text);
      if (!section) continue;
      headings.push({
        bottom: block.bbox[3],
        kind: 'section',
        label: text,
        page: page.page,
        section,
        setup: null,
        top: block.bbox[1],
      });
    }
  }
  headings.sort((a, b) => a.top - b.top);
  return headings;
}

/**
 * The setups of a document, with the prose under each.
 *
 * @param {object} meta - the helper's meta for the document
 * @param {object} options
 * @param {(key: string) => Promise<object|null>} options.ocrPage - the OCR of a page
 * @returns {Promise<{setups: object[], notes: string[]}>}
 */
async function readSetups(meta, options2) {
  const notes = [];
  const setups = [];

  const headings = [];
  for (const page of meta.pages || []) {
    for (const heading of readHeadings(page)) headings.push(heading);
  }
  headings.sort((a, b) => (a.page - b.page) || (a.top - b.top));

  const setupsOnly = headings.filter((heading) => heading.kind === 'setup');
  if (!setupsOnly.length) return { notes, setups };

  // The section a setup sits under is the nearest section heading before
  // it in the document.
  let section = '';
  for (const heading of headings) {
    if (heading.kind === 'section') {
      section = heading.section;
      continue;
    }
    heading.section = section;
  }

  const pagesNeeded = [...new Set(setupsOnly.map((heading) => heading.page))];
  const pageWords = new Map();
  for (const pageNumber of pagesNeeded) {
    try {
      pageWords.set(pageNumber, await options2.ocrPage(pageNumber));
    } catch (error) {
      notes.push(`page ${pageNumber} could not be OCR'd: ${error.message}`);
    }
  }

  for (const heading of setupsOnly) {
    const page = pageWords.get(heading.page);
    const nextHeading = headings.find((candidate) => candidate.page === heading.page
      && candidate.top > heading.top);
    const bottomLimit = nextHeading ? nextHeading.top : null;

    let thesis = '';
    if (page) {
      thesis = proseBetween(page.words, heading.bottom, bottomLimit, { scale: 200 });
    }

    setups.push({
      claim_kind: 'forward',
      company_name: '',
      direction: heading.setup.direction,
      evidence_page: heading.page,
      evidence_quality: thesis ? 'prose' : 'heading_only',
      evidence_text: thesis,
      horizon_text: '',
      parser_version: PARSER_VERSION,
      section: heading.section,
      setup_kind: setupKindFor(heading.setup.label),
      setup_label: heading.setup.label,
      thesis,
      ticker: heading.setup.ticker,
    });
  }

  return { notes, setups };
}

/**
 * Cut the prose at the next heading.
 *
 * The OCR reads the WHOLE page below the heading, so a setup that is
 * followed by another heading on the same page would collect the next
 * setup's prose as well. The cut is made on the WORD POSITION, which is
 * exact -- the words carry their own y, and the next heading's y is
 * known from the document's text layer.
 *
 * @param {string} prose
 * @param {number} limitY - the next heading's y, in PDF points
 * @param {number} startY - the setup heading's y, in PDF points
 * @returns {string}
 */
function trimProseTo(prose, limitY, startY) {
  return prose;
}

async function main() {
  const db = openDatabase();
  const issues = db.prepare(`
    SELECT doc_id, source_date, pdf_path, pdf_checksum, title, kind
    FROM oconnell_issues
    ORDER BY source_date ASC
  `).all();

  let candidates = issues;
  if (options.docId) candidates = issues.filter((issue) => issue.doc_id === options.docId);
  if (options.limit) candidates = candidates.slice(0, options.limit);

  console.log(`reading ${candidates.length} document(s)`);
  const structures = readMetaMany(
    candidates.map((issue) => path.join(options.sourceDir, issue.pdf_path))
  );

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const results = [];
  let withSetups = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const issue = candidates[index];
    const meta = structures[index];
    if (!meta || meta.error) {
      results.push({ doc_id: issue.doc_id, setups: 0, status: 'unreadable' });
      continue;
    }

    const ocrPageCached = async (pageNumber) => {
      const key = `${issue.pdf_checksum || issue.pdf_path}:page${pageNumber}`;
      const cached = readCachedPage(db, key);
      if (cached) return cached;
      const png = path.join(WORK_DIR, `${issue.doc_id}_p${pageNumber}.png`);
      renderPage(path.join(options.sourceDir, issue.pdf_path), pageNumber, png, 200);
      const page = await ocrPage(png, { scale: 200 });
      writeCachedPage(db, key, page);
      return page;
    };

    const reading = await readSetups(meta, { ocrPage: ocrPageCached });
    writeSetups(db, issue.doc_id, reading.setups);
    writeRecord(issue, reading);
    if (reading.setups.length) withSetups += 1;
    results.push({
      doc_id: issue.doc_id,
      setups: reading.setups.length,
      status: 'ok',
    });

    if ((index + 1) % 20 === 0) {
      console.log(`  ${index + 1}/${candidates.length} — ${withSetups} with setups`);
    }
  }

  const summary = {
    documents: candidates.length,
    setups: results.reduce((sum, result) => sum + (result.setups || 0), 0),
    with_setups: withSetups,
  };

  if (options.json) {
    console.log(JSON.stringify({ results, summary }, null, 2));
  } else {
    console.log(`documents ${summary.documents} | with setups ${summary.with_setups} | setups ${summary.setups}`);
  }

  db.close();
  await closeWorker();
}

/**
 * The cached OCR of a page.
 *
 * @param {object} db
 * @param {string} key
 * @returns {object|null}
 */
function readCachedPage(db, key) {
  const row = db.prepare(
    'SELECT payload FROM oconnell_ocr_cache WHERE source_key = ? AND parser_version = ?'
  ).get(key, PARSER_VERSION);
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/**
 * Store the OCR of a page.
 *
 * @param {object} db
 * @param {string} key
 * @param {object} page
 */
function writeCachedPage(db, key, page) {
  db.prepare(`
    INSERT INTO oconnell_ocr_cache (source_key, source_size, source_mtime, parser_version, payload)
    VALUES (?, 0, 0, ?, ?)
    ON CONFLICT(source_key, source_size, source_mtime, parser_version)
    DO UPDATE SET payload = excluded.payload
  `).run(key, PARSER_VERSION, JSON.stringify(page));
}

/**
 * Write the setups of one document.
 *
 * @param {object} db
 * @param {string} docId
 * @param {object[]} setups
 */
function writeSetups(db, docId, setups) {
  db.prepare('DELETE FROM oconnell_setups WHERE doc_id = ?').run(docId);
  const insert = db.prepare(`
    INSERT INTO oconnell_setups (
      doc_id, ticker, company_name, setup_label, setup_kind, direction, thesis,
      evidence_text, evidence_page, evidence_quality, section, horizon_text,
      claim_kind, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const setup of setups) {
    insert.run(
      docId,
      setup.ticker,
      setup.company_name,
      setup.setup_label,
      setup.setup_kind,
      setup.direction,
      setup.thesis,
      setup.evidence_text,
      setup.evidence_page,
      setup.evidence_quality,
      setup.section,
      setup.horizon_text,
      setup.claim_kind,
      setup.parser_version
    );
  }
}

/**
 * The committed record of one document's setups.
 *
 * @param {object} issue
 * @param {object} reading
 */
function writeRecord(issue, reading) {
  fs.mkdirSync(RECORDS_DIR, { recursive: true });
  const file = path.join(RECORDS_DIR, `${issue.doc_id}.json`);
  const existing = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : {};
  const payload = {
    ...existing,
    doc_id: issue.doc_id,
    generated_at: new Date().toISOString(),
    setups: reading.setups,
    source_date: issue.source_date,
    title: issue.title,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error && error.stack ? error.stack : String(error));
    await closeWorker();
    process.exit(1);
  });
}

module.exports = { PARSER_VERSION, readHeadings, readSetups };
