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

// Maximum edit distance for OCR character correction. Tested 3 on 2026-09-29
// (might catch GOVX→"BGO" which needs 3 edits) — added FPs to non-peak frames
// without helping peak recall. Reverted to 2.
const MAX_OCR_EDIT_DISTANCE = 2;

// Matches OCR-split prices:  $ 412.50  ($ split from digits by whitespace)
// Also matches:  $412.50,  412.50,  HIGH/LOW/CLOSE/TARGET/STOP/BID/ASK
const PRICE_TOKEN_PATTERN = /\$\s*\d+(?:\.\d+)?|\d+\.\d+|\b(?:high|low|close|target|stop|bid|ask)\b/i;

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
    if (dist < bestDist && dist <= MAX_OCR_EDIT_DISTANCE) {
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
  // Search for the ticker as a whole word; accept up to 12 trailing chars
  // (the OCR frequently splits dollar prices from the symbol, e.g. "GOVX | +1827%").
  const proximityPattern = new RegExp(
    `\\b${ticker}\\b[^A-Z0-9.]{0,12}(\\$\\s*\\d|\\d+\\.\\d|\\b(?:HIGH|LOW|CLOSE|TARGET|STOP|BID|ASK)\\b|[+-]\\d+(?:\\.\\d+)?%)`,
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
    if (positionsLine == null && /POSITIONS|POSTNS|POSITON/.test(upper)) {
      positionsLine = w.line;
    }
    if (watchlistLine == null && /WATCH|MAHL|PENAL|PENOR|WANCR/.test(upper)) {
      watchlistLine = w.line;
    }
  }
  return { positionsLine, watchlistLine };
}

