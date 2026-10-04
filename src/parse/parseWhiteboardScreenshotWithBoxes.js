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

/**
 * Check if a ticker appears in the correct section of the OCR text.
 * Used by Mode A to distinguish GRO tickers from TURBO/SECTORS tickers
 * when they are all on the same merged OCR line.
 */
function tickerInSection(ocrText, ticker, portfolio) {
  if (!ocrText || !ticker) return true;  // no text to check, accept
  const upper = ocrText.toUpperCase();
  const t = ticker.toUpperCase();

  // Find section boundaries
  const groMatch = upper.match(/\*?\s*GRO\s+HOLDINGS\s*:/i);
  const turboMatch = upper.match(/\*?\s*TURBO\s+HOLDINGS\s*:/i);

  if (portfolio === 'GRO') {
    // GRO tickers must appear between GRO HOLDINGS and either:
    // 1. TURBO HOLDINGS section, OR
    // 2. GRO RVAB/REBAR action line (starts with "* GRO RVAB")
    // The action line text ("BUY NET ADD to BE PLTR SELL LITE, NCLD DOCN") must NOT be included.
    const groPos = groMatch ? upper.indexOf(groMatch[0]) : -1;
    if (groPos < 0) return true;  // can't find section, accept
    // Find the action line start (* GRO RVAB or * GRO RVAB/REBAR)
    const rvabMatch = upper.match(/\*\s*GRO\s+RVAB\/?REBAR\s*:/);
    const rvabPos = rvabMatch ? upper.indexOf(rvabMatch[0]) : -1;
    const turboPos = turboMatch ? upper.indexOf(turboMatch[0]) : -1;
    // Stop at whichever comes first: action line or TURBO HOLDINGS
    let sectionEnd = upper.length;
    if (rvabPos > groPos) sectionEnd = rvabPos;
    if (turboPos > groPos && turboPos < sectionEnd) sectionEnd = turboPos;
    const section = upper.slice(groPos, sectionEnd);
    return section.includes(t);
  } else if (portfolio === 'TURBO') {
    // TURBO tickers must appear between TURBO HOLDINGS and next section
    const turboPos = turboMatch ? upper.indexOf(turboMatch[0]) : -1;
    if (turboPos < 0) return true;  // can't find section, accept
    // Find '* ' (asterisk + space = start of new line) from turbo position onward
    const nextSection = upper.indexOf('* ', turboPos + 10);
    const sectionEnd = nextSection > turboPos ? nextSection : upper.length;
    const section = upper.slice(turboPos, sectionEnd);
    return section.includes(t);
  }
  return true;  // unknown portfolio, accept
}

