'use strict';

// Pure parser for the Qullamaggie-style "position list overlay" that sits in
// the bottom-right corner of a streamed chart frame. The OCR pipeline hands
// us raw OCR text + per-word positions (from Tesseract TSV output) +
// region-cropped pixels; this function emits a sorted list of tickers.
//
// Filtering layers (most strict first):
//   1. STRICT_TICKER_PATTERN — must look like an uppercase ticker (1-5 chars,
//      starts with a letter, optional `.X` class share suffix like BRK.A).
//   2. Position-list-aware column filter (when ocr.words positions are
//      available): ticker must land in the dominant vertical column
//      (x=348-358 in the 3x-scaled 250px crop) AND have a price/percent
//      token to its RIGHT in the same line. This rejects chart y-axis
//      labels (price-left, ticker-shape-right) which were the dominant
//      source of false positives.
//   3. Lexicon check OR price-nearby check — ticker must either be in the
//      seed lexicon OR have a price token nearby.
//   4. Edit-distance correction (Levenshtein ≤ 2) — only for in-column
//      tokens. Chart text outside the column is rejected outright; running
//      correction on it produces random ticker-shaped false positives
//      (BS→BE, IN→ON, SYM→SPYM, etc.).
//
// Single-letter tickers (X, U, F, etc.) are allowed in the column filter —
// they're legitimate GT tickers (e.g. "X" = US Steel, "U" = Unity). The
// column filter rejects them when they appear outside the position-list
// column (chart text) so they don't get edit-distance-corrected to other
// tickers (A→U, I→LI). In-column single-letter tokens are accepted if
// they pass the price-nearby check.
//
// When ocr.words positions are NOT provided (legacy callers, test fixtures),
// the parser falls back to the legacy behavior: price-nearby + lexicon +
// edit-distance on all tokens. This keeps older callers working without
// requiring them to thread TSV positions.
//
// This deliberately does NOT reimplement the GRO/TURBO parser — chart-stream
// videos don't have a portfolio summary, just ticker positions.

const { extractTickersFromOcrText, loadSeedLexiconSync, clearTickerScanCache } = require('../normalize/tickerScan');
const { STRICT_TICKER_PATTERN } = require('../normalize/tickerExtraction');

const fs = require('node:fs');
const path = require('node:path');

// Tickers that appear frequently in OCR output but never in ground truth.
// Applied at three levels: per-frame accepted list, clusterer canonical filter,
// and the final merged_position_list output. Add new entries only after
// confirming zero GT hits across all 40+ GT videos.
//
// NOTE: P, SPYM, BKR, BOIL were previously blocklisted but are real tickers
// and should NOT be removed from the lexicon. They are here for documentation
// only.
//
// ATR (Average True Range) is NOT a ticker at all — it is the indicator label
// rendered at the bottom of every chart in every video. It surfaced as a false
// positive in 4 GT dates (20230602/20230605/20230608/20230609) purely because it
// sits inside the crop with numbers around it. Do not re-add it to the lexicon
// on the grounds that "ATR is a real ticker" — it is a real ticker symbol, just
// never a position on Qullamaggie's list.
const TICKER_BLOCKLIST = new Set(['FREY', 'ATR']);

// Maximum edit distance for OCR character correction. Tested 3 on 2026-09-29
// (might catch GOVX→"BGO" which needs 3 edits) — added FPs to non-peak frames
// without helping peak recall. Reverted to 2.
const MAX_OCR_EDIT_DISTANCE = 2;
const SINGLE_LETTER_TICKERS = new Set([
  'A', 'C', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W',
  'X', 'Y', 'Z',
]);

// Matches OCR-split prices:  $ 412.50  ($ split from digits by whitespace)
// Also matches:  $412.50,  412.50,  HIGH/LOW/CLOSE/TARGET/STOP/BID/ASK
const PRICE_TOKEN_PATTERN = /\$\s*\d+(?:\.\d+)?|\d+\.\d+|\b(?:high|low|close|target|stop|bid|ask)\b/i;

// Curated OCR-confusion aliases: garbled form -> canonical ticker.
//
// Needed because a systematic misread can land on ANOTHER VALID ticker, in
// which case neither the lexicon check nor edit-distance correction fires —
// `findCloseTickerMatch` returns null for anything already in the lexicon, so
// the garble is emitted verbatim and counts as a false positive while the real
// ticker counts as a miss.
//
// Every entry here is mined from measured output, not guessed: each garbled
// form appeared as a false positive and its canonical counterpart was in the
// same frame's ground truth. They all encode the same two overlay-font
// confusions — Q rendered as O, and T rendered as I.
//
// Applied ONLY to tokens that landed in the position-list column, so a
// coincidental match in chart text is never rewritten.
//
// Sourced from config/ticker_ocr_confusions.csv.
const OCR_CONFUSION_CSV = path.resolve(__dirname, '..', '..', 'config', 'ticker_ocr_confusions.csv');
let cachedConfusionMap = null;
function loadOcrConfusionMap() {
  if (cachedConfusionMap) return cachedConfusionMap;
  const map = new Map();
  try {
    const raw = fs.readFileSync(OCR_CONFUSION_CSV, 'utf8');
    let isHeader = true;
    for (const line of raw.split(/\r?\n/)) {
      if (isHeader) {
        isHeader = false;
        if (/^garbled\s*,/i.test(line)) continue;
      }
      const [garbled, canonical] = line.split(',').map((v) => String(v || '').trim().toUpperCase());
      if (garbled && canonical && garbled !== canonical) map.set(garbled, canonical);
    }
  } catch {
    // Missing config is not fatal — the parser just loses alias repair.
  }
  cachedConfusionMap = map;
  return map;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Levenshtein distance between two strings (case-insensitive)
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Given a ticker-shaped OCR token, find the closest matching ticker in the seed
// lexicon within MAX_OCR_EDIT_DISTANCE edits. Returns null if no close match
// or if the token is already in the lexicon (exact match is not a correction).
function findCloseTickerMatch(token, lexicon) {
  const upper = token.toUpperCase();
  if (lexicon.tickerSet.has(upper)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const ticker of lexicon.tickers) {
    const dist = levenshtein(upper, ticker);
    if (dist > MAX_OCR_EDIT_DISTANCE) continue;
    // Prefer strictly smaller distance. On equal distance, prefer the longer
    // ticker (more specific: NFLX over BTU at distance 2 from NFU). This
    // matters for tokens like NFU/NFL/INT/INA where the right answer has
    // an extra character the OCR dropped.
    if (dist < bestDist || (dist === bestDist && (best == null || ticker.length > best.length))) {
      bestDist = dist;
      best = ticker;
    }
  }
  return best;
}

function countTickerOccurrences(ocrText) {
  const counts = new Map();
  for (const token of String(ocrText || '').split(/[\s,;:()\[\]{}<>\/\\|]+/)) {
    // Strip leading/trailing | (blue flag merges with tickers: |WEAT→WEAT, KWEB|→KWEB)
    const stripped = String(token || '').replace(/^\|+|\|+$/g, '');
    const cleaned = stripped.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned) continue;
    counts.set(cleaned, (counts.get(cleaned) || 0) + 1);
  }
  return counts;
}

