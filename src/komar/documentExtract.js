'use strict';

/**
 * Parse Komar document artifacts into structured rows.
 *
 * PHASE 2 SCOPE
 *
 * The catalog (Phase 1) says what files exist. This phase reads WHAT THEY
 * SAY:
 *
 *   - the market card embedded in report/post PDFs
 *   - the per-trade notes in deck PDFs (Trades-August-2025)
 *
 * The trade-log sheet itself is left for a dedicated extractor in Phase 3:
 * it is a high-resolution spreadsheet screenshot and deserves the full
 * `src/table/` reader path, with its own measured column mapping.
 *
 * WHY THIS MODULE DOES NOT TALK TO SQLITE
 *
 * The parser is pure: input in, rows out. The writer and the catalog tool
 * own the database writes. Keeping the parser pure is what makes it
 * testable on fixtures and what keeps a parser bug from mutating tables
 * before it is seen.
 */

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const { readMeta, extractEmbeddedImage } = require('../newsletter/pdfReader');
const { closeWorker: closeTableWorker, readRegionText } = require('../table/tableReader');
const { INDEX_ROWS, parseExposure, parseLeaders } = require('./cardLayout');
const { findArrowDiscs, readTrendFromDiscs } = require('./cardDiscs');
const { readAccentTitles } = require('./cardThemes');

/** The parser version written onto every Phase-2 row. */
const PARSER_VERSION = 'komar-docs-2';

/**
 * The OCR scale for card regions.
 */
const CARD_SCALE = 6;

/**
 * The scale the FULL card is read at.
 *
 * Measured across five card variants, 5x reads every field -- the index
 * names, the exposure percentage, the narrative and the theme leaders --
 * while 6x on the full card starts to smear the small MARKET UPDATE badge.
 */
const CARD_FULL_SCALE = 5;

/**
 * The widest image the OCR is asked to read, in pixels.
 *
 * Tesseract reads a 300 DPI image comfortably; much beyond 5000 px
 * and Leptonica's allocator gives up. The corpus's chart
 * screenshots are 4435 px wide, so an uncapped 6x upscale of one
 * is 26,610 px.
 */
const MAX_OCR_WIDTH = 5000;

/**
 * The card dimensions this parser has measured and supports.
 */
const CARD_MIN_WIDTH = 1000;
const CARD_MIN_HEIGHT = 650;

/**
 * The trade deck this phase reads as notes.
 */
const TRADE_DECK_DOC_ID = 'komar_doc_deck_trades-august-2025';

/**
 * Find the card images on a document page.
 *
 * The card is a wide landscape image, always at least 1000 px wide and
 * 650 px tall in this corpus. Smaller images on the page are icons,
 * logos and social badges.
 *
 * @param {object} page
 * @returns {object[]}
 */
function findCardImages(page) {
  const out = [];
  for (const image of page.images || []) {
    if (Number(image.width || 0) < CARD_MIN_WIDTH) continue;
    if (Number(image.height || 0) < CARD_MIN_HEIGHT) continue;
    out.push(image);
  }
  return out;
}

/**
 * Does this text read like a market card?
 *
 * SIZE ALONE IS NOT ENOUGH, AND THE MEASUREMENT SAYS SO.
 *
 * The card is a wide image -- 1080 px across, 692 to 769 tall -- and the
 * session print also embeds CHART SCREENSHOTS of the same width and a
 * similar height (1080x608, 1080x697). Measured on
 * komar_20260411.pdf: five images pass a size filter, and only ONE of
 * them is the market card; the other four are TradingView chart
 * screenshots.
 *
 * So the card is told apart by its CONTENT: it carries the words
 * 'Market Trend' and 'Exposure'. The check runs on the OCR text that
 * has already been read, so it costs nothing extra.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeCard(text) {
  const value = String(text || '');
  if (/market\s*trend/i.test(value)) return true;
  if (/high[- ]potential\s*themes?/i.test(value)) return true;
  return false;
}

/**
 * Extract one embedded image to a temporary PNG path.
 *
 * @param {string} pdfPath
 * @param {number} page
 * @param {number} xref
 * @param {string} workDir
 * @returns {string}
 */
function extractCardImage(pdfPath, page, xref, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const outPath = path.join(workDir, `card_p${page}_x${xref}.png`);
  extractEmbeddedImage(pdfPath, page, xref, outPath);
  return outPath;
}