function identifyPositionListColumn(words) {
  if (!Array.isArray(words) || !words.length) {
    return { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };
  }

  // Detect panel boundaries via keyword matching. If both headers found,
  // restrict ticker-word collection to lines inside [positionsLine+1, watchlistLine).
  // This excludes chart text above and the Personal WatchList panel below.
  const { positionsLine, watchlistLine } = findPanelBoundaries(words);
  const lineIsInPanel = (line) => {
    if (positionsLine != null && line <= positionsLine) return false;
    if (watchlistLine != null && line >= watchlistLine) return false;
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
    const priceMatches = lineText.match(/[+\-]?\d+(?:\.\d+)?\s*%|[+\-]?\d+\.\d+|\$\s*\d/g);
    if (priceMatches && priceMatches.length) {
      const tickerXs = sameLineWords
        .filter(x => STRICT_TICKER_PATTERN.test((x.text||'').toUpperCase().replace(/[^A-Z0-9.]/g,'')))
        .map(x => ({ left: x.left, right: x.left + x.width }));
      const priceWords = sameLineWords.filter(x => /[%\$]|^\d+\.\d+$|^\d{2,4}$/.test(x.text));
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
  if (priceAlignedTickers.length >= 2) {
    const xs = priceAlignedTickers.map(t => t.center).sort((a, b) => a - b);
    dominantX = xs[Math.floor(xs.length / 2)];
    dominantCount = priceAlignedTickers.length;
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
    if (!topBucket || topBucket[1] < 3) {
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

  // Require both: ticker in the column AND price-on-right on the same line.
  // This filters chart y-axis labels where prices are on the LEFT of the
  // ticker-shape word ("25.00 | Bs | 8+"), and chart header words
  // (SYM/Cran/Pre/Buzz) that happen to land at column x.
  const inListTickers = new Set();
  for (const tw of tickerWords) {
    if (Math.abs(tw.center - dominantX) <= columnWidth / 2) {
      if (lineRightHasPrice.get(tw.line)) {
        inListTickers.add(tw.text);
      }
    }
  }

  return { columnWidth, dominantColumnX: dominantX, inListTickers };
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
    ? identifyPositionListColumn(words)
    : { inListTickers: new Set(), dominantColumnX: null, columnWidth: 0 };

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
  const accepted = [];
  const rejected = [];
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
          accepted.push(correction);
        } else {
          rejected.push(ticker);
        }
      }
      continue;
    }
    // Position-list-aware filter: when word positions are reliable
    // (Tesseract), require the ticker to be in the dominant ticker column.
    // When word positions are unreliable (EasyOCR — different x-center
    // distribution), skip the column check and rely on lexicon +
    // price-nearby signals. The column detector result is still computed
    // for diagnostics (column_filter field in output) but no longer
    // gates acceptance.
    const inListColumn = inListTickers.has(ticker);
    if (inLexicon || priceNearby) {
      // Lexicon match OR price-nearby: accept (column-agnostic).
      // Chart-area text like "Arith", "Sym", "Cran" doesn't match the
      // seed lexicon so it stays rejected.
      accepted.push(ticker);
    } else if (inListColumn) {
      // In-column ticker that's NOT in the lexicon: try OCR character
      // correction via edit distance (INUG→JNUG, XX→X, FCX→FCX).
      const correction = findCloseTickerMatch(ticker, lexicon);
      if (correction) {
        if (!accepted.includes(correction)) {
          accepted.push(correction);
        } else {
          rejected.push(ticker);
        }
      } else {
        rejected.push(ticker);
      }
    } else {
      rejected.push(ticker);
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

  return {
    column_filter: dominantColumnX != null ? {
      column_width: columnWidth,
      dominant_x: dominantColumnX,
      in_list_token_count: inListTickers.size
    } : null,
    confidence,
    parse_status: accepted.length ? 'ok' : 'no_position_list',
    position_list: accepted.sort(),
    price_action: priceActionHint || '',
    // Keep `tickers_rejected` as a number for backward compatibility with
    // scoreChartStreamCandidate in tools/scanVideoWithOcr.js (-0.25 per reject).
    tickers_rejected: rejected.length,
    // Diagnostic: the actual rejected tokens (capped to keep probe logs small).
    // Helps diagnose which chart-text/OCR-garble tokens are leaking into "rejected"
    // status instead of being silently dropped. Was previously only a count.
    tickers_rejected_list: rejected.slice(0, 30)
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
//     - `maxDistance` (default 2) — edit distance for clustering
//     - `minTokenLength` (default 2) — drop tokens shorter than this
//     - `lexicon` — optional pre-loaded seed lexicon (default loads fresh)
//     - `regex` — optional ticker-shape regex (default /^[A-Z][A-Z0-9.]{0,4}$/)
//
// Output: { clusters: [{ canonical, members, frequency }, ...], merged_list: [...] }
function clusterRawOcrTokens(frameTexts, options = {}) {
  const maxDistance = Number.isFinite(options.maxDistance)
    ? options.maxDistance
    : 2;
  const minTokenLength = Number.isFinite(options.minTokenLength)
    ? options.minTokenLength
    : 2;
  const regex = options.regex || /^[A-Z][A-Z0-9.]{0,4}$/;
  const lexicon = options.lexicon || loadSeedLexiconSync();

  // Step 1: collect tokens per frame (Set deduplicates within frame)
  const perFrameTokens = frameTexts.map((text) => {
    if (!text) return new Set();
    const tokens = new Set();
    for (const raw of String(text).split(/[\s,;:()\[\]{}<>\/\\|]+/)) {
      const cleaned = raw.replace(/^\|+|\|+$/g, '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (cleaned.length < minTokenLength || cleaned.length > 5) continue;
      if (!regex.test(cleaned)) continue;
      tokens.add(cleaned);
    }
    return tokens;
  });

  // Step 2: compute per-token total frequency (counted once per frame, even
  // if it appears multiple times in the same frame)
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
  for (let i = 0; i < tokens.length; i += 1) {
    parent.set(tokens[i], tokens[i]);
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

  // Step 5: pick canonical per cluster. Prefer lexicon matches; if
  // multiple lexicon matches, prefer most-frequent; tie-break alphabetically.
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
    const canonical = members[0];
    // Drop clusters with no lexicon match (likely pure OCR noise)
    if (!lexicon.tickerSet.has(canonical)) continue;
    const totalFreq = members.reduce((s, m) => s + (frequency.get(m) || 0), 0);
    clusters.push({
      canonical,
      members: members.sort(),
      frequency: totalFreq
    });
  }

  // Step 6: dedupe canonicals (Union-Find guarantees per-cluster uniqueness
  // so this is just a defensive sort).
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
  parseChartStreamPositionList,
  extractAllTickerCandidates
};
