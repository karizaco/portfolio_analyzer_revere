'use strict';

const sharp = require('sharp');

// Reuse existing parsers and utilities
const {
  normalizeWhitespace,
  normalizeOcrFragment,
  extractHoldingsContent,
  normalizeHoldings
} = require('../normalize/cleanFields');

const {
  loadSeedLexiconSync
} = require('../normalize/tickerScan');

const {
  hasPriceNear,
  findCloseTickerMatch
} = require('../parse/parseChartStream');

const { LOW_CONFIDENCE_THRESHOLD } = require('../config/schema');

// Ticker pattern — must match the existing lexer
const STRICT_TICKER_PATTERN = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;

// ---------- Whiteboard Window Detection (pixel analysis) ----------

const WB_BRIGHT_THRESHOLD = 220;
const WB_DARK_THRESHOLD = 40;
const WB_MIN_BRIGHT_RUN_FRACTION = 0.35;  // bright run spans 35%+ of frame width
const WB_BORDER_SEARCH_BAND = 6;          // px outside bright run to check for black border
const WB_MIN_WINDOW_AREA_PX2 = 40000;
const WB_Y_TOLERANCE = 15;               // row clustering tolerance in px

/**
 * Detect whiteboard window bounds in an OCR-resolution frame using pixel analysis.
 * The whiteboard is a bright (white) interior with a dark (black) border,
 * surrounded by a dark (chart) background.
 *
 * Returns { windowLeft, windowTop, windowWidth, windowHeight } in pixel coords
 * of the OCR-resolution frame, or null if no candidate found.
 */
async function detectWhiteboardWindow(framePath) {
  // Load at OCR resolution width (1280) to match ocr.words coordinates
  const TARGET_WIDTH = 1280;
  const { data, info } = await sharp(framePath)
    .grayscale()
    .resize({ width: TARGET_WIDTH, fit: 'contain' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const buf = data;

  // Step 1: Per-row bright pixel counts
  const rowBrightCounts = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      if (buf[y * width + x] >= WB_BRIGHT_THRESHOLD) count++;
    }
    rowBrightCounts[y] = count;
  }

  // Step 2: Per-column dark pixel counts
  const colDarkCounts = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (buf[y * width + x] <= WB_DARK_THRESHOLD) count++;
    }
    colDarkCounts[x] = count;
  }

  const brightRunThreshold = Math.floor(width * WB_MIN_BRIGHT_RUN_FRACTION);
  const borderDarkFraction = 0.08; // at least 8% of the column must be dark for a border

  // Step 3: Find candidate bright rows (interior of whiteboard)
  const brightRows = [];
  for (let y = 0; y < height; y++) {
    if (rowBrightCounts[y] >= brightRunThreshold) {
      brightRows.push(y);
    }
  }

  if (brightRows.length < 5) return null;  // need at least a few bright rows

  // Step 4: Find contiguous bright row ranges
  const ranges = [];
  let rangeStart = brightRows[0];
  let prev = brightRows[0];
  for (let i = 1; i <= brightRows.length; i++) {
    if (i === brightRows.length || brightRows[i] !== prev + 1) {
      // End of range
      if (brightRows[i - 1] - rangeStart >= 3) {  // min 4 rows
        ranges.push({ top: rangeStart, bottom: brightRows[i - 1] });
      }
      if (i < brightRows.length) rangeStart = brightRows[i];
    }
    if (i < brightRows.length) prev = brightRows[i];
  }

  // Step 5: For each bright range, check for dark border columns on left/right
  let bestArea = 0;
  let bestBounds = null;

  for (const range of ranges) {
    const candidateTop = range.top;
    const candidateBottom = range.bottom;
    const candidateHeight = candidateBottom - candidateTop + 1;

    // Find left border: scan columns from left until we find a dark column
    let windowLeft = 0;
    for (let x = 0; x < width; x++) {
      // Check if column x has enough dark pixels in the bright row range
      let darkInRange = 0;
      for (let y = candidateTop - WB_BORDER_SEARCH_BAND; y <= candidateBottom + WB_BORDER_SEARCH_BAND; y++) {
        if (y >= 0 && y < height && buf[y * width + x] <= WB_DARK_THRESHOLD) {
          darkInRange++;
        }
      }
      const totalInRange = candidateBottom - candidateTop + 1 + 2 * WB_BORDER_SEARCH_BAND;
      if (darkInRange / totalInRange >= borderDarkFraction) {
        windowLeft = x;
        break;
      }
    }

    // Find right border: scan columns from right until we find a dark column
    let windowRight = width - 1;
    for (let x = width - 1; x >= 0; x--) {
      let darkInRange = 0;
      for (let y = candidateTop - WB_BORDER_SEARCH_BAND; y <= candidateBottom + WB_BORDER_SEARCH_BAND; y++) {
        if (y >= 0 && y < height && buf[y * width + x] <= WB_DARK_THRESHOLD) {
          darkInRange++;
        }
      }
      const totalInRange = candidateBottom - candidateTop + 1 + 2 * WB_BORDER_SEARCH_BAND;
      if (darkInRange / totalInRange >= borderDarkFraction) {
        windowRight = x;
        break;
      }
    }

    const candidateWidth = windowRight - windowLeft + 1;
    const area = candidateWidth * candidateHeight;

    if (area > bestArea && candidateWidth >= 200 && candidateHeight >= 80) {
      bestArea = area;
      bestBounds = {
        windowLeft,
        windowTop: candidateTop,
        windowWidth: candidateWidth,
        windowHeight: candidateHeight
      };
    }
  }

  return bestBounds;
}

