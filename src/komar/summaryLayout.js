'use strict';

/**
 * The Komar WEEKEND-REPORT SUMMARY: what the author wrote about each
 * ticker.
 *
 * WHAT THESE DOCUMENTS ARE
 *
 * Two one-page PDFs that are MACHINE-WRITTEN summaries of a video --
 * a derived artifact, and the plan is explicit that they must be
 * labelled as one and never merged with the primary record. What they
 * carry that nothing else in the corpus does is a dated, curated,
 * per-ticker WATCHLIST with the author's VERDICT on each name.
 *
 *   20250816_Julian_Komar_Weekend_Report_Summary_NoTable.pdf
 *   _finished/Weekend_Report_Summary_Corrected.pdf
 *
 * They are TEXT-NATIVE (a ReportLab PDF, 2,839 and 2,228 characters),
 * so no OCR is involved.
 *
 * THE TWO FILES ARE IN DIFFERENT FORMATS, and the difference is the
 * whole difficulty
 *
 * The 16 August file prints each holding as
 *
 *   VFF (Village Farms) -- Leading cannabis stock, improved liquidity,
 *   character change after spinoff. [square] Needs more consolidation.
 *
 * -- the ticker, the company's NAME in brackets, the commentary, the
 * filled square, and then the author's VERDICT.
 *
 * The 24 August file prints
 *
 *   DFDV: Crypto treasury stock, strong but volatile. [square]
 *
 * -- the ticker, the commentary, and the square, with no verdict.
 *
 * The square is a ZapfDingbats filled square, and the text layer
 * renders it as the literal letter "I". It is therefore GLUED to what
 * follows it: every entry of the 24 August file but the first reads as
 * "ISBET" where the ticker is SBET, and the corpus's own trade log
 * confirms it -- it carries BMNR for the entry the text layer reads as
 * "IBMNR" (measured 2026-11-17).
 *
 * So the reader has to know that a leading "I" on an entry that is NOT
 * the first of its section is the square, and not the ticker's first
 * letter. The RAW token is kept beside the ticker so a reader can
 * check the reading.
 *
 * THE SECTIONS are the file's own headings, in this order:
 *
 *   Market Trend Analysis | Commodities & Crypto |
 *   Stocks Holding Up / Under Watch | Additional Mentions | Summary
 *
 * The 16 August file draws a heading and its body as ONE text block,
 * so the heading arrives glued to the first words of the prose
 * ("Market Trend AnalysisThe NASDAQ remains in a strong uptrend"); the
 * 24 August file draws them separately. Splitting on the headings
 * handles both.
 */

const fs = require('node:fs');
const path = require('node:path');

const { readMeta } = require('../newsletter/pdfReader');

/** The sections, in the order the file prints them. */
const SUMMARY_SECTIONS = [
  'Market Trend Analysis',
  'Commodities & Crypto',
  'Stocks Holding Up / Under Watch',
  'Additional Mentions',
  'Summary',
];

/** The section whose entries are per-holding. */
const WATCHLIST_SECTION = 'Stocks Holding Up / Under Watch';

/**
 * The VERDICT vocabulary, and what each verdict says.
 *
 * These are the author's own words, and there are five of them across
 * the two files. The mapping is a judgement about what a verdict MEANS,
 * so the verdict text is stored beside the stance and a reader can
 * disagree with it.
 */
const VERDICT_STANCES = {
  'setting up and ready': 'bullish',
  'actionable setup': 'bullish',
  'strong trend': 'bullish',
  'needs more consolidation': 'neutral',
  'no actionable setup': 'neutral',
  'still consolidating': 'neutral',
  'too choppy': 'bearish',
  'not favorable': 'bearish',
  'choppy': 'bearish',
};

/**
 * The stance a verdict states.
 *
 * The comparison ignores SPACES, because the extraction dropped the
 * space at a line break inside the verdict: "Needs more
 * consolidation" comes back as "Needs moreconsolidation" and, in the
 * 24 August file, "Needsmore consolidation" (measured 2026-11-17).
 * The verdict text is stored as it was read, and the stance is the
 * reading of it.
 *
 * @param {string} verdict
 * @returns {string} 'bullish' | 'bearish' | 'neutral' | ''
 */
function stanceForVerdict(verdict) {
  const text = String(verdict || '').toLowerCase().replace(/\s+/g, '');
  if (!text) return '';
  for (const [phrase, stance] of Object.entries(VERDICT_STANCES)) {
    if (text.includes(phrase.replace(/\s+/g, ''))) return stance;
  }
  return '';
}

/**
 * The text of a summary document.
 *
 * @param {string} pdfPath
 * @returns {object} { title, date, text }
 */
function readSummaryText(pdfPath) {
  let meta;
  try {
    meta = readMeta(pdfPath);
  } catch {
    // A file that is not a PDF yields nothing, rather than an
    // exception: the reader is pointed at documents the catalog
    // classified, and a misclassification must not stop a run.
    return { title: '', date: '', text: '' };
  }
  const page = (meta.pages || [])[0];
  if (!page) return { title: '', date: '', text: '' };
  const blocks = (page.text_blocks || [])
    .map((block) => String(block.text || ''))
    .filter(Boolean);
  const title = blocks.find((text) => /Weekend-Report Summary/i.test(text)) || '';
  const date = blocks.find((text) => /^\w+ \d{1,2}, \d{4}$/.test(text.trim())) || '';
  // The title and the date are cut out before the sections are found:
  // the title CONTAINS the word "Summary", and the section search
  // would otherwise split the document at the title's own word.
  const body = blocks.filter((text) => text !== title && text !== date).join('\n');
  return { title, date, text: body };
}