/**
 * The regions of a card, as fractions of width/height.
 *
 * The card comes in several close variants (1080x692, 1080x757, 1080x764)
 * so each region is broad and the parser is label-driven.
 */
const CARD_REGIONS = Object.freeze({
  // The exposure donut sits in the card's upper middle-right, and its
  // reading ('50% invested') is at x 500-820, y 0-160 of a 1080-wide
  // card -- measured by sweeping windows over the card until the
  // percentage was found.
  exposure: { h: 0.22, left: 0.44, top: 0.0, w: 0.32 },
  full: { h: 1.0, left: 0.0, top: 0.0, w: 1.0 },
  narrative: { h: 0.22, left: 0.03, top: 0.31, w: 0.95 },
  themes: { h: 0.46, left: 0.03, top: 0.52, w: 0.95 },
  trend: { h: 0.30, left: 0.03, top: 0.03, w: 0.45 },
});

/**
 * Where the trend table is, as a fraction of the card.
 *
 * The index names and the arrow discs are in the card's top-left
 * quarter, and the discs are what the trend reading is made of.
 */
const TREND_DISC_REGION = Object.freeze({ h: 0.30, left: 0.03, top: 0.02, w: 0.42 });

/**
 * Convert a fractional region to pixel coordinates.
 *
 * @param {{width:number,height:number}} info
 * @param {{left:number,top:number,w:number,h:number}} region
 * @returns {{left:number,top:number,width:number,height:number}}
 */
function toPixels(info, region) {
  return {
    height: Math.max(1, Math.round(info.height * region.h)),
    left: Math.max(0, Math.round(info.width * region.left)),
    top: Math.max(0, Math.round(info.height * region.top)),
    width: Math.max(1, Math.round(info.width * region.w)),
  };
}

/**
 * Read card regions as text.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @returns {Promise<object>}
 */
async function readCardRegions(raw, info) {
  const out = {};
  for (const [name, region] of Object.entries(CARD_REGIONS)) {
    const rect = toPixels(info, region);
    // The full card reads at 5x (measured: every field legible); the
    // narrow regions read at 6x, because their text is smaller.
    // The scale is CAPPED, because the corpus's chart screenshots are
    // 4435 px wide and a 6x upscale of one of those is 26,000 px --
    // which Leptonica refuses to allocate ('pixdata_malloc fail for
    // data') and the Tesseract worker reports as a fatal 'Error
    // attempting to read image'.
    const wanted = name === 'full' ? CARD_FULL_SCALE : CARD_SCALE;
    const scale = Math.max(1, Math.min(wanted, Math.floor(MAX_OCR_WIDTH / Math.max(1, rect.width))));
    // A region that cannot be read is skipped, not fatal. The corpus
    // includes chart screenshots that Tesseract refuses ('pixdata_
    // malloc fail for data'), and one of them must not stop the rest
    // of the corpus from being read.
    try {
      out[name] = await readRegionText(raw, info, rect, scale);
    } catch {
      out[name] = '';
    }
  }
  return out;
}

/**
 * Parse the trend directions from OCR text.
 *
 * @param {string} text
 * @returns {{nasdaq:string,sp500:string,russell2000:string}}
 */
function parseTrendDirectionsFromText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = { nasdaq: 'unknown', russell2000: 'unknown', sp500: 'unknown' };

  const tokenDir = (line) => {
    const value = String(line || '').toLowerCase();
    // Strict words only. A single OCR letter (e.g. "v") is too noisy and
    // produced false "down" on every row.
    if (/\b(up|bullish|positive)\b/.test(value)) return 'up';
    if (/\b(down|bearish|negative)\b/.test(value)) return 'down';
    if (/\b(flat|sideways|mixed|neutral)\b/.test(value)) return 'flat';
    return 'unknown';
  };

  for (const row of INDEX_ROWS) {
    const line = lines.find((item) => item.toLowerCase().includes(row.label.toLowerCase()));
    if (!line) continue;
    out[row.field] = tokenDir(line);
  }
  return out;
}

/**
 * Parse the market narrative from the card text.
 *
 * @param {string} text
 * @returns {string}
 */