// ---------- Word Row Clustering ----------

/**
 * Group words into visual rows using Tesseract's native line field.
 * Tesseract's TSV `line` column already correctly groups words on the same
 * visual text line. We use it directly without re-clustering, which avoids
 * the problem of Y-tolerance merging unrelated adjacent lines.
 */
function clusterWordsIntoRows(words) {
  if (!words || !words.length) return [];

  // Use Tesseract's native line grouping directly
  const byLine = new Map();
  for (const w of words) {
    const lineNum = w.line;
    if (!byLine.has(lineNum)) byLine.set(lineNum, []);
    byLine.get(lineNum).push(w);
  }

  const rows = [];
  for (const [lineNum, lineWords] of byLine) {
    const yCenter = lineWords.reduce((s, w) => s + w.top + w.height / 2, 0) / lineWords.length;
    lineWords.sort((a, b) => a.left - b.left);  // sort by X
    rows.push({ lineNum, yCenter, words: lineWords });
  }

  rows.sort((a, b) => a.yCenter - b.yCenter);
  return rows;
}

// ---------- Keyword Row Finding ----------

function fuzzyMatchKeyword(text, pattern) {
  if (!text) return false;
  const upper = text.toUpperCase();
  const cleaned = normalizeOcrFragment(upper);
  return pattern.test(cleaned) || pattern.test(upper);
}

/**
 * Find rows containing any word that fuzzy-matches the given pattern.
 */
function findRowsByKeyword(rows, keywordPattern) {
  return rows.filter(row =>
    row.words.some(w => fuzzyMatchKeyword(w.text, keywordPattern))
  );
}

/**
 * Find the row cluster that contains a word matching the given keyword pattern.
 * Only matches whole words (no partial matches like "RG8" for "GRO").
 */
function findRowByKeyword(rows, keywordPattern) {
  for (const row of rows) {
    for (const w of row.words) {
      if (fuzzyMatchKeyword(w.text, keywordPattern)) {
        return row;
      }
    }
  }
  return null;
}

/**
 * Find all words matching a keyword pattern within a row.
 */
function findKeywordWordsInRow(row, keywordPattern) {
  return row.words.filter(w => fuzzyMatchKeyword(w.text, keywordPattern));
}

// ---------- Ticker Extraction from Row ----------