function hasPriceNear(ocrText, ticker) {
  if (!ocrText) return false;
  // Search for the ticker as a whole word; accept up to 25 trailing chars
  // (the OCR frequently splits dollar prices from the symbol, e.g. "GOVX | +1827%").
  // Supports both dot-decimals (14.86) and comma-decimals (7,36) which EasyOCR
  // commonly produces on non-US keyboards.
  // Supports:
  //   $412       — dollar amount
  //   14.86      — dot-decimal (US format)
  //   7,36       — comma-decimal (European format, no trailing decimal)
  //   7,36.50    — comma-decimal with trailing decimal
  //   +1827%     — percent change
  //   HIGH/LOW/CLOSE/etc. — financial keywords
  const proximityPattern = new RegExp(
    `\\b${ticker}\\b[^A-Z0-9.]{0,25}(`
      + `\\$\\s*\\d|`
      + `\\d+(?:[.,]\\d+)+(?:\\.\\d+)?|`
      + `\\b\\d{4,6}\\b|`                       // bare 4-6 digit price (e.g. 28M → 28M is not, but 28 alone could be)
      + `\\b(?:HIGH|LOW|CLOSE|TARGET|STOP|BID|ASK)\\b|`
      + `[+-]\\d[\\d,]*%|`                      // percent change with % (e.g. +1827%)
      + `[+-]\\d[\\d,]*\\b\\|`                  // percent change with | (e.g. +1238| — EasyOCR renders % as |)
      + `\\|[+-]\\d[\\d,]*%`                    // percent change with | BEFORE ticker (e.g. |+1238%)
      + `)`,
    'i'
  );
  return proximityPattern.test(ocrText);
}

// Position-list-aware filter: given the per-word OCR positions (from TSV),
// identify the dominant "ticker column" by finding the x-coordinate where the
// most ticker-shaped words cluster. The Qullamaggie position list is a tight
// vertical column (typically ~5% of frame width; ~50px in the 3x-scaled crop)
// while chart text is scattered across x. Words that look like tickers but
// land outside this column are flagged as chart-area false positives.
//
// Key discriminator: real position list rows have the ticker LEFT of its
// price/percent tokens ("BOIL | +1.45% | +0.7%"), while chart y-axis labels
// have the price LEFT and any ticker-shape words to the right
// ("25.00 | Bs | 8+"). We require that a price/percent token appears to the
// RIGHT of the ticker on the same line. Single-letter tokens ("A", "I")
// cannot be reliably localized and are rejected entirely — they cause too
// many edit-distance corrections (A→U, I→LI, etc.).
//
// Panel boundaries: when the OCR has detected the "A-Positions" header
// (fuzzy-matched from "A -Positionsy" / "A -Positionsv" etc.) we restrict
// the column detection to lines BETWEEN that header and the "WatchList"
// panel below. This excludes the Personal WatchList panel rows from the
// accepted set — they share the position list's x-range and same row shape,
// so the column filter alone cannot distinguish them.
//
// Returns { inListTickers: Set<string>, dominantColumnX, columnWidth }
function findPanelBoundaries(words) {
  // Returns { positionsLine, watchlistLine, topBoundary, bottomBoundary }.
  // `topBoundary` is the line number of the "A-Positions" header (only
  // ticker-shaped words on lines >= topBoundary are considered).
  // `bottomBoundary` is the line number of the "WatchList" header (only
  // ticker-shaped words on lines < bottomBoundary are considered).
  // Returns nulls if no keywords detected.
  let positionsLine = null;
  let watchlistLine = null;
  for (const w of words) {
    const upper = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!upper) continue;
    if (positionsLine == null && /POSITIONS|POSTNS|POSITON|POSITN|PSTNS|POSITIO/.test(upper)) {
      positionsLine = w.line;
    }
    // Expanded watchlist variants: WATCHLIST garbles into many shapes on dark/bright frames.
    // Covers: WATCH, WATCHLIST, PERSONAL, WANCR, MAHL, PENAL, PENOR, and common OCR confusions.
    if (watchlistLine == null && /WATCH|PENAL|PENOR|WANCR|MAHL|PERSNAL|PERSONAL|PERSN|PERSNL|PESONL|WATCHIST/.test(upper)) {
      watchlistLine = w.line;
    }
  }
  return { positionsLine, watchlistLine };
}