function parseNarrative(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';

  // The narrative is the block between the trend table and the themes
  // heading. On the full-card read it is bounded by 'invested' before
  // it and 'High-Potential Themes' after it.
  const between = value.split(/High[- ]Potential Themes?/i)[0];
  const afterExposure = between.split(/\binvested\b/i).pop() || between;
  const narrative = afterExposure
    .replace(/\b(Market Trend|Exposure|MARKET\s+UPDATE|Premium|Mid|Short|Long)\b/gi, ' ')
    .replace(/\bNASDAQ\b|\bS&P 500\b|\bRussell 2000\b/gi, ' ')
    // The arrow discs are read as punctuation by the OCR -- "@ @&",
    // "&@ &® &®" -- and they sit right where the narrative starts.
    // They are dropped.
    .replace(/[&@#%*+=~^|<>]{1,3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // It has to be a sentence or two, not a fragment of the chrome.
  if (narrative.length >= 24) return narrative;

  // Fall back to the whole text with the headings removed.
  return value
    .replace(/\b(Market Trend|Exposure|High[- ]Potential Themes?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse themes and leaders from text.
 *
 * The themes region is OCR'd as free text. The strict leader parser
 * catches rows with "Leaders: ..." directly; this helper also supports
 * flattened OCR by splitting before each Leaders run.
 *
 * @param {string} text
 * @returns {Array<{theme:string, leaders:string[]}>}
 */
function parseThemesFromText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const lines = normalized
    .replace(/\b(?:Leaders|eaders)\s*:/gi, '\nLeaders:')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out = [];
  let currentTheme = '';

  const looksLikeHeading = (line) => {
    if (/leaders\s*:/i.test(line)) return false;
    if (line.length > 36) return false;
    if (/\.$/.test(line)) return false;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;
    const firstTitle = /^[A-Z][A-Za-z/&-]*$/.test(words[0]);
    if (!firstTitle) return false;
    const restOk = words.slice(1).every((word) => /^[A-Za-z/&-]+$/.test(word));
    if (!restOk) return false;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    return letters >= 4;
  };

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      currentTheme = line;
      continue;
    }
    const leaders = parseLeaders(line);
    if (!leaders.length) continue;
    out.push({
      leaders,
      theme: currentTheme || `Theme ${out.length + 1}`,
    });
  }

  if (!out.length) {
    const global = [...normalized.matchAll(/(?:leaders|eaders)\s*:\s*([^\n]+)/gi)];
    for (const match of global) {
      const leaders = parseLeaders(match[0]);
      if (!leaders.length) continue;
      out.push({ leaders, theme: `Theme ${out.length + 1}` });
    }
  }

  const seen = new Set();
  return out.filter((entry) => {
    const key = `${entry.theme}::${entry.leaders.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Parse one market card image.
 *
 * @param {string} imagePath
 * @returns {Promise<{card:object, leaders:object[], regions:object}>}
 */
async function parseCardImage(imagePath) {
  // A card image that cannot be read is SKIPPED, not fatal. One
  // unreadable embedded image in a 27-document corpus must not stop
  // the other 26 from being read.
  let source;
  try {
    source = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    return {
      card: null,
      error: String((error && error.message) || error).slice(0, 200),
      leaders: [],
      regions: {},
    };
  }
  const raw = source.data;
  const info = source.info;
  const regions = await readCardRegions(raw, info);

  // The FULL card is the primary read: the themes and the narrative sit
  // in a wide band that no single region covers, and splitting the card
  // loses the layout the parsers rely on.
  const full = regions.full || '';

  // THE TREND IS READ FROM PIXELS, NOT FROM TEXT.
  //
  // The arrows are images, so OCR cannot read them. The discs are found
  // in the trend table and their COLOUR is the direction.
  const discRegion = {
    height: Math.round(info.height * TREND_DISC_REGION.h),
    left: Math.round(info.width * TREND_DISC_REGION.left),
    top: Math.round(info.height * TREND_DISC_REGION.top),
    width: Math.round(info.width * TREND_DISC_REGION.w),
  };
  const discs = findArrowDiscs(raw, info, { region: discRegion });
  const discTrends = readTrendFromDiscs(discs);
  // The text reading is the fallback: a card whose discs were not found
  // still has its index names read.
  // THE DISC READING WINS.
  //
  // The text reading is only a fallback, and it has to be, because the
  // card's NARRATIVE sits in the same OCR line as the index names: the
  // 2026-01-25 card reads 'Market still going sideways' and the text
  // parser reported every index as 'flat', when the card's own discs
  // say up, up and down.
  //
  // So the discs are read first, and the text only fills in a row whose
  // discs were not found.
  const trends = { ...parseTrendDirectionsFromText(full) };
  if (Object.values(trends).every((value) => value === 'unknown')) {
    Object.assign(trends, parseTrendDirectionsFromText(regions.trend));
  }
  for (const field of ['nasdaq', 'russell2000', 'sp500']) {
    if (discTrends[field] !== 'unknown') trends[field] = discTrends[field];
  }
  // The *_dir columns carry the LONGEST horizon the card shows, because
  // that is the one the card leads with. The per-horizon reading is
  // kept whole beside it.
  const longest = (field) => {
    const entry = (discTrends.byHorizon || {})[field];
    if (!entry) return '';
    const names = Object.keys(entry);
    if (!names.length) return '';
    return entry[names[0]] || '';
  };
  const exposure = parseExposure(full) ?? parseExposure(regions.exposure);
  let narrative = parseNarrative(full);
  let themes = parseThemesFromText(full);
  if (!themes.length) themes = parseThemesFromText(regions.themes);

  // THE THEME NAMES COME FROM THE CARD'S ACCENT INK.
  //
  // The card prints the theme names in orange, and the OCR flattens
  // the card into one line, so the name and its description and its
  // leaders end up in one string. The orange ink is what separates them.
  //
  // The names are used ONLY when their count matches the number of
  // leader groups, because the accent ink also catches the badge and the
  // footnote, and a name that is off by one is worse than no name.
  const accentTitles = await readAccentTitles(raw, info, {
    minTop: Math.round(info.height * 0.45),
    scale: CARD_FULL_SCALE,
  });
  if (accentTitles.length === themes.length) {
    themes = themes.map((theme, index) => ({ ...theme, theme: accentTitles[index] }));
  }

  const leaders = [];
  for (const theme of themes) {
    theme.leaders.forEach((ticker, index) => {
      leaders.push({
        confidence: 0.6,
        leader_index: index + 1,
        theme: theme.theme,
        ticker,
      });
    });
  }

  return {
    card: {
      confidence: exposure !== null || narrative ? 0.6 : 0.25,
      disc_count: discs.length,
      horizons: discTrends.horizons,
      exposure_pct: exposure,
      market_text: narrative,
      market_trend_nasdaq: '',
      market_trend_russell2000: '',
      market_trend_sp500: '',
      parser_version: PARSER_VERSION,
      trend_by_horizon: discTrends.byHorizon || {},
      trend_nasdaq_dir: longest('nasdaq') || trends.nasdaq,
      trend_russell2000_dir: longest('russell2000') || trends.russell2000,
      trend_sp500_dir: longest('sp500') || trends.sp500,
    },
    leaders,
    regions,
  };
}

/**
 * The checklist rows in a deck note.
 *
 * A note page can preserve line breaks (easy case) or flatten everything
 * into one line (hard case). Both shapes are accepted.
 *
 * @param {string} text
 * @returns {Array<{checked:boolean,item:string}>}
 */
function extractChecklist(text) {
  const input = String(text || '');
  const out = [];

  // Line-aware pass first.
  for (const line of input.split(/\r?\n/)) {
    const item = /([✔Xx])\s*(.+?)\?\s*$/.exec(line.trim());
    if (!item) continue;
    out.push({
      checked: item[1] !== 'X' && item[1] !== 'x',
      item: item[2].trim(),
    });
  }

  // Flattened fallback: "✔ Explosive look?✔ Big upmove before..."
  if (out.length < 2) {
    const compact = input.replace(/\s+/g, ' ');
    for (const match of compact.matchAll(/([✔Xx])\s*([^?]{2,140}\?)/g)) {
      const item = match[2].replace(/\?\s*$/, '').trim();
      if (!item) continue;
      out.push({
        checked: match[1] !== 'X' && match[1] !== 'x',
        item,
      });
    }
  }

  // A flattened line can produce one giant item in the line-aware pass
  // ("Explosive look?✔ Big upmove..."), plus proper split items in the
  // fallback pass. Drop any item that still contains another checkbox.
  const cleaned = out.filter((entry) => !/✔/.test(entry.item));

  // de-duplicate by the item text, first occurrence wins.
  const seen = new Set();
  return cleaned.filter((entry) => {
    const key = entry.item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/**
 * Parse the deck notes on one page.
 *
 * @param {object} page
 * @returns {object|null}
 */
function parseDeckPageNotes(page) {
  const spans = [];
  for (const block of page.text_blocks || []) {
    const text = String(block.text || '').trim();
    if (!text) continue;
    spans.push({
      size: Number(block.font_size || 0),
      text,
      top: Number((block.bbox && block.bbox[1]) || 0),
    });
  }
  if (!spans.length) return null;

  const text = spans.map((span) => span.text).join('\n');
  const stars = /([0-5](?:\.5)?)\s*stars?/i.exec(text);
  const grade = /\b([ABC])[- ]?trade\b/i.exec(text);
  const state = /\b(Open|Closed|Journaled)\b/i.exec(text);

  const checklist = extractChecklist(text);


  return {
    body_text: text.replace(/\s+/g, ' ').trim(),
    heading: spans[0].text.slice(0, 160),
    parser_version: PARSER_VERSION,
    quick_checklist: checklist,
    stars: stars ? Number(stars[1]) : null,
    trade_grade: grade ? grade[1].toUpperCase() : '',
    trade_state: state ? state[1] : '',
  };
}

/**
 * Parse one Komar document into Phase-2 rows.
 *
 * @param {{doc_id:string,pdf_path:string,kind:string}} doc
 * @param {{sourceDir:string, workDir:string}} options
 * @returns {Promise<{cards:object[],leaders:object[],notes:object[]}>}
 */
async function parseKomarDocument(doc, options) {
  const pdfPath = path.join(options.sourceDir, doc.pdf_path);
  if (!fs.existsSync(pdfPath)) {
    return { cards: [], leaders: [], notes: [] };
  }

  const meta = readMeta(pdfPath);
  if (meta.error) {
    return { cards: [], leaders: [], notes: [] };
  }

  const cards = [];
  const leaders = [];
  const notes = [];

  for (const page of meta.pages || []) {
    if (doc.kind === 'report' || doc.kind === 'post') {
      for (const image of findCardImages(page)) {
        const imagePath = extractCardImage(pdfPath, page.page, image.xref, options.workDir);
        const parsed = await parseCardImage(imagePath);
        // A chart screenshot is not a card. The card is told apart by its
        // own headings, which the OCR has already produced.
        if (parsed.error) continue;
        if (!looksLikeCard(parsed.regions.full)) continue;
        cards.push({
          ...parsed.card,
          doc_id: doc.doc_id,
          image_height: Number(image.height || 0),
          image_width: Number(image.width || 0),
          image_xref: Number(image.xref || 0),
          page: Number(page.page || 0),
        });
        parsed.leaders.forEach((leader) => {
          leaders.push({
            ...leader,
            doc_id: doc.doc_id,
            image_xref: Number(image.xref || 0),
            page: Number(page.page || 0),
            parser_version: PARSER_VERSION,
          });
        });
      }
    }

    if (doc.doc_id === TRADE_DECK_DOC_ID && Number(page.page || 0) >= 3) {
      const note = parseDeckPageNotes(page);
      if (note) {
        notes.push({
          ...note,
          doc_id: doc.doc_id,
          page: Number(page.page || 0),
        });
      }
    }
  }

  return { cards, leaders, notes };
}

/**
 * Parse several Komar documents.
 *
 * @param {object[]} docs
 * @param {{sourceDir:string, workDir:string}} options
 * @returns {Promise<{cards:object[],leaders:object[],notes:object[]}>}
 */
async function parseKomarDocuments(docs, options) {
  const cards = [];
  const leaders = [];
  const notes = [];

  for (const doc of docs) {
    const parsed = await parseKomarDocument(doc, options);
    cards.push(...parsed.cards);
    leaders.push(...parsed.leaders);
    notes.push(...parsed.notes);
  }

  return { cards, leaders, notes };
}

/**
 * Close OCR workers used by this module.
 *
 * @returns {Promise<void>}
 */
async function closeKomarDocumentWorkers() {
  await closeTableWorker();
}

module.exports = {
  CARD_REGIONS,
  PARSER_VERSION,
  TRADE_DECK_DOC_ID,
  closeKomarDocumentWorkers,
  extractChecklist,
  findCardImages,
  looksLikeCard,
  parseCardImage,
  parseDeckPageNotes,
  parseExposure,
  parseKomarDocument,
  parseKomarDocuments,
  parseLeaders,
  parseThemesFromText,
  parseTrendDirectionsFromText,
};