function cleanTickerToken(token) {
  if (!token) return '';
  const cleaned = String(token)
    .replace(/^\(+|\)+$/g, '')
    .replace(/^[|\s]+|[|\s]+$/g, '')
    .replace(/^[^A-Z0-9]+|[^A-Z0-9.]+$/gi, '');
  return cleaned.toUpperCase();
}

function isTickerShape(text) {
  if (!text) return false;
  const cleaned = cleanTickerToken(text);
  return STRICT_TICKER_PATTERN.test(cleaned) && cleaned.length >= 1;
}

/**
 * Tokenize a merged ticker group word into individual ticker candidates.
 * Tesseract merges comma-separated tickers into single words, e.g.
 * "SPYM,UPRO,TQQQ," or "PLTR,U,BE" or "HPE,AMD,SKHY,".
 *
 * Strategy: split on commas (ticker list separators), then validate
 * each token. For tokens containing slashes (UPRO/SPXL):
 *   - If BOTH slash-parts are real tickers → accept both
 *   - Otherwise → accept the first part only (slash is likely a misread comma)
 *
 * Tokens starting with non-alpha chars (|, etc.) are cleaned.
 * Single-char results are discarded.
 */
function tokenizeMergedTickers(word, lexicon) {
  const raw = word.text;
  // Split on commas first — commas always separate tickers in the list
  const commaTokens = raw.split(',');
  const result = [];

  for (const tok of commaTokens) {
    const cleaned = cleanTickerToken(tok.trim());
    if (!cleaned) continue;

    if (cleaned.includes('/')) {
      // Slash: could be ratio notation OR a misread comma.
      // Accept BOTH slash-parts only if BOTH are valid tickers in the lexicon.
      const slashParts = cleaned.split('/').map(p => cleanTickerToken(p.trim())).filter(Boolean);
      if (slashParts.length === 2) {
        const [first, second] = slashParts;
        const firstValid = STRICT_TICKER_PATTERN.test(first) && first.length > 1;
        const secondValid = STRICT_TICKER_PATTERN.test(second) && second.length > 1;
        if (firstValid && secondValid && lexicon.has(first) && lexicon.has(second)) {
          // Both are real tickers — accept both (rare case)
          result.push(first, second);
        } else {
          // Treat slash as misread comma — accept first part only
          if (firstValid && (lexicon.has(first) || first.length > 1)) {
            result.push(first);
          }
        }
      } else if (slashParts.length === 1 && slashParts[0]) {
        result.push(slashParts[0]);
      }
    } else {
      result.push(cleaned);
    }
  }

  return result;
}

/**
 * Extract tickers from the GRO/TURBO HOLDINGS line using the colon boundary.
 *
 * Strategy:
 * 1. Find the "HOLDINGS:" word — its right edge marks the start of the ticker list
 * 2. For words strictly to the right of the colon on the label row:
 *    a. If the word is a plain ticker (no comma/slash) → accept directly
 *    b. If the word is a merged group (contains comma or slash) → split and tokenize
 * 3. Reject any ticker-shaped words on adjacent rows within 30px
 */
