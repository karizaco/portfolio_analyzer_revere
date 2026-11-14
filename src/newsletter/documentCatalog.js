'use strict';

/**
 * The inventory of a folder of newsletter PDFs.
 *
 * WHAT THIS IS FOR
 *
 * Every source in this project that has a catalog needs to answer the
 * same three questions before anything is extracted:
 *
 *   - what documents are there?
 *   - which of them are new, which have changed, and which have gone?
 *   - what is each one -- when it is about, when it was published, what
 *     kind of document it is?
 *
 * The O'Connell corpus needs it, and so would the next author's folder.
 * So the mechanics live here and the source-specific reading (the
 * masthead, the kinds) lives with the source.
 *
 * WHY THE FILENAME IS THE KEY
 *
 * The filename carries the SOURCE DATE -- the session the issue covers --
 * and that is the date the whole corpus is read by. It is NOT the publish
 * date: the newsletter goes out the morning after the session, so the
 * 20261112 issue was published on 2026-11-13 at 10:20. The two are kept
 * apart, because a reader asking "what did he hold on 12 November" is
 * asking about the session date.
 *
 * THE FILENAME GRAMMAR
 *
 *   20261112.pdf                  a document, no sequence, no slug
 *   20260303_2.pdf                a SECOND document on the same date
 *   20250101_2024_PNL_review.pdf  a document with a descriptive slug
 *   20240729_bestLoserWins.pdf    ditto
 *   20261112_positions.png        the position log beside the document
 *   20260318_positions_2.png      a second copy of the same day's log
 *
 * The sequence is a SINGLE digit, and that is deliberate: `20250101_2024_
 * PNL_review.pdf` must not have its slug read as the sequence "2" out of
 * "2024". Requiring the sequence to be one digit, with nothing but the
 * extension after it, keeps the two apart.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** A document's filename. */
const DOCUMENT_NAME = /^(\d{8})(?:_(\d))?(_.*)?\.pdf$/i;

/** A position-log screenshot's filename. */
const POSITIONS_NAME = /^(\d{8})_positions(?:_(\d+))?\.(png|webp|jpg|jpeg)$/i;

/**
 * The parts of a document's filename.
 *
 * @param {string} fileName
 * @returns {{sourceDate: string, sequence: string, slug: string, discriminator: string}|null}
 *   null when the name is not one of ours.
 */
function parseDocumentName(fileName) {
  const name = String(fileName || '');
  const match = DOCUMENT_NAME.exec(name);
  if (!match) return null;
  const sequence = match[2] || '';
  const slug = match[3] ? match[3].replace(/^_/, '') : '';
  return {
    discriminator: sequence || slug,
    sequence,
    slug,
    sourceDate: match[1],
  };
}

/**
 * The parts of a position-log screenshot's filename.
 *
 * @param {string} fileName
 * @returns {{sourceDate: string, copy: string}|null}
 */
function parsePositionsName(fileName) {
  const name = String(fileName || '');
  const match = POSITIONS_NAME.exec(name);
  if (!match) return null;
  return { copy: match[2] || '', sourceDate: match[1] };
}

/**
 * The md5 of a file's contents.
 *
 * @param {string} filePath
 * @returns {string}
 */
function checksumFile(filePath) {
  const hash = crypto.createHash('md5');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * The files in a folder, split into documents and position screenshots.
 *
 * The `_FINISHED` subfolder is SKIPPED, and so is every other directory:
 * this source reads the PDFs that sit directly in the folder, and a
 * subfolder of videos is a different artifact type entirely.
 *
 * @param {string} sourceDir
 * @returns {{documents: object[], positions: object[], skipped: string[]}}
 */
function listCorpus(sourceDir) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const documents = [];
  const positions = [];
  const skipped = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      skipped.push(entry.name);
      continue;
    }
    const document = parseDocumentName(entry.name);
    if (document) {
      documents.push({
        fileName: entry.name,
        ...document,
      });
      continue;
    }
    const position = parsePositionsName(entry.name);
    if (position) {
      positions.push({
        fileName: entry.name,
        ...position,
      });
      continue;
    }
    skipped.push(entry.name);
  }

  documents.sort((a, b) => (a.sourceDate === b.sourceDate
    ? a.fileName.localeCompare(b.fileName)
    : a.sourceDate.localeCompare(b.sourceDate)));
  positions.sort((a, b) => (a.sourceDate === b.sourceDate
    ? a.fileName.localeCompare(b.fileName)
    : a.sourceDate.localeCompare(b.sourceDate)));

  return { documents, positions, skipped };
}

/**
 * The position screenshot belonging to a date, if the folder has one.
 *
 * A date can have more than one copy (`_positions`, `_positions_2`). The
 * FIRST is the canonical one; the others are recorded but not read.
 *
 * @param {Array<object>} positions
 * @param {string} sourceDate
 * @returns {object|null}
 */
function positionsForDate(positions, sourceDate) {
  const forDate = positions.filter((entry) => entry.sourceDate === sourceDate);
  if (!forDate.length) return null;
  forDate.sort((a, b) => (a.copy === b.copy ? 0 : a.copy === '' ? -1 : b.copy === '' ? 1 : Number(a.copy) - Number(b.copy)));
  return forDate[0];
}

/**
 * The extra copies of a date's position screenshot.
 *
 * @param {Array<object>} positions
 * @param {string} sourceDate
 * @returns {object[]}
 */
function positionCopies(positions, sourceDate) {
  const forDate = positions.filter((entry) => entry.sourceDate === sourceDate);
  if (forDate.length < 2) return [];
  forDate.sort((a, b) => (a.copy === b.copy ? 0 : a.copy === '' ? -1 : b.copy === '' ? 1 : Number(a.copy) - Number(b.copy)));
  return forDate.slice(1);
}

module.exports = {
  DOCUMENT_NAME,
  POSITIONS_NAME,
  checksumFile,
  listCorpus,
  parseDocumentName,
  parsePositionsName,
  positionCopies,
  positionsForDate,
};