function cleanTickerToken(token) {
  if (!token) return '';
  const cleaned = String(token)
    .replace(/^\(+|\)+$/g, '')
    .replace(/^[|\s]+|[|\s]+$/g, '')
    .replace(/^[^A-Z0-9]+|[^A-Z0-9.]+$/gi, '')
    // Strip trailing periods (e.g. "SMTC." → "SMTC") — Tesseract often
    // attaches sentence-ending punctuation to the last ticker in a row.
    .replace(/\.+$/, '');
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
 * 2. Only accept words that share the GRO/TURBO keyword's Tesseract line number.
 *    This is critical because:
 *    - When Tesseract MERGES the label row with tickers below it, all share
 *      the same line number → GRO tickers are accepted (correct).
 *    - SECTORS tickers are on a different Tesseract line → rejected (correct).
 *    - Using y-distance (yDist) FAILS here because the merged row's yCenter
 *      (≈444, average of GRO at y~360 and tickers at y~529) makes SECTORS
 *      tickers seem close (yDist=6) and actual GRO tickers seem far (yDist=85).
 * 3. For words on the correct line, also enforce:
 *    - ticker.left >= colonRight + 80 (must be to the right of the label)
 *    - ticker.left + ticker.width <= maxRight
 */
function extractTickersNearLabel({ rows, labelRow, windowBounds, lexicon, portfolio, ocrText }) {
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
    // No standalone HOLDINGS word found — use the GRO label's right edge as
    // fallback. On this whiteboard layout, GRO is at x~440 and tickers start
    // at x~480, so GRO_right + 50 gives enough margin.
    let groRight = -1;
    for (const word of labelRow.words) {
      const cleaned = word.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (cleaned === 'GRO') {
        groRight = word.left + word.width;
        break;
      }
    }
    colonRight = groRight > 0 ? groRight + 50 : (windowBounds ? windowBounds.windowLeft + 200 : 200);
  }

  let maxRight = windowBounds
    ? windowBounds.windowLeft + windowBounds.windowWidth - 10
    : Infinity;

  // If no window bounds, use a generous estimate.
  if (!windowBounds || maxRight === Infinity) {
    let groRight = -1;
    for (const word of labelRow.words) {
      const cleaned = word.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (cleaned === 'GRO') { groRight = word.left + word.width; break; }
    }
    maxRight = groRight > 0 ? groRight * 3 : colonRight + 800;
  }

  // Also bound by TURBO label's left edge — TURBO comes after GRO,
  // so its left edge marks where the GRO section ends. This prevents
  // Mode A from accepting action-row tickers (LITE, NCLD, DOCN) that
  // Tesseract places to the right of GRO HOLDINGS within the GRO section.
  if (maxRight === Infinity) {
    let turboLeft = Infinity;
    for (const row of rows) {
      for (const word of row.words) {
        const cleaned = word.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        if (cleaned === 'TURBO') {
          turboLeft = Math.min(turboLeft, word.left);
        }
      }
    }
    if (turboLeft < Infinity) {
      maxRight = Math.min(maxRight, turboLeft - 20);
    }
  }

  const accepted = [];
  const rejected = [];

  // Two-mode extraction strategy:
  // Mode A — merged row: Tesseract merges the GRO/HOLDINGS label with tickers
  // into one OCR line (e.g., "GRO HOLDINGS: SPYM,UPRO,TQQQ,"). In this case,
  // the tickers are ON the same row as the label, to the right of colonRight.
  // Mode B — split row: Tesseract places the label on one row and tickers
  // on the next row. In this case, we scan the row below the label row.
  //
  // Implementation: scan both the merged row AND the next row, accept tickers
  // from whichever row produces valid results. Mode A is tried first.

  // Find the GRO/TURBO keyword word to get its Tesseract line number.
  const labelKeywords = ['GRO', 'TURBO'];
  const labelKeywordWord = labelRow.words.find(w => {
    const cleaned = w.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return labelKeywords.includes(cleaned);
  });
  const labelLine = labelKeywordWord ? labelKeywordWord.line : labelRow.lineNum;

  // Mode B: split row case — label on one row, tickers on the row below.
  // Mode A: merged row case — label and tickers on the same OCR line.
  // Mode B is tried first because it's cleaner and avoids SECTORS/Forex bleed.
  const labelRowIndex = rows.indexOf(labelRow);
  const nextRow = labelRowIndex >= 0 && labelRowIndex < rows.length - 1
    ? rows[labelRowIndex + 1]
    : null;

  // Mode B: try the row below the label row first (split row case).
  // If the label and tickers are on separate rows, Mode B gets ONLY the ticker row,
  // avoiding SECTORS/Forex words that Mode A (merged) accidentally includes.
  if (nextRow) {
    for (const word of nextRow.words) {
      if (word.left < colonRight) continue;
      if (word.left + word.width > maxRight) continue;

      const raw = word.text;
      const isMergedGroup = /[,\/]/.test(raw);

      if (isMergedGroup) {
        const tokens = tokenizeMergedTickers(word, lexicon);
        for (const ticker of tokens) {
          if (!STRICT_TICKER_PATTERN.test(ticker)) {
            rejected.push({ text: ticker, reason: 'MERGED_TOKEN_NOT_TICKER', word });
            continue;
          }
          // Filter by section — prevents action-row bleed (LITE, NCLD, DOCN in GRO section)
          if (!tickerInSection(ocrText, ticker, portfolio)) {
            rejected.push({ text: ticker, reason: 'WRONG_SECTION', word });
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
        const cleaned = cleanTickerToken(word.text);
        if (!isTickerShape(word.text)) continue;
        // Filter by section — prevents action-row bleed in Mode B (LITE, NCLD, DOCN)
        if (!tickerInSection(ocrText, cleaned, portfolio)) {
          rejected.push({ text: cleaned, reason: 'WRONG_SECTION', word });
          continue;
        }
        const inLexicon = lexicon.has(cleaned);
        if (!inLexicon && !hasPriceNear(word.text, cleaned)) {
          rejected.push({ text: cleaned, reason: 'NOT_IN_LEXICON', word });
          continue;
        }
        accepted.push({ ticker: cleaned, word, corrected: null });
      }
    }
  }

  // Mode A: if Mode B found fewer than 12 tickers, the frame probably has merged
  // groups that Mode B (next-row scan) can't see. Mode A scans the label row too.
  // Threshold of 12: Mode B in good frames finds 15-16 GRO tickers; if we got fewer,
  // run Mode A to catch merged groups (TNA, DOCN, LABU).
  if (accepted.length < 12) {
    for (const word of labelRow.words) {
      if (word.left + word.width > maxRight) continue;

      const raw = word.text;
      const isMergedGroup = /[,\/]/.test(raw);

      if (isMergedGroup) {
        // For merged groups (e.g., "SPYM,UPRO,TQQQ,"), accept regardless of colonRight.
        // The colonRight threshold is only for standalone words (to skip the GRO/HOLDINGS
        // label). Merged ticker groups always start to the right of the label.
        const tokens = tokenizeMergedTickers(word, lexicon);
        for (const ticker of tokens) {
          if (!STRICT_TICKER_PATTERN.test(ticker)) {
            rejected.push({ text: ticker, reason: 'MERGED_TOKEN_NOT_TICKER', word });
            continue;
          }
          // Filter by section: GRO tickers must appear in GRO section of OCR text,
          // TURBO tickers in TURBO section. This prevents SECTORS bleed (DASH, DELL,
          // COPX, TAN, URNM, OIH) from leaking into the wrong portfolio.
          if (!tickerInSection(ocrText, ticker, portfolio)) {
            rejected.push({ text: ticker, reason: 'WRONG_SECTION', word });
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
        // Standalone ticker-shaped words on the label row — these are real tickers
        // (e.g., DOCN on 20260922) that Tesseract didn't merge with a group.
        // The section filter prevents SECTORS bleed (DASH, COPX, TAN, etc.).
        const cleaned = cleanTickerToken(word.text);
        if (!isTickerShape(word.text)) continue;
        if (!tickerInSection(ocrText, cleaned, portfolio)) continue;  // skip SECTORS bleed
        const inLexicon = lexicon.has(cleaned);
        if (!inLexicon && !hasPriceNear(word.text, cleaned)) {
          rejected.push({ text: cleaned, reason: 'NOT_IN_LEXICON', word });
          continue;
        }
        accepted.push({ ticker: cleaned, word, corrected: null });
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
  // Strategy: A GRO label must be on the SAME row as HOLDINGS (not just nearby).
  // The "RVAB/REBAR" row contains GRO but no HOLDINGS — skip it.
  // Fallback: when Tesseract merges all content into 1-2 lines (e.g., 20260923),
  // cluster by Y-coordinate and find GRO/TURBO/HOLDINGS rows independently.
  const holdingsKeywords = ['HOLDINGS', 'HOLD', 'HLDGS', 'HOLDING'];
  let groHoldingsRow = null;
  let turboHoldingsRow = null;

  // Primary: look for rows with both GRO and HOLDINGS
  for (const row of rows) {
    const rowWords = row.words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
    const hasGro = rowWords.some(w => w === 'GRO');
    const hasHoldings = rowWords.some(w => holdingsKeywords.some(hk => w.includes(hk)));
    const hasTurbo = rowWords.some(w => w === 'TURBO');
    if (hasGro && hasHoldings) { groHoldingsRow = row; continue; }
    if (hasTurbo && hasHoldings) { turboHoldingsRow = row; }
  }

  // Fallback Y-coordinate clustering when Tesseract gave only 1-3 "rows"
  if (!groHoldingsRow && rows.length <= 3) {
    // Cluster by Y-coordinate with a 60px gap threshold
    const WORD_Y_CLUSTER_GAP = 60;
    const sortedWords = [...words].sort((a, b) => {
      const ya = a.top + a.height / 2;
      const yb = b.top + b.height / 2;
      return ya - yb;
    });
    const yRows = [];
    let currentRow = [];
    let currentYCenter = null;
    for (const w of sortedWords) {
      const wy = w.top + w.height / 2;
      if (currentYCenter === null || Math.abs(wy - currentYCenter) <= WORD_Y_CLUSTER_GAP) {
        currentRow.push(w);
        currentYCenter = currentYCenter === null ? wy : (currentYCenter * (currentRow.length - 1) + wy) / currentRow.length;
      } else {
        currentRow.sort((a, b) => a.left - b.left);
        yRows.push({ yCenter: currentYCenter, words: currentRow });
        currentRow = [w];
        currentYCenter = wy;
      }
    }
    if (currentRow.length > 0) {
      currentRow.sort((a, b) => a.left - b.left);
      yRows.push({ yCenter: currentYCenter, words: currentRow });
    }

    // Find GRO and HOLDINGS rows by keyword search
    let groYRow = null, turboYRow = null, holdingsYRow = null;
    for (const r of yRows) {
      const rw = r.words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
      if (rw.some(w => w === 'GRO')) groYRow = r;  // independent of TURBO
      if (rw.some(w => w === 'TURBO')) turboYRow = r;  // independent of GRO
      if (rw.some(w => holdingsKeywords.some(hk => w.includes(hk)))) holdingsYRow = r;
    }

    // Pair GRO with nearest HOLDINGS row above it
    if (groYRow && holdingsYRow) {
      const pair = yRows.filter(r => r.yCenter >= holdingsYRow.yCenter && r.yCenter <= groYRow.yCenter + 10);
      if (pair.length > 0) groHoldingsRow = pair[0];
      else if (groYRow) groHoldingsRow = groYRow; // fallback: use GRO row
    } else if (groYRow) {
      // No HOLDINGS row found — use GRO row as best effort
      groHoldingsRow = groYRow;
    }

    // Pair TURBO with nearest HOLDINGS row above it (or use TURBO-only row)
    if (turboYRow && holdingsYRow) {
      const pair = yRows.filter(r => r.yCenter >= holdingsYRow.yCenter && r.yCenter <= turboYRow.yCenter + 10);
      if (pair.length > 0) turboHoldingsRow = pair[0];
      else if (turboYRow) turboHoldingsRow = turboYRow;
    } else if (turboYRow) {
      // No HOLDINGS row found — use TURBO row as best effort
      turboHoldingsRow = turboYRow;
    }
  }

  // Step 4: Find the TURBO HOLDINGS row
  // If GRO and TURBO are on the same row as each other (Tesseract merged them),
  // use the same row. Otherwise look for TURBO+HOLDINGS below GRO.
  if (!turboHoldingsRow && groHoldingsRow) {
    const groIndex = rows.indexOf(groHoldingsRow);
    // First: check if TURBO+HOLDINGS is on the same row as GRO+HOLDINGS
    if (groIndex >= 0) {
      const rowWords = rows[groIndex].words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
      const hasTurbo = rowWords.some(w => w === 'TURBO');
      const hasHoldings = rowWords.some(w => holdingsKeywords.some(hk => w.includes(hk)));
      if (hasTurbo && hasHoldings) {
        turboHoldingsRow = rows[groIndex];
      }
    }
    // Second: look for TURBO+HOLDINGS below GRO
    if (!turboHoldingsRow) {
      for (let i = groIndex + 1; i < rows.length; i++) {
        const rowWords = rows[i].words.map(w => w.text.replace(/[^A-Z]/gi, '').toUpperCase());
        const hasTurbo = rowWords.some(w => w === 'TURBO');
        const hasHoldings = rowWords.some(w => holdingsKeywords.some(hk => w.includes(hk)));
        if (hasTurbo && hasHoldings) {
          turboHoldingsRow = rows[i];
          break;
        }
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
    ? extractTickersNearLabel({ rows, labelRow: groHoldingsRow, windowBounds, lexicon, portfolio: 'GRO', ocrText: ocr.text }).tickers
    : [];

  // Step 7: Extract TURBO tickers
  const turboTickers = turboHoldingsRow
    ? extractTickersNearLabel({ rows, labelRow: turboHoldingsRow, windowBounds, lexicon, portfolio: 'TURBO', ocrText: ocr.text }).tickers
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
      // Skip rows that contain GRO label — the TURBO action row search can
      // accidentally match the GRO action row (RVAB below GRO HOLDINGS) when
      // Tesseract doesn't produce a distinct TURBO action row.
      const hasGroLabel = findKeywordWordsInRow(rows[i], /\bGRO\b/i).length > 0;
      if (!hasGroLabel && findKeywordWordsInRow(rows[i], /\b(RVAB|REBAR)\b/i).length > 0) {
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