function identifyPositionListColumn(words, cropWidth = null, engine = null) {
  if (!Array.isArray(words) || !words.length) {
    return { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };
  }

  // Detect panel boundaries via keyword matching. If both headers found,
  // restrict ticker-word collection to lines inside [positionsLine+1, watchlistLine).
  // This excludes chart text above and the Personal WatchList panel below.
  //
  // The watchlist bound only applies when the watchlist header is BELOW the
  // positions header. On some frames a stray "Watch..." token (a chat
  // overlay, a streamer name) is picked up above the panel; using it as a
  // lower bound then rejects every row, because every position-list row is
  // below that line.
  const { positionsLine, watchlistLine } = findPanelBoundaries(words);
  const watchlistBelowPositions = watchlistLine != null
    && (positionsLine == null || watchlistLine > positionsLine);
  const lineIsInPanel = (line) => {
    if (positionsLine != null && line <= positionsLine) return false;
    if (watchlistBelowPositions && line >= watchlistLine) return false;
    return true;
  };

  // For each line: collect right-side price/percent tokens (x > ticker.right).
  // Real position list rows have the price token to the RIGHT of the ticker;
  // chart y-axis labels have the price on the LEFT and the ticker-shape word
  // on the RIGHT (the opposite direction).
  const lineRightHasPrice = new Map();
  for (const w of words) {
    if (lineRightHasPrice.has(w.line)) continue;
    const sameLineWords = words.filter(x => x.line === w.line);
    const lineText = sameLineWords.map(x => x.text).join(' ');
    // Look for percent tokens ("+1.45%", "-0.08%") or dollar prices anywhere.
    // Supports comma-decimals (7,36) and dot-decimals (14.86) which EasyOCR
    // produces on non-US keyboards, plus the bare-integer columns the 2022-era
    // QMG UI renders ("374935", "0953"). The bare-integer alternative used to
    // be absent here, which made whole 2022-era position rows fail the
    // price-alignment test and get deleted (NRGU, MOS on 20220218).
    const priceMatches = lineText.match(/[+\-]?\d+(?:[.,]\d+)?\s*%|[+\-]?\d+[.,]\d+|\$\s*\d|\d{2,}/g);
    if (priceMatches && priceMatches.length) {
      const tickerXs = sameLineWords
        .filter(x => STRICT_TICKER_PATTERN.test((x.text||'').toUpperCase().replace(/[^A-Z0-9.]/g,'')))
        .map(x => ({ left: x.left, right: x.left + x.width }));
      // Price tokens to the RIGHT of the ticker. Three UI generations are in
      // the corpus:
      //   - 2022-era: bare integers in separate columns ("374935", "0953")
      //   - 2023-era: comma-decimals ("7,36", "726,78")
      //   - percent / dollar forms ("+1827%", "$412")
      // The bare-integer fallback used to be dropped because chart-axis labels
      // (3500, 700) counted as "price" and let chart tokens in. That is now
      // handled structurally by the column gate in parseChartStreamPositionList:
      // a chart-axis token is not in the position-list column, so it is rejected
      // regardless of what sits to its right. Re-admitting bare integers is what
      // lets 2022-era rows (NRGU, MOS) survive — they were being dropped whole.
      const priceWords = sameLineWords.filter(x => /[%\$]|^\d+(?:[.,]\d+)*$/.test(x.text));
      let maxTickerLeft = Math.max(0, ...tickerXs.map(t => t.left));
      let minPriceRight = Infinity;
      for (const p of priceWords) {
        if (p.left > maxTickerLeft) {
          minPriceRight = Math.min(minPriceRight, p.left);
        }
      }
      lineRightHasPrice.set(w.line, minPriceRight !== Infinity);
    } else {
      lineRightHasPrice.set(w.line, false);
    }
  }

  // Collect ticker-shaped tokens (length >= 2) with their x positions,
  // but ONLY those whose line has a price-on-right pattern. These are
  // strong "position list row" candidates — chart header words (SYM,
  // Cran, Pre, Buzz, Last, Sorted) don't have prices to their right, so
  // they're excluded from the column-finding step. This avoids the
  // ambiguity where chart-header words land at the same x as the ticker
  // column (e.g. SYM at x=177 ties with TSLA at x=179 in the same bucket).
  //
  // Also filter by panel boundary when keywords were detected: only
  // consider words on lines between the "A-Positions" header and the
  // "WatchList" panel header. This excludes the Personal WatchList panel
  // below the position list (which has the same row shape and x-range,
  // and would otherwise leak through as FPs).
  const priceAlignedTickers = [];
  const tickerWords = [];
  for (const w of words) {
    const upper = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!upper) continue;
    if (!STRICT_TICKER_PATTERN.test(upper)) continue;
    if (!lineIsInPanel(w.line)) continue;
    const center = w.left + w.width / 2;
    const entry = {
      center,
      line: w.line,
      right: w.left + w.width,
      text: upper
    };
    tickerWords.push(entry);
    if (lineRightHasPrice.get(w.line)) {
      priceAlignedTickers.push(entry);
    }
  }
  // Note: do NOT early-return on <3 ticker-shape words. A sparse position list
  // (e.g. 2 tickers visible) is still legitimate. The priceAlignedTickers /
  // densest-bucket fallback below handles the column-detection case, and the
  // caller (parseChartStreamPositionList) falls back to lexicon+price-nearby
  // when no column can be confidently identified.

  // Determine the column center. Prefer the median x of price-aligned
  // tickers (these are real position list rows); fall back to the densest
  // bucket of all ticker-shape words if not enough price-aligned candidates.
  let dominantX;
  let dominantCount;
  // Whether the column was found by price alignment (strong evidence) or by
  // the densest-bucket fallback (weak evidence). Only the weak path is
  // subject to the X-coordinate gate below.
  let columnIsPriceAligned = false;
  if (priceAlignedTickers.length >= 1) {
    const xs = priceAlignedTickers.map(t => t.center).sort((a, b) => a - b);
    dominantX = xs[Math.floor(xs.length / 2)];
    dominantCount = priceAlignedTickers.length;
    columnIsPriceAligned = true;
  } else {
    // Fallback to densest-bucket heuristic (preserves previous behavior for
    // frames where no line has a clear price-on-right pattern).
    const bucketWidth = 20;
    const buckets = new Map();
    for (const tw of tickerWords) {
      const bucket = Math.floor(tw.center / bucketWidth) * bucketWidth;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    const sortedBuckets = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
    const topBucket = sortedBuckets[0];
    if (!topBucket || topBucket[1] < 2) {
      return { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };
    }
    dominantX = topBucket[0] + bucketWidth / 2;
    dominantCount = topBucket[1];
  }

  // Column width in the scaled OCR image. Position list tickers cluster
  // in a narrow vertical column (~10px in the 3x-scaled 250px crop), but
  // different OCR engines (Tesseract vs EasyOCR) place word bounding boxes
  // at different x-centers for the same visual token. 50px is wide enough
  // to accommodate both engines while still excluding chart-area text (axis
  // labels, candle wicks) which lands well outside this window.
  const columnWidth = 50;

  // inListTickers: ticker-shaped words that sit in the dominant column.
  //
  // Column membership is the primary structural signal — chart-area text
  // (y-axis labels at the far left, header words Sym/Pre/Buzz at other x)
  // simply is not in this column. Price-on-right used to be a REQUIRED
  // co-condition, but it is format-specific and silently deleted whole
  // position rows on the 2022-era UI where prices render as bare integers
  // ("374935") rather than decimals ("726,78") or percents. On 20220218 that
  // requirement dropped NRGU and MOS — both real GT tickers the OCR read
  // perfectly. Prefer price-aligned rows, but fall back to pure column
  // membership when the price heuristic finds too few of them.
  const columnMembers = tickerWords.filter(
    (tw) => Math.abs(tw.center - dominantX) <= columnWidth / 2
  );
  const priceAlignedMembers = columnMembers.filter((tw) => lineRightHasPrice.get(tw.line));
  const inListTickers = new Set(
    (priceAlignedMembers.length >= 3 ? priceAlignedMembers : columnMembers).map((tw) => tw.text)
  );

  // X-coordinate gate: the QMG position list occupies the rightmost portion of
  // the frame (crop x=0.86 → position list starts at ~86% of crop width).
  // When the fallback densest-bucket heuristic fires (no price-aligned tickers),
  // dominantX often lands in the chart area (~790 in the 3x crop = ~790/3 ≈ 526
  // in the original), producing massive FP bleed. Reject any column whose
  // dominantX is below the position-list threshold.
  //
  // The gate applies to the FALLBACK path only. A column found by price
  // alignment is already validated by a price sitting to the right of the
  // ticker on the same row, and its x position varies between videos
  // (measured: 20220218 → x≈710, 20220606 → x≈444, both in a 1345px EasyOCR
  // crop). Gating those on an absolute pixel threshold silently dropped
  // every ticker on 20220606 while the column detector was working
  // perfectly.
  //
  // Per-engine thresholds (px, in the OCR crop coordinate space), from
  // empirical measurements on real runs:
  // - Tesseract (750px crop): dominantX ≈ 460px for position-list tickers → 505
  // - EasyOCR  (1344px crop): dominantX ≈ 780px for position-list tickers → 600
  //   (safe: 600 < 780, and chart-area dominantX ≈ 400-500 in EasyOCR crops)
  //
  // Confidence gate: is `dominantX` a genuine stacked position-list column?
  //
  // An absolute x-coordinate threshold cannot work here. Qullamaggie moved the
  // panel between video eras and the crop width changed with it, so no fixed px
  // value survives both ends of the corpus:
  //   - 2022-era, crop w=0.14 (1344px wide): position column at x≈777
  //   - 2023-era, crop w=0.17 (1632px wide): position column at x≈575
  // A threshold of 600 passes the first and rejects the second; 500 does the
  // reverse. Either way the whole column filter is silently disabled on one era
  // (the log shows `col_filter: null`, which is the tell).
  //
  // So test the SHAPE rather than the position. A real position list is a tight
  // vertical stack: several ticker-shaped words inside one narrow x-window,
  // spread down several distinct rows. Chart text and axis labels never stack
  // that way regardless of era or crop.
  //
  // A column that is already price-aligned is trusted outright — those rows
  // have a price token to the right of the ticker, which is the strongest
  // single indicator and costs nothing to check.
  const stackMembers = tickerWords.filter(
    (tw) => Math.abs(tw.center - dominantX) <= columnWidth / 2
  );
  const stackLines = new Set(stackMembers.map((tw) => tw.line));
  const stackIsReal = stackMembers.length >= 4 && stackLines.size >= 4;
  if (!stackIsReal && !(columnIsPriceAligned && priceAlignedTickers.length >= 2)) {
    return { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };
  }

  return { columnWidth, dominantColumnX: dominantX, inListTickers, stackLines: stackLines.size };
}