function extractTickersNearLabel({ rows, labelRow, windowBounds, lexicon }) {
  if (!rows || !rows.length || !labelRow) {
    return { tickers: [], rejected: [] };
  }

  // Find the HOLDINGS colon position
  let colonRight = -1;
  for (const word of labelRow.words) {
    const cleaned = word.text.replace(/[^A-Z0-9:]/gi, '').toUpperCase();
    if (/^HOLDINGS?:?$/.test(cleaned) || cleaned === 'HOLD:') {
      const wordRight = word.left + word.width;
      if (wordRight > colonRight) colonRight = wordRight;
    }
  }
  if (colonRight < 0) {
    for (const word of labelRow.words) {
      const cleaned = word.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (/^(GRO|TURBO)$/.test(cleaned)) {
        const wordRight = word.left + word.width;
        if (wordRight > colonRight) colonRight = wordRight;
      }
    }
  }
  if (colonRight < 0) {
    colonRight = windowBounds ? windowBounds.windowLeft + 200 : 200;
  }

  const labelYCenter = labelRow.yCenter;
  const maxRight = windowBounds
    ? windowBounds.windowLeft + windowBounds.windowWidth - 10
    : Infinity;

  const accepted = [];
  const rejected = [];

  for (const row of rows) {
    const yDist = Math.abs(row.yCenter - labelYCenter);

    if (yDist === 0) {
      // Same row as the label: extract tickers to the right of colon
      for (const word of row.words) {
        if (word.left <= colonRight) continue;
        if (word.left + word.width > maxRight) continue;

        const raw = word.text;
        const isMergedGroup = /[,\/]/.test(raw);

        if (isMergedGroup) {
          // Split merged group into individual tokens
          const tokens = tokenizeMergedTickers(word, lexicon);
          for (const ticker of tokens) {
            if (!STRICT_TICKER_PATTERN.test(ticker)) {
              rejected.push({ text: ticker, reason: 'MERGED_TOKEN_NOT_TICKER', word });
              continue;
            }
            const inLexicon = lexicon.has(ticker);
            if (!inLexicon && !hasPriceNear(raw, ticker)) {
              const correction = findCloseTickerMatch(ticker, { tickerSet: lexicon, tickers: [...lexicon] });
              if (correction && lexicon.has(correction)) {
                accepted.push({ ticker: correction, word, corrected: ticker });
              } else {
                rejected.push({ text: ticker, reason: 'NOT_IN_LEXICON', word });
              }
              continue;
            }
            accepted.push({ ticker, word, corrected: null });
          }
        } else {
          // Plain single ticker word
          const cleaned = cleanTickerToken(word.text);
          if (!isTickerShape(word.text)) continue;
          const inLexicon = lexicon.has(cleaned);
          if (!inLexicon && !hasPriceNear(word.text, cleaned)) {
            rejected.push({ text: cleaned, reason: 'NOT_IN_LEXICON', word });
            continue;
          }
          accepted.push({ ticker: cleaned, word, corrected: null });
        }
      }
    } else if (yDist <= 30) {
      // Adjacent row within 30px: reject ticker-shaped words (SECTORS noise)
      for (const word of row.words) {
        const cleaned = cleanTickerToken(word.text);
        if (isTickerShape(word.text)) {
          rejected.push({ text: cleaned, reason: 'ADJACENT_ROW_REJECTED', word });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  const tickers = [];
  for (const { ticker } of accepted) {
    if (!seen.has(ticker)) {
      seen.add(ticker);
      tickers.push(ticker);
    }
  }

  return { tickers, rejected };
}

// ---------- Build Observation Row (matching existing schema) ----------

function buildObservationRow({ metadata, ocr, portfolio, holdingsTickers, actionText, actionTextRaw, bottomLine, bottomLineRaw, rawLines, windowBounds, holdingsRow, turboRow, issueCodes }) {
  const issues = issueCodes || [];

  if (!holdingsTickers || holdingsTickers.length === 0) {
    issues.push('MISSING_HOLDINGS');
  }
  if (!actionText) {
    issues.push('MISSING_ACTION_LINE');
  }
  if (!bottomLine) {
    issues.push('MISSING_BOTTOM_LINE');
  }
  if (ocr.confidence < LOW_CONFIDENCE_THRESHOLD) {
    issues.push('LOW_OCR_CONFIDENCE');
  }

  return {
    action_text: actionText || '',
    action_text_raw: actionTextRaw || '',
    actions: [],  // parsed separately if needed
    as_of_date: metadata.asOfDate || '',
    bottom_line: bottomLine || '',
    bottom_line_raw: bottomLineRaw || '',
    issue_codes: issues.join('|'),
    metric_1: '',
    metric_2: '',
    metric_scalar: null,
    metrics_raw: actionTextRaw || '',
    ocr_confidence: Number(ocr.confidence || 0).toFixed(2),
    ocr_profile: ocr.profileName || '',
    parse_status: issues.length ? 'review' : 'ok',
    portfolio,
    raw_lines: rawLines.join(' || '),
    sequence: metadata.sequence || '',
    source_file: metadata.fileName || '',
    // New bounding-box fields
    holdings_row_y: holdingsRow ? holdingsRow.yCenter : null,
    window_bbox: windowBounds ? {
      left: windowBounds.windowLeft,
      top: windowBounds.windowTop,
      width: windowBounds.windowWidth,
      height: windowBounds.windowHeight
    } : null,
    tickers_from_bbox: holdingsTickers || [],
    positional_parse: !!(holdingsRow && windowBounds)
  };
}

// ---------- Main Parser ----------

/**
 * Parse a whiteboard screenshot using per-word bounding boxes.
 * Falls back to text-only parsing if bounding boxes are unavailable.
 *
 * @param {object} options
 * @param {object} options.metadata - frame metadata
 * @param {object} options.ocr - OCR result with text, lines, words
 * @param {string} options.framePath - path to the OCR frame PNG (for window detection)
 */
async function parseWhiteboardScreenshotWithBoxes({ metadata, ocr, framePath }) {
  // Guard: if no words data, fall back gracefully
  if (!ocr || !ocr.words || ocr.words.length === 0) {
    // Return null to signal fallback needed
    return null;
  }

  const words = ocr.words;
  const text = ocr.text || '';
  const upper = text.toUpperCase();

  // Step 1: Detect whiteboard window bounds (pixel analysis)
  let windowBounds = null;
  if (framePath) {
    try {
      windowBounds = await detectWhiteboardWindow(framePath);
    } catch (err) {
      // Window detection failed — proceed without window bounds
    }
  }

  // Step 2: Cluster words into rows
  const rows = clusterWordsIntoRows(words);
  if (rows.length === 0) return null;

  // Step 3: Find the GRO HOLDINGS row
  // Strategy: A GRO/TURBO label must be near HOLDINGS (same line or ±1 line).
  // The percentage row "+0.12% GRO +0.14% TURBO" fails this test because
  // HOLDINGS never appears nearby, so it is correctly rejected.
  const groHoldingsRow = (() => {
    const labelKeywords = ['GRO', 'TURBO'];
    const holdingsKeywords = ['HOLDINGS', 'HOLD', 'HLDGS', 'HOLDING'];

    for (const row of rows) {
      const rowWords = row.words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
      const rowHasLabel = rowWords.some(w => labelKeywords.includes(w));
      if (!rowHasLabel) continue;

      // Check this row and ±1 adjacent rows for HOLDINGS keyword
      const rowIdx = rows.indexOf(row);
      let foundHoldings = false;
      for (const offset of [-1, 0, 1]) {
        const adjIdx = rowIdx + offset;
        if (adjIdx < 0 || adjIdx >= rows.length) continue;
        const adjWords = rows[adjIdx].words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
        if (adjWords.some(w => holdingsKeywords.includes(w))) {
          foundHoldings = true;
          break;
        }
      }

      if (foundHoldings) return row;
    }
    return null;
  })();

  // Step 4: Find the TURBO HOLDINGS row (below GRO)
  // Same keyword-proximity strategy: TURBO must be near HOLDINGS (±1 line)
  let turboHoldingsRow = null;
  const holdingsKeywords = ['HOLDINGS', 'HOLD', 'HLDGS', 'HOLDING'];
  if (groHoldingsRow) {
    const groIndex = rows.indexOf(groHoldingsRow);
    for (let i = groIndex + 1; i < rows.length; i++) {
      const rowWords = rows[i].words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
      if (!rowWords.includes('TURBO')) continue;

      // Check this row and ±1 adjacent rows for HOLDINGS keyword
      let foundHoldings = false;
      for (const offset of [-1, 0, 1]) {
        const adjIdx = i + offset;
        if (adjIdx < 0 || adjIdx >= rows.length) continue;
        const adjWords = rows[adjIdx].words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
        if (adjWords.some(w => holdingsKeywords.includes(w))) {
          foundHoldings = true;
          break;
        }
      }

      if (foundHoldings) {
        turboHoldingsRow = rows[i];
        break;
      }
    }
  }

  // Step 5: Load lexicon for ticker validation
  let lexicon = new Set();
  try {
    const { tickers } = loadSeedLexiconSync();
    lexicon = new Set(tickers);
  } catch (_) {}

  // Step 6: Extract GRO tickers — scan all rows within ±30px of the label row
  const groTickers = groHoldingsRow
    ? extractTickersNearLabel({ rows, labelRow: groHoldingsRow, windowBounds, lexicon }).tickers
    : [];

  // Step 7: Extract TURBO tickers
  const turboTickers = turboHoldingsRow
    ? extractTickersNearLabel({ rows, labelRow: turboHoldingsRow, windowBounds, lexicon }).tickers
    : [];

  // Step 8: Find BOTTOM LINE
  const bottomLineRow = findRowByKeyword(rows, /\bBOTTOM\b.*\bLINE\b/i);
  let bottomLine = '';
  let bottomLineRaw = '';
  if (bottomLineRow) {
    const blText = bottomLineRow.words.map(w => w.text).join(' ');
    bottomLineRaw = blText;
    const match = blText.match(/BOTTOM\s+LINE\s*:?\s*(.*)/i);
    bottomLine = match ? match[1].trim() : blText;
  }

  // Step 9: Find action text (RVAB/REBAR row below GRO HOLDINGS)
  let groActionRow = null;
  let turboActionRow = null;

  if (groHoldingsRow) {
    const groIdx = rows.indexOf(groHoldingsRow);
    for (let i = groIdx + 1; i < Math.min(groIdx + 4, rows.length); i++) {
      if (findKeywordWordsInRow(rows[i], /\b(RVAB|REBAR)\b/i).length > 0) {
        groActionRow = rows[i];
        break;
      }
    }
  }

  if (turboHoldingsRow) {
    const turboIdx = rows.indexOf(turboHoldingsRow);
    for (let i = turboIdx + 1; i < Math.min(turboIdx + 4, rows.length); i++) {
      if (findKeywordWordsInRow(rows[i], /\b(RVAB|REBAR)\b/i).length > 0) {
        turboActionRow = rows[i];
        break;
      }
    }
  }

  const groActionText = groActionRow ? groActionRow.words.map(w => w.text).join(' ') : '';
  const turboActionText = turboActionRow ? turboActionRow.words.map(w => w.text).join(' ') : '';

  // Step 10: Build observation rows matching existing schema
  const groIssues = [];
  if (!groTickers.length) groIssues.push('MISSING_GRO_HOLDINGS');
  if (!groActionText) groIssues.push('MISSING_GRO_ACTION_LINE');

  const turboIssues = [];
  if (!turboTickers.length) turboIssues.push('MISSING_TURBO_HOLDINGS');
  if (!turboActionText) turboIssues.push('MISSING_TURBO_ACTION_LINE');

  const rawLines = (ocr.lines || []).length > 0 ? ocr.lines : text.split('\n').map(l => l.trim()).filter(Boolean);

  const groRow = buildObservationRow({
    metadata,
    ocr,
    portfolio: 'GRO',
    holdingsTickers: groTickers,
    actionText: '',  // not parsing metrics here
    actionTextRaw: groActionText,
    bottomLine,
    bottomLineRaw,
    rawLines,
    windowBounds,
    holdingsRow: groHoldingsRow,
    turboRow: null,
    issueCodes: groIssues
  });

  const turboRow = buildObservationRow({
    metadata,
    ocr,
    portfolio: 'TURBO',
    holdingsTickers: turboTickers,
    actionText: '',
    actionTextRaw: turboActionText,
    bottomLine,
    bottomLineRaw,
    rawLines,
    windowBounds,
    holdingsRow: turboHoldingsRow,
    turboRow: null,
    issueCodes: turboIssues
  });

  return [groRow, turboRow];
}

module.exports = {
  parseWhiteboardScreenshotWithBoxes,
  // Exported for testing
  detectWhiteboardWindow,
  clusterWordsIntoRows,
  extractTickersNearLabel
};