/**
 * Split a summary's text into its sections.
 *
 * @param {string} text
 * @returns {Array<{section: string, body: string}>}
 */
function splitSections(text) {
  const source = String(text || '');
  const found = [];
  for (const section of SUMMARY_SECTIONS) {
    const index = source.indexOf(section);
    if (index >= 0) found.push({ section, index, end: index + section.length });
  }
  found.sort((a, b) => a.index - b.index);

  const out = [];
  for (let i = 0; i < found.length; i += 1) {
    const start = found[i].end;
    const stop = i + 1 < found.length ? found[i + 1].index : source.length;
    out.push({ section: found[i].section, body: source.slice(start, stop).trim() });
  }
  return out;
}

/**
 * An entry's start: the subject, an optional name in brackets, and
 * then a colon or an em dash.
 *
 * The subject is a ticker (capitals, at most five letters) or a
 * capitalised word -- the commodities section reads "Oil: Declining,
 * no actionable setup.".
 *
 * The boundary is a full stop with NO space after it, because the
 * extraction dropped the line break that separated two entries:
 * "...needs more consolidation.TLRY (Tilray) -- ...".
 */
const ENTRY_START = /(^|\.\s*)([A-Z][A-Za-z]{0,24}(?:\s[A-Z][A-Za-z]{0,24})?)\s*(\(([^)]{1,60})\))?\s*(?:—|:)\s*/g;

/**
 * Split a section's body into its entries.
 *
 * @param {string} body
 * @param {boolean} isFirst - whether this is the section's first entry
 *   (the square only ever precedes an entry that is NOT the first)
 * @returns {Array<{subject: string, raw_subject: string, name: string, text: string, verdict: string}>}
 */
function splitEntries(body, isFirst = false) {
  const source = String(body || '');
  const starts = [];
  ENTRY_START.lastIndex = 0;
  let match = ENTRY_START.exec(source);
  while (match) {
    starts.push({
      at: match.index + match[1].length,
      subject: match[2].trim(),
      name: match[4] ? match[4].trim() : '',
      textAt: match.index + match[0].length,
    });
    match = ENTRY_START.exec(source);
  }

  const entries = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const stop = i + 1 < starts.length ? starts[i + 1].at : source.length;
    // The text is the line AFTER its subject: the subject is a column
    // of its own, and repeating it in the text would make every
    // reading carry its own label twice.
    let raw = source.slice(start.textAt, stop).trim();

    // The square. It is the literal letter "I", glued to the entry it
    // belongs to, and it is either the marker between a commentary and
    // a verdict (16 August) or the bullet that ends an entry (24
    // August).
    let verdict = '';
    const square = raw.indexOf(' I');
    if (square >= 0) {
      const after = raw.slice(square + 2).trim();
      if (after) verdict = after.replace(/^[a-z]+ /, '').trim();
      raw = raw.slice(0, square).trim();
    }

    // A leading "I" on an entry that is not the first of its section
    // is the square, not the ticker's first letter.
    let subject = start.subject;
    if (!isFirst && i > 0 && subject.length > 1 && subject.startsWith('I')
      && /^[A-Z]{1,5}$/.test(subject)) {
      subject = subject.slice(1);
    }

    entries.push({
      name: start.name,
      raw_subject: start.subject,
      subject,
      stance: stanceForVerdict(verdict),
      text: raw,
      verdict,
    });
  }
  return entries;
}

/**
 * Read a summary document into its readings.
 *
 * @param {string} pdfPath
 * @returns {object} { title, date, readings }
 */
function parseSummaryDocument(pdfPath) {
  const { title, date, text } = readSummaryText(pdfPath);
  const readings = [];

  for (const section of splitSections(text)) {
    if (section.section === WATCHLIST_SECTION) {
      const entries = splitEntries(section.body, false);
      for (const entry of entries) {
        readings.push({
          kind: 'holding',
          section: section.section,
          subject: entry.subject,
          name: entry.name,
          raw_subject: entry.raw_subject,
          text: entry.text,
          verdict: entry.verdict,
          stance: entry.stance,
        });
      }
      continue;
    }
    if (section.section === 'Commodities & Crypto') {
      for (const entry of splitEntries(section.body, false)) {
        readings.push({
          kind: 'market',
          section: section.section,
          subject: entry.subject,
          name: entry.name,
          raw_subject: entry.raw_subject,
          text: entry.text,
          verdict: entry.verdict,
          stance: entry.stance,
        });
      }
      continue;
    }
    // The prose sections: one reading each, with no subject.
    readings.push({
      kind: 'market',
      section: section.section,
      subject: '',
      name: '',
      raw_subject: '',
      text: section.body,
      verdict: '',
      stance: '',
    });
  }

  return { date, readings, title };
}

module.exports = {
  SUMMARY_SECTIONS,
  VERDICT_STANCES,
  WATCHLIST_SECTION,
  parseSummaryDocument,
  readSummaryText,
  splitEntries,
  splitSections,
  stanceForVerdict,
};