// Extract ALL ticker-shaped tokens from OCR text (ignores lexicon).
// Used as the primary extraction so we don't miss tickers not in the seed lexicon.
function extractAllTickerCandidates(ocrText) {
  const tokens = String(ocrText || '').split(/[\s,;:()\[\]{}<>\/\\|]+/);
  const seen = new Set();
  const results = [];
  for (const token of tokens) {
    // Strip leading/trailing | (blue flag merges with tickers: |WEAT→WEAT, KWEB|→KWEB)
    const stripped = String(token || '').replace(/^\|+|\|+$/g, '');
    const cleaned = stripped.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    if (STRICT_TICKER_PATTERN.test(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

function extractZoomStripTickerCandidates(zoomOcr, lexicon) {
  if (!zoomOcr) return [];

  const seen = new Set();
  const accepted = [];
  const maybeAdd = (rawToken, confidence = 0) => {
    const cleaned = String(rawToken || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!cleaned || !STRICT_TICKER_PATTERN.test(cleaned)) return false;
    if (cleaned.length === 1 && !SINGLE_LETTER_TICKERS.has(cleaned)) return false;
    if (/\d/.test(cleaned)) return false;
    if (lexicon.tickerSet.has(cleaned)) {
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        accepted.push({ source: 'exact', ticker: cleaned });
      }
      return true;
    }
    if (cleaned.length < 3) return false;
    if (Number.isFinite(confidence) && confidence > 0 && confidence < 0.45) return false;
    const correction = findCloseTickerMatch(cleaned, lexicon);
    const correctionDistance = correction ? levenshtein(cleaned, correction) : Infinity;
    if (correction && correctionDistance <= 1 && !seen.has(correction)) {
      seen.add(correction);
      accepted.push({ raw: cleaned, source: 'corrected', ticker: correction });
      return true;
    }
    return false;
  };

  const words = Array.isArray(zoomOcr.words) ? zoomOcr.words : [];
  if (words.length) {
    const wordsByLine = new Map();
    for (const word of words) {
      const line = Number.isFinite(word.line) ? word.line : 0;
      if (!wordsByLine.has(line)) wordsByLine.set(line, []);
      wordsByLine.get(line).push(word);
    }
    for (const [, lineWords] of [...wordsByLine.entries()].sort((a, b) => a[0] - b[0])) {
      lineWords.sort((left, right) => Number(left.left || 0) - Number(right.left || 0));
      const tickerWords = lineWords.filter((word) => {
        const cleaned = String(word.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
        return cleaned && STRICT_TICKER_PATTERN.test(cleaned) && !/\d/.test(cleaned);
      });
      for (const word of tickerWords.slice(0, 2)) {
        if (maybeAdd(word.text, Number(word.conf || 0))) {
          break;
        }
      }
    }
  }

  if (!accepted.length && zoomOcr.text) {
    for (const token of String(zoomOcr.text).split(/[\s,;:()\[\]{}<>\/\\|]+/)) {
      maybeAdd(token);
    }
  }

  return accepted;
}

function parseChartStreamPositionList({ ocr } = {}) {
  const text = normalizeWhitespace(ocr && ocr.text ? ocr.text : '');
  const lines = Array.isArray(ocr && ocr.lines) ? ocr.lines : [];
  const words = Array.isArray(ocr && ocr.words) ? ocr.words : [];

  if (!text) {
    return {
      confidence: 0,
      parse_status: 'no_ocr',
      ocr_executed: false, // distinguishes "OCR did not run" from "OCR ran but found nothing"
      position_list: [],
      price_action: '',
      tickers_rejected: 0
    };
  }

  clearTickerScanCache();
  const lexicon = loadSeedLexiconSync();

  // Position-list-aware column filter: identify the dominant ticker column
  // and only keep ticker-shaped words that fall inside it. This eliminates
  // chart-area false positives (axis labels like "26.00", "Arith", chart
  // annotations like "A-P@Bsym") that the lex+price-nearby filter would
  // otherwise let through. scaledWidth=750 for the 3x-scaled 250px crop.
  //
  // When no word positions are provided (e.g. legacy callers or test
  // fixtures), `inListTickers` stays empty and we fall back to the legacy
  // price-nearby + lexicon + edit-distance behavior so existing callers
  // keep working.
  const hasWordPositions = words && words.length > 0;
  const { inListTickers, dominantColumnX, columnWidth } = hasWordPositions
    ? identifyPositionListColumn(words, ocr._cropWidth || null, ocr._engine || null)
    : { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };

  // Build per-ticker line + word lookups from raw OCR word positions.
  // - tickerLineMap: ticker → array of line indices (used by Filter G)
  // - tickerWordMap: ticker → first raw word record with bbox (used by Filter B)
  // These are skipped when the OCR engine does not surface per-word positions.
  const tickerLineMap = new Map();
  const tickerWordMap = new Map();
  if (hasWordPositions) {
    for (const w of words) {
      const upper = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!upper || !STRICT_TICKER_PATTERN.test(upper)) continue;
      if (Number.isFinite(w.line)) {
        if (!tickerLineMap.has(upper)) tickerLineMap.set(upper, []);
        tickerLineMap.get(upper).push(w.line);
      }
      if (!tickerWordMap.has(upper)) tickerWordMap.set(upper, w);
    }
  }

  // Panel-line reject gate (Filter G).
  // The parser already detects `positionsLine` and `watchlistLine` via
  // `findPanelBoundaries` and uses `lineIsInPanel` to RESTRICT word
  // collection in the column detector. The gap (in the prior parser) was
  // that a token that passes the in-lexicon OR price-nearby check was
  // accepted regardless of whether its line was inside the position-list
  // panel. This is the one-line reject at the accept point that fixes it.
  //
  // Safety: only active when BOTH boundaries are detected. Partial
  // detection (e.g. only positionsLine, but not watchlistLine) is
  // unreliable — the regex matches POSITON/POSTNS/MALH variants on
  // dark frames, and a mis-detected boundary could either let FPs through
  // or kill real tickers. When gate detection fails, fall back to the
  // pre-Filter-G behavior (accept based on lexicon + price-nearby).
  const { positionsLine, watchlistLine } = hasWordPositions
    ? findPanelBoundaries(words)
    : { positionsLine: null, watchlistLine: null };
  // The gate needs the watchlist header to sit BELOW the positions header.
  // A "Watch..." token picked up above the panel (chat overlay, streamer
  // name) would otherwise act as a lower bound and reject every real row.
  const panelGateActive = positionsLine != null
    && watchlistLine != null
    && watchlistLine > positionsLine;
  // Partial boundary heuristic: when only one boundary is detected, use y-coordinates
  // to estimate the other. The position list is typically 10-15 rows tall; if we
  // detect positionsLine but not watchlistLine, reject rows far below it.
  // Estimate row height from the vertical spacing of ticker-shaped words.
  let impliedBottomLine = null;
  if (positionsLine != null && watchlistLine == null) {
    // Collect top-y values of ticker-shaped words below positionsLine to estimate row height.
    const tickerTopsBelow = [];
    for (const w of words) {
      const upper = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!upper || !STRICT_TICKER_PATTERN.test(upper)) continue;
      if (w.line > positionsLine && w.line < positionsLine + 30) {
        tickerTopsBelow.push({ line: w.line, top: Number(w.top || 0) });
      }
    }
    if (tickerTopsBelow.length >= 2) {
      // Sort by line, compute median row height from consecutive pairs.
      tickerTopsBelow.sort((a, b) => a.line - b.line);
      const heights = [];
      for (let i = 1; i < tickerTopsBelow.length; i++) {
        const dy = tickerTopsBelow[i].top - tickerTopsBelow[i - 1].top;
        const dl = tickerTopsBelow[i].line - tickerTopsBelow[i - 1].line;
        if (dl > 0) heights.push(dy / dl);
      }
      const medianRowHeight = heights.length ? heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] : 52;
      // Max 15 rows below positionsLine — watchlist typically starts after that.
      impliedBottomLine = positionsLine + Math.round(15 * 52 / medianRowHeight);
    }
  }
  const lineIsInPanel = (line) => {
    if (!panelGateActive && impliedBottomLine == null) return true;
    if (positionsLine != null && line <= positionsLine) return false;
    if (panelGateActive && watchlistLine != null && line >= watchlistLine) return false;
    if (impliedBottomLine != null && line >= impliedBottomLine) return false;
    return true;
  };

  // Primary extraction: ALL ticker-shaped tokens (no lexicon filter)
  const allCandidates = extractAllTickerCandidates(text);

  if (!allCandidates.length) {
    return {
      confidence: 0,
      parse_status: 'no_ticker_shapes',
      ocr_executed: true, // OCR ran; no ticker-shaped tokens survived
      position_list: [],
      price_action: '',
      tickers_rejected: 0
    };
  }

  const occurrenceCounts = countTickerOccurrences(text);
  // Column gate is a whole-frame decision (does the detector trust its own
  // column?), so compute it once here rather than per token.
  const columnGateActive = dominantColumnX != null && inListTickers.size >= 3;
  const accepted = [];
  const rejected = [];
  // canonicalToRawTicker: when edit-distance correction produces a canonical
  // (e.g. INA → TNA), record which raw token produced it so Filter B can
  // look up the right bounding box.
  const canonicalToRawTicker = new Map();
  for (const ticker of allCandidates) {
    const priceNearby = hasPriceNear(text, ticker);
    const inLexicon = lexicon.tickerSet.has(ticker);
    if (!hasWordPositions) {
      // Legacy path: no word positions. Use the original behavior —
      // accept if in lexicon OR price-nearby, edit-distance-correct otherwise.
      if (inLexicon || priceNearby) {
        accepted.push(ticker);
      } else {
        const correction = findCloseTickerMatch(ticker, lexicon);
        if (correction && !accepted.includes(correction)) {
          canonicalToRawTicker.set(correction, ticker);
          accepted.push(correction);
        } else {
          rejected.push(ticker);
        }
      }
      continue;
    }
    // Position-list-aware filter: require the ticker to be in the dominant
    // ticker column when the column detector is confident.
    //
    // The `inLexicon || priceNearby` branch used to accept column-agnostically.
    // That leaks badly on EasyOCR frames because `hasPriceNear` matches against
    // the ENTIRE flattened OCR text: a ticker at the end of one line happily
    // matches a price at the start of the next line, so every ticker in the
    // frame looks "price-nearby" and chart-header noise (BROS, ONKS, FX)
    // walks straight in. Verified on 20220218: precision fell 86% → 40%.
    //
    // The column filter is the structural signal that actually distinguishes a
    // position-list row from chart noise — real rows put the ticker in a tight
    // vertical column with a price to its right. Gate on it whenever the
    // detector found a column with enough evidence (>= 3 in-list tokens), and
    // fall back to the old column-agnostic behaviour when it did not, so
    // sparse/garbled frames are not penalised.
    // In the dominant column but NOT in the lexicon: this is almost certainly
      // an OCR garble of a real ticker, so run edit-distance correction FIRST
      // and only fall back to accepting the raw token. Previously the
      // `inLexicon || priceNearby` test came first, and because hasPriceNear
      // scans the whole flattened text it fired on nearly every token — so
      // garbles were accepted verbatim (FX for FCX, TTOCQ for TQQQ) and never
      // reached the corrector below.
      const inListColumn = inListTickers.has(ticker);
      if (columnGateActive && !inListColumn && !(inLexicon && inListTickers.size >= 6)) {
        // Column detector is confident and this token is not a position-list row.
        // Reject it before the lexicon/price-nearby path can admit it.
        rejected.push(ticker);
        continue;
      }
      if (inLexicon || priceNearby) {
      // Filter G: panel-line reject gate. If panel boundaries were
      // detected, reject any ticker whose ONLY occurrences have lines
      // outside the position-list panel (chart-area above the panel, or
      // Personal WatchList panel below the panel). A ticker with at
      // least one in-panel occurrence is kept — this handles the 1-2
      // frame transition case where a watchlist row overlaps the
      // position list briefly.
      if (panelGateActive) {
        const linesForTicker = tickerLineMap.get(ticker);
        const inPanel = linesForTicker && linesForTicker.some((l) => lineIsInPanel(l));
        if (!inPanel) {
          rejected.push(ticker);
          continue;
        }
      }
      // Lexicon match OR price-nearby: accept.
      // Chart-area text like "Arith", "Sym", "Cran" doesn't match the
      // seed lexicon so it stays rejected.
      accepted.push(ticker);
    } else if (inListColumn) {
      // In the position-list column, but neither a known ticker nor
      // price-nearby. The column gate has already established this is a real
      // row, so this is a ticker missing from the seed lexicon rather than
      // chart noise — accept it as read rather than discard it. (MOS on
      // 20220218 was being dropped here, costing a real GT hit.)
      accepted.push(ticker);
    } else {
      rejected.push(ticker);
    }
  }

  // Post-pass: repair garbled in-column tickers.
  //
  // A token that landed in the position-list column but is NOT in the lexicon
  // is almost certainly an OCR garble of a real ticker (FX→FCX, TTOCQ→TQQQ,
  // TSUA→TSLA). hasPriceNear scans the whole flattened text so these tokens
  // were already accepted verbatim on the branch above and never reached the
  // edit-distance corrector. Correct them here, but only at distance 1 and
  // only when the correction is unambiguous — at distance 2 findCloseTickerMatch
  // starts inventing tickers (UPST→KLAC, DWAC→SPOT), which costs more recall
  // than the repair gains.
  if (columnGateActive) {
    const confusionMap = loadOcrConfusionMap();
    for (let i = accepted.length - 1; i >= 0; i -= 1) {
      const raw = accepted[i];
      if (!inListTickers.has(raw)) continue;
      // Curated confusion alias first — this is the only path that can repair a
      // garble that happens to BE a valid ticker (AROQ→ARQQ, IOI→IOT).
      const aliased = confusionMap.get(raw);
      if (aliased && lexicon.tickerSet.has(aliased) && !accepted.includes(aliased)) {
        canonicalToRawTicker.set(aliased, raw);
        accepted[i] = aliased;
        continue;
      }
      if (lexicon.tickerSet.has(raw)) continue;
      let best = null;
      let bestDist = Infinity;
      for (const candidate of lexicon.tickers) {
        if (Math.abs(candidate.length - raw.length) > 1) continue;
        const dist = levenshtein(raw, candidate);
        if (dist < bestDist || (dist === bestDist && candidate.length > best.length)) {
          bestDist = dist;
          best = candidate;
        }
      }
      if (best && bestDist === 1 && !accepted.includes(best)) {
        canonicalToRawTicker.set(best, raw);
        accepted[i] = best;
      }
    }
  }

  // Filter B: position-aware bounding-box y-range filter.
  // Real position-list tickers share a consistent y-range (one row per
  // ticker in the position-list column). Chart-area tokens (NVDA on a
  // chart-axis label, AMD/INTC/MU in a sub-plot annotation, MSTR/COIN
  // bleeding from chart overlay) have bboxes that fall outside this
  // range. Compute the median y-center of accepted tickers' bboxes
  // and reject any ticker whose y-center falls outside [yMedian - 2*lineHeight,
  // yMedian + 2*lineHeight].
  //
  // Requires at least 2 accepted tickers to compute median. Falls back
  // to skipping the filter when fewer accepted tickers exist (rare —
  // these are sparse single-ticker frames where position-aware filtering
  // would be unreliable).
  let bboxFilterInfo = null;
  if (hasWordPositions && accepted.length >= 2) {
    const acceptedBboxes = [];
    for (const ticker of accepted) {
      const rawTicker = canonicalToRawTicker.get(ticker) || ticker;
      const w = tickerWordMap.get(rawTicker);
      if (w && Number.isFinite(w.top) && Number.isFinite(w.height) && w.height > 0) {
        acceptedBboxes.push({ ticker, yCenter: w.top + w.height / 2 });
      }
    }
    if (acceptedBboxes.length >= 2) {
      const ys = acceptedBboxes.map((b) => b.yCenter).sort((a, b) => a - b);
      const yMedian = ys[Math.floor(ys.length / 2)];
      const lineHeights = words
        .filter((w) => Number.isFinite(w.height) && w.height > 0)
        .map((w) => w.height)
        .sort((a, b) => a - b);
      const lineHeight = lineHeights.length
        ? lineHeights[Math.floor(lineHeights.length / 2)]
        : 20;  // fallback for sparse words
      // Position lists are sorted by market cap (largest → smallest, top → bottom
      // of the UI panel). The tickers form a contiguous vertical stack with
      // roughly equal spacing. Use ±8×lineHeight (~448px for lineHeight=56)
      // as the accept range around the median y-center. Calibrated on the 20230518
      // case where position-list tickers span 744-1314px (PLTR at top, APLD at
      // bottom) — ±8× gives yMin=665, yMax=1561, accepting all GT tickers.
      // A tighter ±2× range (~112px) clipped the top and bottom rows of the
      // position list, losing 15-25% of tickers. The wider range comfortably
      // covers 10+ row position lists. Chart-area bleed FPs that land outside
      // this range are handled by the lexicon filter and clusterer.
      const yMin = yMedian - 8 * lineHeight;
      const yMax = yMedian + 8 * lineHeight;
      const withinBbox = new Set();
      for (const { ticker, yCenter } of acceptedBboxes) {
        if (yCenter >= yMin && yCenter <= yMax) {
          withinBbox.add(ticker);
        } else {
          rejected.push(ticker);
        }
      }
      // Re-filter accepted in place, preserving order
      for (let i = accepted.length - 1; i >= 0; i -= 1) {
        if (!withinBbox.has(accepted[i])) {
          accepted.splice(i, 1);
        }
      }
      bboxFilterInfo = {
        y_median: yMedian,
        line_height: lineHeight,
        y_min: yMin,
        y_max: yMax,
        rejected_count: acceptedBboxes.length - withinBbox.size
      };
    }
  }

  const structuredSupportPool = new Set(accepted);
  for (const ticker of inListTickers) structuredSupportPool.add(ticker);
  for (const [ticker, linesForTicker] of tickerLineMap.entries()) {
    if (!panelGateActive || (linesForTicker && linesForTicker.some((line) => lineIsInPanel(line)))) {
      structuredSupportPool.add(ticker);
    }
  }
  const structuredSupportCandidates = [...structuredSupportPool];
  const hasMainSupportForZoomTicker = (ticker) => {
    for (const mainCandidate of structuredSupportCandidates) {
      if (mainCandidate === ticker) return true;
      if (Math.abs(mainCandidate.length - ticker.length) <= MAX_OCR_EDIT_DISTANCE
          && levenshtein(mainCandidate, ticker) <= MAX_OCR_EDIT_DISTANCE) {
        return true;
      }
      const corrected = findCloseTickerMatch(mainCandidate, lexicon);
      if (corrected === ticker) return true;
    }
    return false;
  };
  const zoomStripInputs = Array.isArray(ocr && ocr.zoomTickerStrips)
    ? ocr.zoomTickerStrips
    : (ocr && ocr.zoomTickerStrip ? [ocr.zoomTickerStrip] : []);
  const rawZoomStripCandidates = zoomStripInputs.flatMap((zoomOcr) => extractZoomStripTickerCandidates(zoomOcr, lexicon));
  const zoomSupport = new Map();
  for (const candidate of rawZoomStripCandidates) {
    const key = `${candidate.source}:${candidate.ticker}`;
    if (!zoomSupport.has(key)) {
      zoomSupport.set(key, { ...candidate, supportCount: 0 });
    }
    zoomSupport.get(key).supportCount += 1;
  }
  const zoomStripCandidates = [...zoomSupport.values()].filter((candidate) => {
    const hasStructuredSupport = hasMainSupportForZoomTicker(candidate.ticker);
    if (candidate.source === 'exact') {
      return candidate.supportCount >= 2 || (candidate.supportCount >= 1 && hasStructuredSupport);
    }
    return candidate.supportCount >= 2 && hasStructuredSupport;
  });
  for (const { ticker } of zoomStripCandidates) {
    if (!accepted.includes(ticker)) {
      accepted.push(ticker);
    }
  }

  const priceActionHint = lines.find((line) => PRICE_TOKEN_PATTERN.test(line)) || '';

  // Confidence: 1.0 when at least 3 tickers accepted AND at least one had a
  // price-nearby signal; 0.5 when 1–2 accepted; 0 otherwise.
  let confidence = 0;
  if (accepted.length >= 3 && accepted.some((t) => hasPriceNear(text, t))) {
    confidence = 1;
  } else if (accepted.length >= 1) {
    confidence = 0.5;
  }

  // Blocklist filter: remove known non-QMG tickers that keep appearing in
  // OCR output with zero GT hits (P, SPYM, FREY, BKR, BOIL). Applied before
  // returning so downstream merge/cluster steps never see them.
  const filteredAccepted = accepted.filter((t) => !TICKER_BLOCKLIST.has(t));

  return {
    column_filter: dominantColumnX != null ? {
      column_width: columnWidth,
      dominant_x: dominantColumnX,
      in_list_token_count: inListTickers.size
    } : null,
    confidence,
    ocr_executed: true, // OCR ran and produced candidates; they were all rejected
    parse_status: filteredAccepted.length ? 'ok' : 'no_position_list',
    position_list: filteredAccepted.sort(),
    price_action: priceActionHint || '',
    // Keep `tickers_rejected` as a number for backward compatibility with
    // scoreChartStreamCandidate in tools/scanVideoWithOcr.js (-0.25 per reject).
    tickers_rejected: rejected.length,
    // Diagnostic: the actual rejected tokens (capped to keep probe logs small).
    // Helps diagnose which chart-text/OCR-garble tokens are leaking into "rejected"
    // status instead of being silently dropped. Was previously only a count.
    tickers_rejected_list: rejected.slice(0, 30),
    // Diagnostic: panel-line reject gate (Filter G) info. `null` when gate was
    // inactive (boundary detection failed or no word positions).
    panel_gate: panelGateActive ? {
      positions_line: positionsLine,
      watchlist_line: watchlistLine,
      active: true
    } : null,
    // Diagnostic: bbox y-range filter (Filter B) info. Populated when the
    // filter ran (at least 2 accepted tickers with bbox info available).
    bbox_filter: bboxFilterInfo
    ,
    zoom_ticker_strip: ocr && ocr.zoomTickerStrip ? {
      candidate_count: zoomStripCandidates.length,
      candidates: zoomStripCandidates.slice(0, 20).map((candidate) => candidate.ticker),
      raw_candidates: rawZoomStripCandidates.slice(0, 20).map((candidate) => candidate.ticker),
      support_counts: zoomStripCandidates.slice(0, 20).map((candidate) => ({
        support_count: candidate.supportCount,
        ticker: candidate.ticker,
      })),
      variants: zoomStripInputs.map((zoomOcr) => zoomOcr.variant || null).filter(Boolean)
    } : null
  };
}

// Multi-frame merge: combine position lists from multiple captures of the
// same video. A ticker is accepted if it appears in at least `minOccurrences`
// of the captures. This dramatically reduces false positives from single-
// frame OCR garbling while preserving recall (real position-list tickers
// are usually detected across multiple frames).
//
// Each input is the result of parseChartStreamPositionList() — a sorted
// array of accepted tickers. Returns a sorted array of merged tickers.
function mergeMultiplePositionLists(positionLists, options = {}) {
  const minOccurrences = Number.isFinite(options.minOccurrences)
    ? options.minOccurrences
    : 2;
  if (!Array.isArray(positionLists) || !positionLists.length) {
    return [];
  }
  // Filter out empty lists (frames where OCR failed entirely)
  const nonEmpty = positionLists.filter((l) => Array.isArray(l) && l.length);
  if (!nonEmpty.length) return [];

  const counts = new Map();
  for (const list of nonEmpty) {
    // Track which tickers were seen in this frame (don't double-count repeats within one frame)
    const seenInFrame = new Set();
    for (const ticker of list) {
      if (seenInFrame.has(ticker)) continue;
      seenInFrame.add(ticker);
      counts.set(ticker, (counts.get(ticker) || 0) + 1);
    }
  }
  const required = Math.max(1, Math.min(minOccurrences, nonEmpty.length));
  return [...counts.entries()]
    .filter(([, count]) => count >= required)
    .map(([ticker]) => ticker)
    .sort();
}

// Multi-frame RAW-OCR token voting.
//
// The existing mergeMultiplePositionLists merges accepted ticker LISTS from
// each frame. That doesn't help when each frame's garbled OCR maps to
// different accepted tickers (BGO in frame 1 → BIIB, Tan in frame 2 → TNA,
// etc.) — the lists have no overlap, the merge is empty.
//
// This function instead collects RAW ticker-shape tokens from each frame's
// OCR text (Tesseract or EasyOCR), groups tokens that are within edit-
// distance ≤ `maxDistance` of each other into clusters, then picks a
// canonical representative per cluster (preferring tokens in the seed
// lexicon, then most-frequent, then alphabetical).
//
// Real position-list tickers appear in EVERY frame under different garbled
// forms (Tan/Tna/TNA/Tna in 5 frames). FPs (e.g., AAPL/BIIB from chart
// annotations) appear once or twice and get outvoted by the cluster that
// has both lexicon match AND higher frequency.
//
// Inputs:
//   `frameTexts` — array of strings (one per frame), each is OCR text.
//   `options`:
//     - `maxDistance` (default 1) — edit distance for clustering. With
//       edit-distance 2, unrelated tokens like ALB↔NFL cluster through
//       shared bridges (INA, NFU) and over-merge. Distance 1 is strict
//       enough that ONLY obvious garbled variants cluster together.
//     - `minTokenLength` (default 2) — drop tokens shorter than this
//     - `minFrequency` (default 2) — Filter A: per-canonical frame
//       count. The cluster must span at least this many distinct frames
//       (union of frame sets across all cluster members). Single-frame
//       OCR garbles (VIO→VLO, NFU→NFLX, INA→TNA, BUCO→UCO) and chart-
//       area tickers that bleed in briefly (MARA/RIOT/HUT/BTBT) appear
//       in only 1 frame and get filtered out at default=2. This is the
//       clusterer counterpart to mergeMultiplePositionLists'
//       `minOccurrences` (which gates the position-list path).
//     - `lexicon` — optional pre-loaded seed lexicon (default loads fresh)
//     - `regex` — optional ticker-shape regex (default /^[A-Z][A-Z0-9.]{0,4}$/)
//
// Output: { clusters: [{ canonical, members, frequency, frameCount }, ...],
//           merged_list: [...] }
function clusterRawOcrTokens(frameTexts, options = {}) {
  const maxDistance = Number.isFinite(options.maxDistance)
    ? options.maxDistance
    : 1;
  const minTokenLength = Number.isFinite(options.minTokenLength)
    ? options.minTokenLength
    : 2;
  const regex = options.regex || /^[A-Z][A-Z0-9.]{0,4}$/;
  const lexicon = options.lexicon || loadSeedLexiconSync();

  // Single-letter NYSE tickers that should bypass the minTokenLength filter.
  // Without this, clusterers silently filters out tokens like "U" (Unity
  // Software) before they can be matched against the seed lexicon. We only
  // accept single-letter tokens when they are in this allowlist — preventing
  // chart-axis "T" / "S" / chart-internal "X" from leaking as 1-char "tickers".
  // Step 1: collect tokens per frame (Set deduplicates within frame)
  const perFrameTokens = frameTexts.map((text) => {
    if (!text) return new Set();
    const tokens = new Set();
    for (const raw of String(text).split(/[\s,;:()\[\]{}<>\/\\|]+/)) {
      const cleaned = raw.replace(/^\|+|\|+$/g, '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      // Length filter: tokens must be at least minTokenLength, EXCEPT single-
      // letter tokens that are explicitly in SINGLE_LETTER_TICKERS (e.g. "U").
      if (cleaned.length > 5) continue;
      if (cleaned.length < minTokenLength
          && !(cleaned.length === 1 && SINGLE_LETTER_TICKERS.has(cleaned))) {
        continue;
      }
      if (!regex.test(cleaned)) continue;
      tokens.add(cleaned);
    }
    return tokens;
  });

  // Step 1.5 (Filter A): track per-token frame indices so we can compute
  // each cluster's distinct-frame count (union of frame sets across members).
  // Without this, we only know each token's per-frame frequency (which
  // overcounts when a cluster has multiple distinct members each appearing
  // once or twice in different frames).
  const tokenFrameIndices = new Map();
  for (let fi = 0; fi < perFrameTokens.length; fi += 1) {
    for (const t of perFrameTokens[fi]) {
      if (!tokenFrameIndices.has(t)) tokenFrameIndices.set(t, new Set());
      tokenFrameIndices.get(t).add(fi);
    }
  }

  // Step 2: compute per-token total frequency (counted once per frame, even
  // if it appears multiple times in the same frame). Used for canonical
  // tiebreaking and as the `frequency` field in the diagnostic output.
  const frequency = new Map();
  for (const tokens of perFrameTokens) {
    for (const t of tokens) {
      frequency.set(t, (frequency.get(t) || 0) + 1);
    }
  }
  if (frequency.size === 0) {
    return { clusters: [], merged_list: [] };
  }

  // Step 3: Union-Find clustering — tokens within maxDistance of each
  // other share a cluster root. O(N²) which is fine for ~50 tokens/frame
  // × 6 frames = 300 tokens (~90K pair comparisons, ~10ms).
  const tokens = Array.from(frequency.keys());
  const parent = new Map();
  function find(x) {
    let r = parent.get(x) ?? x;
    if (r === x) return x;
    r = find(r);
    parent.set(x, r);
    return r;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  // Every token starts as its own root. The initialisation has to happen
  // BEFORE the comparison loop: `parent.set(tokens[i], tokens[i])` inside
  // the loop resets a token that an earlier iteration had already merged
  // into another cluster, which splits that cluster again and makes the
  // result depend on the order the tokens happened to arrive in.
  for (const token of tokens) {
    parent.set(token, token);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (Math.abs(tokens[i].length - tokens[j].length) > maxDistance) continue;
      if (levenshtein(tokens[i], tokens[j]) <= maxDistance) {
        union(tokens[i], tokens[j]);
      }
    }
  }

  // Step 4: group by root
  const groups = new Map();
  for (const t of tokens) {
    const root = find(t);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }

  // Filter A: per-canonical minimum frame occurrences.
  // Default 2 (was 1 prior to 2026-10-01 commit). The flag is exposed as
  // `--cluster-min-frequency` for both the function param and the CLI
  // argument. Pass `minFrequency: 1` to disable filtering (backward compat).
  const minFrequency = Number.isFinite(options.minFrequency)
    ? options.minFrequency
    : 2;

  // Step 5: pick canonical per cluster.
  // - If any cluster member is in the seed lexicon, prefer that.
  // - Otherwise, edit-distance-correct to the closest lexicon ticker
  //   (so e.g. INA → TNA, NFU → NFLX survive even when the OCR garbled
  //   the canonical form).
  // - If no lexicon match within maxDistance, drop the cluster.
  // - Apply Filter A: drop cluster whose distinct-frame count (union of
  //   frame sets across members) is below `minFrequency`. This catches
  //   single-frame OCR garbles (VIO→VLO, NFU→NFLX, INA→TNA, BUCO→UCO)
  //   and chart-area tickers that bleed in briefly.
  const clusters = [];
  for (const [, members] of groups) {
    members.sort((a, b) => {
      const aLex = lexicon.tickerSet.has(a) ? 1 : 0;
      const bLex = lexicon.tickerSet.has(b) ? 1 : 0;
      if (aLex !== bLex) return bLex - aLex;  // lexicon match first
      const aFreq = frequency.get(a) || 0;
      const bFreq = frequency.get(b) || 0;
      if (aFreq !== bFreq) return bFreq - aFreq;
      return a.localeCompare(b);
    });
    // Find canonical: prefer direct lexicon match, fall back to
    // edit-distance lookup against the seed lexicon.
    let canonical = null;
    // Strategy 1: direct lexicon match
    for (const m of members) {
      if (lexicon.tickerSet.has(m)) { canonical = m; break; }
    }
    // Strategy 2: 4+ char member with >= 2 shared prefix chars
    if (!canonical) {
      for (const m of members) {
        if (m.length < 4) continue;
        const corr = findCloseTickerMatch(m, lexicon);
        if (!corr) continue;
        let sharedPrefix = 0;
        const limit = Math.min(3, m.length, corr.length);
        for (let i = 0; i < limit; i++) {
          if (m[i] === corr[i]) sharedPrefix += 1;
        }
        if (sharedPrefix >= 2) { canonical = corr; break; }
      }
    }
    // Strategy 3: 3-char member with d=1 to the correction
    if (!canonical) {
      for (const m of members) {
        if (m.length !== 3) continue;
        const corr = findCloseTickerMatch(m, lexicon);
        if (!corr) continue;
        const d = levenshtein(m, corr);
        if (d <= 1) { canonical = corr; break; }
      }
    }
    if (!canonical) continue;
    // Blocklist filter: never surface a blocklisted ticker as canonical even
    // if all other cluster signals pass. Applied after canonical selection so
    // we don't waste effort on blocklisted clusters, but before Filter A.
    if (TICKER_BLOCKLIST.has(canonical)) continue;
    // Filter A: compute distinct-frame count for the cluster (union of
    // frame sets across all members). This catches single-frame OCR
    // garbles (e.g. VIO→VLO cluster only spans the 1 frame where VIO
    // appeared) and chart-area bleed (MARA in 1 frame gets filtered).
    const clusterFrames = new Set();
    for (const m of members) {
      const frames = tokenFrameIndices.get(m);
      if (frames) {
        for (const fi of frames) clusterFrames.add(fi);
      }
    }
    if (clusterFrames.size < minFrequency) continue;
    const totalFreq = members.reduce((s, m) => s + (frequency.get(m) || 0), 0);
    clusters.push({
      canonical,
      frameCount: clusterFrames.size,
      frequency: totalFreq,
      members: members.sort()
    });
  }

  // Step 6: build merged list. The Filter A pass above already filtered
  // clusters by minFrequency; this is just the canonical → merged list.
  const seen = new Set();
  const merged = [];
  for (const c of clusters) {
    if (seen.has(c.canonical)) continue;
    seen.add(c.canonical);
    merged.push(c.canonical);
  }
  merged.sort();

  return { clusters, merged_list: merged };
}

module.exports = {
  hasPriceNear,
  identifyPositionListColumn,
  findCloseTickerMatch,
  mergeMultiplePositionLists,
  clusterRawOcrTokens,
  extractZoomStripTickerCandidates,
  parseChartStreamPositionList,
  extractAllTickerCandidates,
  TICKER_BLOCKLIST
};
