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

const {
  extractTickersFromOcrText,
  loadSeedLexiconSync,
  loadDecodeLexiconSync,
  clearTickerScanCache
} = require('../normalize/tickerScan');
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
const DEFAULT_OCR_CONFUSION_CSV = path.resolve(__dirname, '..', '..', 'config', 'ticker_ocr_confusions.csv');
let activeConfusionCsv = DEFAULT_OCR_CONFUSION_CSV;
let cachedConfusionMap = null;
let cachedConfusionMapPath = null;

// Point the alias reader at a different table and return the path it was
// using before, so a caller can restore it.
//
// The reason this exists: the map is cached at module level, so a
// before/after measurement of the alias table used to require editing
// config/ticker_ocr_confusions.csv in place -- and the file is shared, so
// two measurements in the same tree raced each other. That happened: the
// table flipped between its 20-line and 29-line forms mid-measurement
// twice, which is how a wrong "before" column got reported once.
//
// The cache is keyed by the resolved path, so two tables can be used in
// ONE process, in either order.
function setOcrConfusionCsvPath(nextPath) {
  const previous = activeConfusionCsv;
  activeConfusionCsv = nextPath ? String(nextPath) : DEFAULT_OCR_CONFUSION_CSV;
  return previous;
}

function loadOcrConfusionMap() {
  if (cachedConfusionMap && cachedConfusionMapPath === activeConfusionCsv) return cachedConfusionMap;
  const map = new Map();
  try {
    const raw = fs.readFileSync(activeConfusionCsv, 'utf8');
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
  cachedConfusionMapPath = activeConfusionCsv;
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

// The corrections a cluster's members ADMIT, and the evidence for each.
//
// The shipped rule has two strategies, tried in order over the whole cluster:
// Strategy 2 (a 4+ character member whose closest lexicon ticker shares two
// prefix characters) and Strategy 3 (a 3-character member whose closest
// lexicon ticker is within edit distance 1). This helper collects the
// candidates of BOTH -- and it collects ALL of them per member, not just the
// one `findCloseTickerMatch` returns.
//
// That difference is the whole point. `findCloseTickerMatch` names ONE
// ticker per member, and which one it names is decided by a tie-break
// ("prefer the longer ticker") over tickers that are EQUALLY close. On
// 20230605 the member `ARCO` is two edits from BOTH `ARQQ` and `ARKG`, and
// the tie-break picked whichever the lexicon lists first -- so the
// correction that the video actually corroborates never entered the
// comparison at all.
//
// The admissibility rules are the shipped ones, per member:
//
//   - a 4+ character member needs two shared prefix characters;
//   - a 3-character member needs distance <= 1.
//
// `videoFrequency` maps a token to the number of DISTINCT FRAMES it was read
// in. It is the video's own evidence about a ticker: a candidate the video
// read ITSELF, in some other frame, is a holding this video really has --
// and a candidate the video never read, anywhere, is a name the clusterer
// made up.
//
// The measured instance (20230605): the cluster {AACO, ARCO} was published as
// `AAPL`, which appears in NO reading of that video. The two members' own
// corrections are
//
//   AACO -> AAPL   (2 edits: C->P, O->L)   support 0 -- the video never read AAPL
//   AACO -> AAL    (2 edits)                 support 0
//   ARCO -> ARQQ   (2 edits: C->Q, O->Q)   support 6 -- the video read ARQQ
//   ARCO -> ARKG   (2 edits)                 support 0
//
// so the corrections are all the SAME distance, and "closest" does not
// discriminate between them at all. What discriminates is the SUPPORT.
function clusterCorrectionCandidates(members, lexicon, videoFrequency) {
  const candidates = [];
  members.forEach((m, memberIndex) => {
    // The shipped rule never corrects a member shorter than 3 characters:
    // Strategy 2 needs 4+, Strategy 3 needs exactly 3.
    if (m.length < 3) return;
    // Strategy 2 allows a correction up to MAX_OCR_EDIT_DISTANCE away;
    // Strategy 3 allows only distance 1.
    const maxDistance = m.length >= 4 ? MAX_OCR_EDIT_DISTANCE : 1;

    // The member's OWN minimum distance -- the distance the shipped rule's
    // `findCloseTickerMatch` would have found. Candidates further away than
    // this are not the member's correction, so they are not candidates at
    // all.
    let best = Infinity;
    for (const ticker of lexicon.tickers) {
      const distance = levenshtein(m, ticker);
      // Distance 0 is a READING (the member IS the ticker), and Strategy 1
      // has already handled it by the time this runs.
      if (distance === 0 || distance > maxDistance) continue;
      if (distance < best) best = distance;
    }
    if (best === Infinity) return;

    // Every ticker AT that distance, subject to the same admissibility test
    // the shipped rule applies to the one it picked.
    //
    // This is where the shipped rule's tie-break ("prefer the longer
    // ticker") used to decide, among candidates that are EQUALLY close. The
    // supported rule needs all of them, because the video's own reading --
    // not the length of the ticker -- is what tells them apart.
    for (const ticker of lexicon.tickers) {
      if (levenshtein(m, ticker) !== best) continue;
      if (m.length >= 4) {
        let sharedPrefix = 0;
        const limit = Math.min(3, m.length, ticker.length);
        for (let i = 0; i < limit; i++) {
          if (m[i] === ticker[i]) sharedPrefix += 1;
        }
        if (sharedPrefix < 2) continue;
      }
      candidates.push({
        member: m,
        memberIndex,
        canonical: ticker,
        distance: best,
        // How many frames of THIS video read the candidate ticker as itself.
        support: (videoFrequency && videoFrequency.get(ticker)) || 0,
      });
    }
  });
  return candidates;
}

// Choose the canonical for a cluster from its admissible corrections.
//
// The shipped choice is the FIRST member's correction, with Strategy 2 tried
// over the whole cluster before Strategy 3. That is a member-order decision.
//
// The SUPPORTED choice asks the video instead. Two orderings, because the
// two pieces of evidence can disagree and the corpus is what settles which
// way to rank them:
//
//   distanceFirst (the `supported` rule)
//     Closer first, and the video's support only breaks a TIE. This is the
//     conservative one: it changes the published ticker only when two
//     candidates are EQUALLY close, which is the measured 20230605
//     situation. A one-glyph correction is strong evidence in its own right,
//     so this never moves a cluster off one in order to reach a farther
//     candidate.
//
//   supportFirst (the `video-supported` rule)
//     The video's support dominates. A candidate the video demonstrably held
//     beats a closer candidate it never read -- at the cost of being able to
//     move a cluster off a correct one-glyph correction.
//
// The tie-break after that is the shipped one: the earlier member, then the
// longer ticker.
//
// OFF by default. Both change which holdings a scan publishes, so they are
// measured over the recorded logs before either replaces anything:
// `node tools/evalParserReplay.js --cluster-rule supported` and
// `--cluster-rule video-supported`.
function selectSupportedCorrection(candidates, supportFirst) {
  if (!candidates.length) return null;
  const better = (a, b) => {
    if (supportFirst && a.support !== b.support) return a.support > b.support;
    if (a.distance !== b.distance) return a.distance < b.distance;
    if (!supportFirst && a.support !== b.support) return a.support > b.support;
    if (a.memberIndex !== b.memberIndex) return a.memberIndex < b.memberIndex;
    // A tie between two tickers for the SAME member: mirror
    // `findCloseTickerMatch`'s own tie-break and prefer the longer ticker,
    // so the two agree wherever the shipped rule was already right.
    return a.canonical.length > b.canonical.length;
  };
  let best = candidates[0];
  for (const c of candidates) {
    if (c === best) continue;
    if (better(c, best)) best = c;
  }
  return best.canonical;
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

// A ticker's text comes from the OCR, so it can carry regex metacharacters:
// "1.02(-0.20" is a real reading from a whiteboard frame, and an unbalanced
// "(" interpolated into a pattern throws "Unterminated group" — which took
// down the whole parse, not just the one token.
function escapeRegExp(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPriceNear(ocrText, ticker) {
  if (!ocrText) return false;
  if (!ticker) return false;
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
    `\\b${escapeRegExp(ticker)}\\b[^A-Z0-9.]{0,25}(`
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

// The panel's OWN row count.
//
// The positions panel prints its row count in its footer:
//
//   N Items in Personal WatchList          the whole list
//   1 Item in Personal WatchList           singular when the total is one
//   K of N Items in Personal WatchList     a row is selected; K is that row's
//                                          INDEX, not a scroll range
//
// N is the number of rows ON SCREEN. The panel is not scrolled — all N rows
// are visible at once — which makes N an INDEPENDENT check on a reading: a
// reading with a different number of tickers than the panel says has provably
// dropped a row or invented one.
//
// That is exactly the invariant the 2026-11-01 ground-truth audit used to find
// eight classes of defect in the hand-made ground truth (see CLAUDE.md § 'The
// Qullamaggie ground truth, verified against its pixels'), and it had never
// been applied to the PARSER's own output. The panel states its row count; the
// parser has an opinion about that count; the two can be compared for free.
//
// This is a DIAGNOSTIC, and deliberately not a repair.
//
// The count comes from OCR like everything else, and the failure mode of
// ACTING on a misread count is asymmetric in the worst way: a count read LOW
// would truncate a correct reading, and that is precisely the case where
// acting on it would do the most damage. Dropping rows is also the project's
// own stated preference against — a wrong holding in a portfolio report is
// worse than a missing one, and a truncated reading loses REAL holdings.
//
// So the count is REPORTED, and the disagreement is visible. Whether a
// disagreement can be repaired safely is a separate question that needs its
// own measurement, and it is measured on the replay corpus the same way every
// other change in this file was measured.
//
// Which footer is the positions table's?
//
// "Personal WatchList" does NOT identify the panel: in the 2022-era layout the
// frame carries THREE right-hand widgets and TWO of them print that wording.
// The footer alone therefore cannot say which panel a count came from.
//
// The bound that does is the panel's own HEADER. Every row of the positions
// table — and therefore its footer — is BELOW the "A - Positions" header, and
// the other widgets' footers are ABOVE it. So a footer below that header is
// the bottom-most widget's footer, which is the positions table by
// construction. That is the same rule the ground-truth audit settled on.
//
// Returns `{ count, line, text }` or null.
function readPanelRowCount(words, positionsLine, positionsHeaderY) {
  if (!Array.isArray(words) || !words.length) return null;

  // Group the words by their OCR line, keeping each line's words in reading
  // order.
  const lines = new Map();
  for (const w of words) {
    const line = w.line;
    if (!Number.isFinite(line)) continue;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push(w);
  }

  let best = null;
  for (const [line, lineWords] of lines) {
    // The footer must be BELOW the positions header. When the header was not
    // detected there is no bound to apply, and no count is reported — a count
    // with no way to tell which panel it came from is worse than no count.
    if (positionsLine == null && positionsHeaderY == null) return null;
    if (positionsLine != null && line <= positionsLine) continue;
    if (positionsHeaderY != null) {
      const belowHeader = lineWords.some((w) => {
        if (!Number.isFinite(w.top)) return false;
        const y = w.top + (Number.isFinite(w.height) ? w.height : 0) / 2;
        return y > positionsHeaderY;
      });
      if (!belowHeader) continue;
    }

    lineWords.sort((a, b) => (a.left || 0) - (b.left || 0));
    const cleaned = lineWords.map((w) => String(w.text || '').replace(/[^A-Za-z0-9]/g, ''));

    // The footer has to look like a watchlist footer. The plain
    // "N Items in WatchList" form belongs to the middle screener panel, and it
    // is above the positions header anyway; requiring a watch-shaped token
    // keeps it out even when the line bound is unavailable.
    if (!cleaned.some((t) => /WATCH|WATCHIST|WOTCH/i.test(t))) continue;

    // The word that names the unit: "Item" / "Items". The count is the digit
    // group IMMEDIATELY before it, so "5 of 7 Items" gives 7 (the total) and
    // not 5 (the selected row's index).
    const itemIndex = cleaned.findIndex((t) => /^[IL]?TEMS?$/i.test(t));
    if (itemIndex < 0) continue;

    let count = null;
    for (let i = itemIndex - 1; i >= 0 && i >= itemIndex - 3; i -= 1) {
      const digits = cleaned[i].replace(/[^0-9]/g, '');
      if (digits) {
        const parsed = parseInt(digits, 10);
        if (Number.isFinite(parsed) && parsed <= 200) { count = parsed; break; }
      }
    }
    if (count == null) continue;

    // The BOTTOM-most matching footer is the positions table's, so the last
    // one wins.
    best = {
      count,
      line,
      text: lineWords.map((w) => String(w.text || '').trim()).filter(Boolean).join(' '),
    };
  }
  return best;
}

// How many row pitches a gap may span and still be "the row the OCR skipped"
// rather than "a different widget".
//
// Measured on the corpus: a list row the OCR read as a bare digit (a row read
// as "4") leaves a 272 px hole = three pitches, and a 2.5-pitch limit split
// the run there and dropped the real holding PLTR above the hole. A 3.5-pitch
// limit keeps the run whole. The limit is safe because the panel's
// "A - Positions" header is an independent upper bound — a token every one of
// whose occurrences is above that header is rejected whatever the run says —
// and the measured corpus totals are identical at 2.5 and at 3.5.
const POSITION_LIST_ROW_GAP_LIMIT = 3.5;

// Select the position list's OWN rows out of the column's candidate words.
//
// The column detector finds the stack's x; this finds its vertical extent.
// A position list is a CONTIGUOUS vertical stack of rows at a constant pitch
// (~90 px in the 5x-scaled EasyOCR crop), and that stack — not a window
// around a median — is what a position-aware filter has to be built on.
//
// The old Filter B window was `yMedian +/- 8 * lineHeight`, where lineHeight
// is the median word HEIGHT (~54 px) where the intent was ROWS (~90 px
// apart): the window spanned only ~4.8 rows either side of the median, so it
// clipped the first and last row of any list longer than that. Measured
// corpus-wide, that window dropped 50 ground-truth holdings.
//
// The run is found by splitting the column's words wherever the gap between
// two consecutive ROWS is wider than a row pitch. A gap of up to
// POSITION_LIST_ROW_GAP_LIMIT pitches is still "the row the OCR skipped" and
// stays inside the run; anything wider starts a new run. The longest run is
// the list; a tie is broken by the price-aligned rows, which certainly carry a
// price to their right.
// A "one-glyph cell" is a cell the OCR read as a SINGLE character.
//
// The token is the CLEANED text (both the column's members and the
// candidates are upper-cased and stripped of everything but A-Z, 0-9 and "."
// before they reach here, and STRICT_TICKER_PATTERN then rejects anything
// carrying a digit). So the test is simply "exactly one letter and nothing
// else" -- which is stricter than counting the letters in the token, and does
// not depend on the cleaning rules of another module.
//
// This matters: a garbage cell like "~09r3" carries ONE letter, so a
// letter-count would score it as a one-glyph cell and inflate the count that
// decides a genuine one-letter holding's fate.
function isOneGlyphToken(token) {
  return typeof token === 'string' && /^[A-Z]$/.test(token);
}

function selectPositionListRun(members, splitLimit = POSITION_LIST_ROW_GAP_LIMIT) {  if (!Array.isArray(members) || members.length < 2) return null;
  // Group the column's words into ROWS first.
  //
  // Two words on the same OCR line are the SAME row of the table — a ticker
  // and its price, or a chart annotation sitting beside the ticker. Counting
  // them as two rows halves the pitch estimate: on the 20220323 Tesseract
  // capture the row pitch is ~48 px, but the same-row pairs (5-8 px apart)
  // dragged it down to 8 px, and a run found at that pitch is two rows wide.
  const byLine = new Map();
  for (const m of members) {
    const key = Number.isFinite(m.line) ? `L${m.line}` : `Y${Math.round(m.yCenter)}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(m);
  }
  const rows = [...byLine.values()].map((group) => {
    const ys = group.map((g) => g.yCenter).sort((a, b) => a - b);
    return {
      members: group,
      y: ys[Math.floor(ys.length / 2)],
      priced: group.some((g) => g.priceAligned),
    };
  }).sort((a, b) => a.y - b.y);
  if (rows.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].y - rows[i - 1].y;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return null;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  // The row pitch is the QUARTILE of the gaps, not their median: a single
  // wide separation (the gap between two panels) drags a short gap list's
  // median into the space BETWEEN the two clusters, and the pitch has to
  // land on the cluster that is actually the list.
  const quartile = sortedGaps[Math.floor(sortedGaps.length * 0.25)];
  const tight = gaps.filter((g) => g <= quartile * 2.5).sort((a, b) => a - b);
  const pitch = tight.length ? tight[Math.floor(tight.length / 2)] : quartile;
  if (!Number.isFinite(pitch) || pitch <= 0) return null;
  const limit = pitch * splitLimit;
  const runs = [];
  let current = [rows[0]];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].y - rows[i - 1].y;
    if (gap > limit) {
      runs.push(current);
      current = [rows[i]];
    } else {
      current.push(rows[i]);
    }
  }
  runs.push(current);
  // The longest run is the list. A tie is broken by the price-aligned rows,
  // which are the rows that certainly carry a price to their right.
  let best = null;
  let bestPriced = -1;
  for (const run of runs) {
    const priced = run.filter((r) => r.priced).length;
    if (!best || run.length > best.length || (run.length === best.length && priced > bestPriced)) {
      best = run;
      bestPriced = priced;
    }
  }
  if (!best || best.length < 2) return null;
  const entries = best.flatMap((r) => r.members);
  return {
    words: new Set(entries.map((m) => m.word)),
    entries,
    rows: best.length,
    top: best[0].y,
    bottom: best[best.length - 1].y,
    pitch,
    size: entries.length,
    runs: runs.length,
  };
}

function identifyPositionListColumn(words, cropWidth = null, engine = null) {
  if (!Array.isArray(words) || !words.length) {
    return { inListTickers: new Set(), dominantColumnX: null, dominantColumnLeft: null, columnWidth: 0 };
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
      left: w.left,
      line: w.line,
      right: w.left + w.width,
      text: upper,
      // The original word, so a filter can ask "is THIS occurrence in the
      // list's row stack" and not merely "is some occurrence of this ticker
      // somewhere near the list".
      word: w,
      yCenter: Number.isFinite(w.top)
        ? w.top + (Number.isFinite(w.height) ? w.height : 0) / 2
        : null,
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
      return { inListTickers: new Set(), dominantColumnX: null, dominantColumnLeft: null, columnWidth: 0 };
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

  // The column's LEFT edge: the median left of the column's own members.
  //
  // A position list is a LEFT-aligned table, so every ticker in it starts at
  // the same x no matter how many characters it has. The column's CENTRE
  // therefore drifts with the ticker's length, and a short garbled ticker
  // ("A" for "AI") sits far to the left of the column's median centre even
  // though it starts in exactly the same place as every other ticker.
  //
  // Measured on the 20230609 capture: every ticker in the column starts at
  // x 515-518 and the one-character "A" starts at x 518 too, but its centre
  // is 545 against a median centre of 581.5 -- 36.5 px away, more than the
  // 25 px the centre test allows.
  const columnLefts = columnMembers.map((tw) => tw.left).sort((a, b) => a - b);
  const dominantColumnLeft = columnLefts.length
    ? columnLefts[Math.floor(columnLefts.length / 2)]
    : null;

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
    return { inListTickers: new Set(), dominantColumnX: null, dominantColumnLeft: null, columnWidth: 0, listRun: null };
  }

  // The list's OWN rows, for Filter B's vertical bound.
  //
  // The column's x is not a sufficient bound on its own: a scanner-panel or
  // chart token can sit at exactly the position list's x and still be nothing
  // of the kind. The rows of the list are a contiguous stack at a constant
  // pitch, and that stack is what a position-aware filter must be built on.
  //
  // Membership uses the UNION of the left-edge and centre tests, for the same
  // reason the curated-alias rescue uses it: the table is left-aligned, so a
  // short garbled ticker starts where every other ticker starts even though
  // its centre sits far to the left of theirs.
  const unionColumnMembers = tickerWords.filter((tw) => {
    if (!Number.isFinite(tw.yCenter)) return false;
    if (dominantColumnLeft == null) return Math.abs(tw.center - dominantX) <= columnWidth / 2;
    return Math.abs(tw.left - dominantColumnLeft) <= columnWidth / 2
      || Math.abs(tw.center - dominantX) <= columnWidth / 2;
  });
  const priceAlignedLines = new Set(priceAlignedMembers.map((tw) => tw.line));
  const listRun = selectPositionListRun(
    unionColumnMembers.map((tw) => ({ ...tw, priceAligned: priceAlignedLines.has(tw.line) }))
  );

  return {
    columnWidth,
    dominantColumnX: dominantX,
    dominantColumnLeft,
    inListTickers,
    stackLines: stackLines.size,
    listRun,
  };
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
  const { inListTickers, dominantColumnX, dominantColumnLeft, columnWidth, listRun } = hasWordPositions
    ? identifyPositionListColumn(words, ocr._cropWidth || null, ocr._engine || null)
    : { inListTickers: new Set(), dominantColumnX: null, dominantColumnLeft: null, columnWidth: 0, listRun: null };

  // Column membership for the GATE.
  //
  // `inListTickers` is the PRICE-ALIGNED subset of the column: a ticker is
  // a member of it only when its row carries a readable price to the right.
  // That conflates two independent facts -- where the ticker is, and whether
  // the price cell beside it was read cleanly -- and the price cell is
  // exactly the cell that gets garbled.
  //
  // Measured on the 20220330 capture: NFLX, REGN, COPX and NUGT are read
  // perfectly (conf 0.92, 0.96, 0.51, 0.50) and sit at x 711-714, exactly
  // where every other ticker in the column sits -- but their price cells read
  // "0s63 ~0383", "C00 08re", "~00r ~0229" and "30.1933| ~0583", none of
  // which passes the strict price-word filter. So the four left the
  // price-aligned subset, the column gate rejected them, and the holding
  // was lost before Filter B -- which tests row-stack membership and would
  // have kept all four -- ever saw them.
  //
  // The row stack is the better evidence of column membership, and the
  // parser already computes it: Filter B asks exactly this question of the
  // accepted set. The gate asks it first, so the answer has to exist first.
  //
  // The gate's membership is therefore the UNION of the two: the
  // price-aligned column members, plus the tickers on the list's own rows.
  // The union is used for the GATE only. The accept-as-read branch below
  // stays on the price-aligned set, because a run member can be a header
  // word rather than a holding -- on the 20220330 capture the run contains
  // the "Sym" header, which is not a position, and admitting it verbatim
  // would publish a false positive.
  const listRunMembers = new Set();
  if (listRun && listRun.rows >= 3 && Array.isArray(listRun.entries)) {
    for (const entry of listRun.entries) {
      if (entry && entry.text) listRunMembers.add(entry.text);
    }
  }
  const columnGateMembers = new Set(inListTickers);
  for (const ticker of listRunMembers) columnGateMembers.add(ticker);

  // How many of the column's own rows read as a SINGLE glyph.
  //
  // A one-glyph cell is ambiguous: it is either a genuine one-letter ticker
  // or a multi-glyph cell the OCR collapsed into one glyph, and the shape
  // cannot tell the two apart -- "X" (a real holding on 20220301, 20220323
  // and 20220412) and "U" (the LI row collapsed on 20230522) are both one
  // glyph about 42 px wide in the Sym column.
  //
  // The COLUMN settles it, by its own consistency. Only four US tickers have
  // a single letter (F, T, V, X), so a position list holding TWO of them is
  // far less likely than a panel that collapses two cells -- and a panel that
  // collapses one cell is likely to collapse another.
  //
  // Measured on the replay corpus, the one-glyph run-only class is five
  // readings: X on 20220301 (conf 0.980), X on 20220323 (0.963) and X on
  // 20220412 (0.914) -- three hits, each the ONLY one-glyph member of its
  // column -- and U on 20230522 (0.616 and 0.743, two captures of one date),
  // the collapsed LI row, in a column that also holds the collapsed AI row.
  //
  // Confidence cannot do this job. U reads at 0.616 on one capture and
  // 0.743 on the other, so any threshold low enough to catch it also catches
  // the 0.534-confidence QBTS hit on 20230602 -- and the corpus mixes OCR
  // engines, whose confidence scales are not comparable anyway.
  let singleGlyphColumnMembers = 0;
  for (const ticker of listRunMembers) {
    if (isOneGlyphToken(ticker)) singleGlyphColumnMembers += 1;
  }

  // Build per-ticker line + word lookups from raw OCR word positions.
  // - tickerLineMap: ticker → array of line indices (used by Filter G)
  // - tickerWordMap: ticker → first raw word record with bbox (used by Filter B)
  // - tickerWordsMap: ticker → EVERY raw word record with that text (used by
  //   Filter B's row-stack test, which asks "does ANY occurrence of this
  //   ticker sit on one of the list's own rows?"). A ticker can be read more
  //   than once in a frame — on its own row, and again in a scanner panel
  //   above it — and the first occurrence alone is not always the holding.
  // These are skipped when the OCR engine does not surface per-word positions.
  const tickerLineMap = new Map();
  const tickerWordMap = new Map();
  const tickerWordsMap = new Map();
  if (hasWordPositions) {
    for (const w of words) {
      const upper = (w.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!upper || !STRICT_TICKER_PATTERN.test(upper)) continue;
      if (Number.isFinite(w.line)) {
        if (!tickerLineMap.has(upper)) tickerLineMap.set(upper, []);
        tickerLineMap.get(upper).push(w.line);
      }
      if (!tickerWordMap.has(upper)) tickerWordMap.set(upper, w);
      if (!tickerWordsMap.has(upper)) tickerWordsMap.set(upper, []);
      tickerWordsMap.get(upper).push(w);
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

  // The y of the "A - Positions" header, when one was detected.
  //
  // The header is the panel's OWN upper bound, and it is independent of the
  // row pitch: every row of the position list is BELOW it, and the scanner
  // panel above it is not part of the list. The run's own extent cannot
  // supply this bound — it is derived from the list's rows, so a panel above
  // the list is separated from it by a gap the run has to guess at.
  let positionsHeaderY = null;
  if (hasWordPositions && positionsLine != null) {
    for (const w of words) {
      if (w.line !== positionsLine) continue;
      if (!Number.isFinite(w.top)) continue;
      const y = w.top + (Number.isFinite(w.height) ? w.height : 0) / 2;
      if (positionsHeaderY == null || y > positionsHeaderY) positionsHeaderY = y;
    }
  }
  // The same rule the column detector uses: the watchlist bound only counts
  // when the watchlist header is BELOW the positions header.
  const watchlistBelowPositions = watchlistLine != null
    && (positionsLine == null || watchlistLine > positionsLine);
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
      // The gate's membership test: the price-aligned column members PLUS
      // the tickers on the list's own rows. A garbled PRICE cell must not
      // decide whether a perfectly-read ticker belongs to the column.
      const inColumnGate = columnGateMembers.has(ticker);
      // A token the ROW STACK admitted but a readable price did not: it sits on
      // a position-list row and the price cell beside it was garbled.
      const runOnly = inColumnGate && !inListColumn;
      if (columnGateActive && !inColumnGate && !(inLexicon && inListTickers.size >= 6)) {
        // Column detector is confident and this token is not a position-list row.
        // Reject it before the lexicon/price-nearby path can admit it.
        rejected.push(ticker);
        continue;
      }
      if (inLexicon || priceNearby) {
      // A run-only member is a position-list row whose TICKER cell was read
      // and whose PRICE cell was not -- 20220330's NFLX, REGN, COPX and NUGT
      // all read at conf 0.50-0.96, with the price cells garbled ("0s63",
      // "C00", "~0229"). The row stack says it is a position; `hasPriceNear`
      // says nothing about it, because it scans the ENTIRE flattened text and
      // happily matches a ticker at the end of one line against a price at
      // the start of the next.
      //
      // So a run-only member has to be vouched for by the LEXICON. The
      // price-nearby test alone published "OI" on 20220412: a 0.076-confidence
      // garbage read of the LMT row, which the alias rescue cannot fix
      // because "OI" is not a recorded misread of anything. The curated
      // rescue still reaches the run-only members it should -- "WHX" on
      // 20220412 and "A" on 20230522 are both run-only and both not in the
      // lexicon, and both are rescued to LHX and AI from the words
      // themselves, after this loop.
      if (runOnly && !inLexicon) {
        rejected.push(ticker);
        continue;
      }
      // A one-glyph cell in a column that holds ANOTHER one-glyph cell is not
      // taken at face value. The column has demonstrated that it collapses
      // cells, so a one-glyph read in it is a collapse until proven
      // otherwise.
      //
      // There is no price-aligned escape hatch, and it is worth saying why:
      // the column detector measures a cell's CENTRE, and in a left-aligned
      // table a one-glyph cell's centre sits ~44 px left of a four-glyph
      // cell's -- outside the detector's +-25 px column window. So a
      // one-glyph token can never be price-aligned, and the row stack is the
      // ONLY evidence that admits it. This rule is therefore the only thing
      // that decides a one-glyph read's fate.
      //
      // The curated rescue still reaches the cells this rejects: it works on
      // the words themselves, so the collapsed AI row on 20230522 ("A") is
      // still rescued to AI after this loop. What it cannot reach is the
      // collapsed LI row ("U"), because "U" is a genuine ticker (a holding on
      // 20221117) and the alias table's invariant forbids a row that would
      // rewrite it. That row stays missed, which is the project's own
      // preference: a wrong holding is worse than a missing one.
      if (runOnly && singleGlyphColumnMembers >= 2
          && isOneGlyphToken(ticker)) {
        rejected.push(ticker);
        continue;
      }
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

  // Filter B: the position-aware vertical bound.
  //
  // A position list is one row per ticker in the position-list column, and
  // the rows are a CONTIGUOUS vertical stack at a constant pitch. Chart-area
  // tokens (NVDA on a chart-axis label, AMD/INTC/MU in a sub-plot annotation,
  // MSTR/COIN bleeding from chart overlay) and scanner-panel tokens sit
  // outside that stack. Filter B is what keeps them out of the reading.
  //
  // The rule this replaced was a window around the median of the accepted
  // tickers' bbox centres: [yMedian - 8*lineHeight, yMedian + 8*lineHeight].
  // `lineHeight` is the median word HEIGHT (~54 px) where the intent was ROWS
  // (~90 px apart), so the window spanned only ~4.8 rows either side of the
  // median and clipped the first and last row of any list longer than about
  // nine rows. Measured corpus-wide, that window dropped 50 ground-truth
  // holdings.
  //
  // The rule now is the list's OWN ROWS (`listRun`, above) plus the panel's
  // own upper bound — nothing above the "A - Positions" header is a
  // position. A ticker is a holding when ONE of its OCR occurrences sits on
  // one of the stack's rows; "one of" matters, because a ticker read both on
  // its own row and again in a widget above it is a holding, and the first
  // occurrence alone would lose it.
  //
  // Measured with the no-OCR replay (`node tools/evalParserReplay.js`).
  // Both columns below use the SAME config files (the 2026-11-01 seed and
  // observed lexicons, and the alias table WITHOUT the four rows added the
  // same day), so the difference is the rule and nothing else:
  //
  //   corpus          legacy window            this rule
  //   default (8)     75/85/76  88.2 / 98.7%   80/85/81  94.1 / 98.8%
  //   wide (17)      123/168/143 73.2 / 86.0%  128/168/149 76.2 / 85.9%
  //
  // (hit / ground-truth / predicted, then micro recall and precision.)
  //
  // With the four alias rows and the 16 new seed rows in place as well, the
  // shipped figures are 80/85/81 (94.1 / 98.8%) on the default roots and
  // 132/168/151 (78.6 / 87.4%) on the wide corpus.
  //
  // When the column could not be identified there are no rows to test
  // against, and the legacy window is the only thing left to fall back on.
  let bboxFilterInfo = null;
  if (hasWordPositions && accepted.length >= 2) {
    const acceptedBboxes = [];
    for (const ticker of accepted) {
      const rawTicker = canonicalToRawTicker.get(ticker) || ticker;
      const w = tickerWordMap.get(rawTicker);
      if (w && Number.isFinite(w.top) && Number.isFinite(w.height) && w.height > 0) {
        acceptedBboxes.push({ ticker, yCenter: w.top + w.height / 2, xLeft: w.left });
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
      // The legacy window, kept only as the fallback for a frame whose column
      // could not be identified.
      const yMin = yMedian - 8 * lineHeight;
      const yMax = yMedian + 8 * lineHeight;
      const withinBbox = new Set();
      if (listRun && listRun.words.size >= 2) {
        for (const { ticker } of acceptedBboxes) {
          const raw = canonicalToRawTicker.get(ticker) || ticker;
          const occurrences = tickerWordsMap.get(raw) || [];
          // The panel's own upper bound: a token every one of whose
          // occurrences is above the "A - Positions" header is not a
          // position, whatever the run says. This is what separates a
          // scanner panel above the list (TAN on 20230523, BABA and HAL on
          // 20230602) from the list itself.
          const allAboveHeader = positionsHeaderY != null
            && occurrences.length > 0
            && occurrences.every((w) => {
              const y = w.top + (Number.isFinite(w.height) ? w.height : 0) / 2;
              return Number.isFinite(w.top) && y < positionsHeaderY;
            });
          if (allAboveHeader) { rejected.push(ticker); continue; }
          const inRun = occurrences.some((w) => listRun.words.has(w));
          if (inRun) { withinBbox.add(ticker); continue; }
          rejected.push(ticker);
        }
      } else {
        for (const { ticker, yCenter } of acceptedBboxes) {
          if (yCenter >= yMin && yCenter <= yMax) {
            withinBbox.add(ticker);
          } else {
            rejected.push(ticker);
          }
        }
      }
      // Re-filter accepted in place, preserving order
      for (let i = accepted.length - 1; i >= 0; i -= 1) {
        if (!withinBbox.has(accepted[i])) {
          accepted.splice(i, 1);
        }
      }
      bboxFilterInfo = {
        rule: listRun && listRun.words.size >= 2 ? 'list_rows' : 'y_window',
        list_rows: listRun
          ? {
            rows: listRun.rows,
            members: listRun.size,
            top: Math.round(listRun.top),
            bottom: Math.round(listRun.bottom),
            pitch: Math.round(listRun.pitch),
            runs: listRun.runs,
            positions_header_y: positionsHeaderY == null ? null : Math.round(positionsHeaderY),
          }
          : null,
        y_median: yMedian,
        line_height: lineHeight,
        y_min: yMin,
        y_max: yMax,
        rejected_count: acceptedBboxes.length - withinBbox.size,
        rejected_tickers: acceptedBboxes.filter((b) => !withinBbox.has(b.ticker)).map((b) => b.ticker),
      };
    }
  }

  // Curated-alias rescue.
  //
  // A recorded, human-verified misread of a position-list ticker that sits
  // INSIDE the detected column IS that ticker. The column gate cannot see it
  // on its own: `inListTickers` is the PRICE-ALIGNED subset of the column,
  // and a row whose price is garbled is not price-aligned even when its
  // ticker sits exactly where every other ticker sits. Such a token is
  // rejected at the gate, so the holding is lost before the repair pass
  // above ever sees it.
  //
  // It runs AFTER the repair pass so that a garble the repair pass already
  // replaced in place is not joined by its canonical — the two spellings of
  // one holding must never both appear in the reading. An earlier attempt
  // did exactly that and paid for it twice: the raw survived as a duplicate
  // false positive, and the extra entries shifted Filter B's median y and
  // evicted real holdings that were already in the reading.
  if (columnGateActive && hasWordPositions) {
    const confusionMap = loadOcrConfusionMap();
    for (const word of words) {
      const raw = String(word.text || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
      if (!raw) continue;
      const canonical = confusionMap.get(raw);
      if (!canonical) continue;
      if (!lexicon.tickerSet.has(canonical)) continue;
      // The panel test here is the panel's OWN bounds, not the parser's
      // "implied bottom" heuristic. That heuristic GUESSES where the list
      // ends — fifteen rows below the header — and the lists in this corpus
      // are longer than that, so it cuts the rows off exactly where the
      // recoverable ones are. The parser does not apply it to the accepted
      // set either, so applying it here would hold the rescue to a rule
      // the rest of the parser does not keep.
      //
      // The watchlist bound is the one that matters: the Personal WatchList
      // panel sits at the SAME x as the position list, so a row below it is
      // a watchlist row however well it lines up. And the watchlist bound
      // only applies when the watchlist header is BELOW the positions
      // header — a stray "Watch..." token above the panel would otherwise
      // act as a lower bound and reject every real row.
      if (positionsLine != null && word.line <= positionsLine) continue;
      if (watchlistBelowPositions && word.line >= watchlistLine) continue;
      const center = word.left + word.width / 2;
      // The token's LEFT edge is compared with the column's LEFT edge, not
      // its centre with the column's median centre. The position list is a
      // left-aligned table, so a short garbled ticker starts where every
      // other ticker starts even though its centre sits far to the left of
      // theirs -- measured on 20230609: every ticker in the column starts at
      // x 515-518 and the one-character "A" starts at x 518 too, but its
      // centre is 545 against a median centre of 581.5, so the centre test
      // rejected it before the alias was ever consulted.
      //
      // The centre test is kept as an ALTERNATIVE, not replaced: this
      // corpus's tables are left-aligned, but a right-aligned or centred
      // layout would be judged by its centres, and the union of the two
      // tests cannot reject a token the old gate accepted.
      const tokenLeft = word.left || 0;
      const insideColumn = dominantColumnLeft != null
        ? (Math.abs(tokenLeft - dominantColumnLeft) <= columnWidth / 2
            || Math.abs(center - dominantColumnX) <= columnWidth / 2)
        : Math.abs(center - dominantColumnX) <= columnWidth / 2;
      if (!insideColumn) continue;
      // The vertical span the other tickers established is NOT used as a
      // gate here. The span is computed from the accepted rows, and the rows
      // worth rescuing are exactly the ones that are NOT accepted — a
      // garbled price is why they were left out — so the span is missing
      // them by construction, and testing against it rejects the top and
      // bottom rows of the list precisely because they are the rows whose
      // price was garbled. Measured on the replay corpus, the check refused
      // all eight rescuable holdings and no other candidate.
      //
      // The column x, the panel and the curated alias are the evidence here.
      // The alias set is a short, curated table and every row is a recorded
      // misread against a real frame, so the blast radius is bounded by the file.
      // The garble itself is in the reading: replace it, never join it.
      const rawIndex = accepted.indexOf(raw);
      if (rawIndex >= 0) {
        if (accepted.includes(canonical)) {
          // The canonical is already there; the garble is a second spelling
          // of the same holding and is dropped, not published.
          accepted.splice(rawIndex, 1);
        } else {
          accepted[rawIndex] = canonical;
        }
        const rejectedIndex = rejected.indexOf(raw);
        if (rejectedIndex >= 0) rejected.splice(rejectedIndex, 1);
        continue;
      }
      if (accepted.includes(canonical)) continue;
      // The garble never reached the reading — the column gate rejected it,
      // or the ticker-shape test rejected it for carrying a digit (QBT5,
      // GSI1, GS11, which are not ticker-shaped and so are never candidates
      // at all). The canonical takes its place.
      accepted.push(canonical);
      const rejectedIndex = rejected.indexOf(raw);
      if (rejectedIndex >= 0) rejected.splice(rejectedIndex, 1);
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

  // The panel's own row count, and how the reading compares with it.
  //
  // This is a self-check, and it is the panel's own statement rather than the
  // parser's: the footer says how many rows are on screen, and the reading
  // says how many tickers it found. `count_delta` is the difference.
  //
  //   delta  0   the reading has the panel's row count
  //   delta < 0   the reading is SHORT — a row was dropped
  //   delta > 0   the reading is LONG — a row was invented
  //
  // A delta of 0 does NOT mean the reading is right: two tickers can be
  // confused for one another and the count still matches. It means the reading
  // is not *provably* wrong, which is a weaker and more honest claim.
  //
  // The count is reported, never acted on. See `readPanelRowCount`.
  const panelCountInfo = readPanelRowCount(words, positionsLine, positionsHeaderY);
  const panelCount = panelCountInfo ? panelCountInfo.count : null;
  const panelCountDelta = panelCount != null ? filteredAccepted.length - panelCount : null;

  return {
    column_filter: dominantColumnX != null ? {
      column_width: columnWidth,
      dominant_x: dominantColumnX,
      dominant_left: dominantColumnLeft,
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
    // Diagnostic: the panel's OWN row count, read from its footer, and the
    // difference between it and the reading. `null` when the footer was not
    // read (no header detected, or the footer line was not recognised).
    //
    // This is a self-check on the reading, not a filter: the count is never
    // used to add or drop a ticker. See `readPanelRowCount` for why.
    panel_count: panelCount,
    panel_count_delta: panelCountDelta,
    panel_count_footer: panelCountInfo ? panelCountInfo.text : null,
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
    return { clusters: [], merged_list: [], dropped: [] };
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
  // The clusters that were dropped, and why. Populated only when the caller
  // asks for it (`explainDropped`), because it is a diagnostic and the probe
  // log does not need it by default.
  const droppedClusters = [];
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
    if (!canonical) {
      if (options.preferSupportedCorrection || options.preferVideoSupport) {
        // The SUPPORTED choice: among the cluster's admissible corrections,
        // prefer the one the VIDEO actually read. See
        // `selectSupportedCorrection` for the measured instance this exists
        // for, and for the two orderings it can use.
        canonical = selectSupportedCorrection(
          clusterCorrectionCandidates(members, lexicon, frequency),
          options.preferVideoSupport === true
        );
      } else {
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
      }
    }
    if (!canonical) {
      if (options.explainDropped) {
        droppedClusters.push({ members: [...members].sort(), canonical: null, reason: 'no_canonical' });
      }
      continue;
    }
    // A CORRECTED canonical -- one that is NOT a member of this cluster --
    // is the clusterer NAMING a ticker that no frame of the video read. That
    // is the defect class that publishes a wrong holding, and it is not the
    // same thing as a miss.
    //
    // The corroboration rule: a corrected canonical must be within edit
    // distance 1 of AT LEAST ONE cluster member. A member at distance 1 is
    // the ordinary case (INA -> TNA is distance 1). A correction that is only
    // reachable at distance 2 from every member is a guess dressed as a
    // repair, because at distance 2 there are usually SEVERAL plausible
    // canonicals and which one is chosen is decided by a tie-break
    // ("prefer the longer ticker") rather than by the pixels.
    //
    // The measured instance: on 20230605 the cluster {AACO, ARCO} was
    // published as `AAPL`, a seed ticker that is in NO capture's reading of
    // that video. AACO is 2 edits from AAPL and 2 from AAL; the longer-on-a-
    // tie rule chose AAPL, and the merged list published a holding the video
    // never showed. No member of that cluster is within distance 1 of AAPL.
    //
    // This rule DISCARDS such a cluster. `preferSupportedCorrection` RESOLVES
    // it instead: the cluster's OTHER member, ARCO, is 2 edits from ARQQ --
    // the holding the panel actually showed, and one the video read in six
    // frames -- so asking which correction the VIDEO supports recovers the
    // holding rather than throwing it away. The two rules answer the same
    // question -- "is this canonical corroborated?" -- and the second one
    // answers it with the right ticker when it can.
    //
    // OFF by default: the rule has to be MEASURED before it replaces the
    // shipped behaviour -- tightening it also stops corrections that are
    // real. `node tools/evalParserReplay.js --cluster-rule corroborated`
    // measures it over the recorded logs, with no OCR and no change to the
    // shared config files.
    if (options.requireDistanceOneCorroboration && !members.includes(canonical)) {
      let closest = Infinity;
      for (const m of members) {
        const d = levenshtein(m, canonical);
        if (d < closest) closest = d;
      }
      // A canonical the VIDEO read itself is corroborated by the video, even
      // when it is two edits from every member of this cluster. That is the
      // 20230605 case: ARQQ was read in six frames of that video, and the
      // cluster's member ARCO is two edits from it.
      //
      // Whether that counts as corroboration is a SEPARATE question from
      // whether the correction is close, and the two are measured apart:
      // `corroborationAllowsVideoSupport: false` demands the proximity test
      // alone.
      const videoSupport = frequency.get(canonical) || 0;
      const videoSupportCounts = options.corroborationAllowsVideoSupport !== false;
      if (closest > 1 && !(videoSupportCounts && videoSupport > 0)) {
        if (options.explainDropped) {
          droppedClusters.push({
            members: [...members].sort(),
            canonical,
            reason: 'uncorroborated_correction',
            distance: closest
          });
        }
        continue;
      }
    }
    // Blocklist filter: never surface a blocklisted ticker as canonical even
    // if all other cluster signals pass. Applied after canonical selection so
    // we don't waste effort on blocklisted clusters, but before Filter A.
    if (TICKER_BLOCKLIST.has(canonical)) {
      if (options.explainDropped) {
        droppedClusters.push({ members: [...members].sort(), canonical, reason: 'blocklisted' });
      }
      continue;
    }
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
    if (clusterFrames.size < minFrequency) {
      if (options.explainDropped) {
        droppedClusters.push({
          members: [...members].sort(),
          canonical,
          reason: 'filter_a',
          frames: clusterFrames.size,
          minFrequency
        });
      }
      continue;
    }
    const totalFreq = members.reduce((s, m) => s + (frequency.get(m) || 0), 0);
    // The SWALLOWED-HOLDING rule: a cluster can hold TWO distinct lexicon
    // tickers that are one edit apart, and the second one is swallowed by
    // the canonical.
    //
    // The recorded instance: on 20230522 and 20230523 the cluster table says
    // { canonical: "AI", members: ["AI", "LI"] } -- and BOTH `AI` and `LI` are
    // rows of that video's panel. They are one edit apart, so the clusterer
    // merged two different cells and published one of them; the other was
    // never published at all.
    //
    // The guard is what makes it safe. The swallowed ticker is published only
    // when the video read IT -- in enough frames of its own. The count is the
    // member's OWN frame count, not the cluster's: the canonical's frames
    // must not be credited to the swallowed ticker, or every member of a
    // well-attested cluster would look well-attested.
    //
    // The measured discriminator over the production cluster tables: a
    // swallowed ticker read in >= 4 frames of its own is a holding, one read
    // in <= 3 is a one-off garble (`NFU`, which is not a holding of its
    // video). Publishing every lexicon ticker in a cluster, with no guard, is
    // measured and REJECTED: it adds 24 false positives over the corpus.
    const extraCanonicals = [];
    if (options.publishSwallowedHoldings) {
      for (const m of members) {
        if (m === canonical) continue;
        if (!lexicon.tickerSet.has(m)) continue;
        const ownFrames = (tokenFrameIndices.get(m) || new Set()).size;
        if (ownFrames < options.swallowedHoldingMinFrames) continue;
        extraCanonicals.push(m);
      }
    }
    clusters.push({
      canonical,
      frameCount: clusterFrames.size,
      frequency: totalFreq,
      members: members.sort(),
      // The other lexicon tickers this cluster swallowed, and which of them
      // the rule published anyway. The counts are the EVIDENCE for the
      // decision, so they are recorded: without them a later reader cannot
      // tell why one swallowed ticker was published and another was not.
      extraCanonicals,
      swallowedEvidence: members
        .filter((m) => m !== canonical && lexicon.tickerSet.has(m))
        .map((m) => ({
          ticker: m,
          ownFrames: (tokenFrameIndices.get(m) || new Set()).size,
          published: extraCanonicals.includes(m),
        })),
    });
  }

  // Step 6: build merged list. The Filter A pass above already filtered
  // clusters by minFrequency; this is just the canonical → merged list.
  //
  // A cluster's EXTRA canonicals are published too -- that is the whole point
  // of the swallowed-holding rule: `LI` was a holding of that video, and
  // naming only `AI` lost it.
  const seen = new Set();
  const merged = [];
  for (const c of clusters) {
    if (!seen.has(c.canonical)) {
      seen.add(c.canonical);
      merged.push(c.canonical);
    }
    for (const extra of c.extraCanonicals || []) {
      if (seen.has(extra)) continue;
      seen.add(extra);
      merged.push(extra);
    }
  }
  merged.sort();

  return { clusters, merged_list: merged, dropped: droppedClusters };
}

// The VIDEO-level reading: the multi-frame clusterer's consensus.
//
// `merged_position_list` is the artifact the production consumers read
// (tools/runQmgOcrBatch.js and tools/aggregateScanResults.js), and it is the
// only reading that is repaired across frames. It has also disagreed with
// the per-capture reading three times on record -- `REGN`, `U` and `AAPL` --
// so it has to be measurable on its own.
//
// The recipe lives here, not in either caller, because there are two callers
// that must not drift apart:
//
//   * tools/scanVideoWithOcr.js -- production. It builds the per-frame input
//     from every OCR'd frame's position list.
//   * tools/evalParserReplay.js -- the offline replay, which rebuilds the
//     merged reading from a recorded log so a parser change can be measured
//     in seconds instead of 8-13 minutes of EasyOCR per video.
//
// A replay that clustered differently from production would be measuring a
// parser that does not exist.
//
// `input` is one string per frame: that frame's readings, joined. The
// snapshot branch of the scan tool joins a frame's `position_list` with
// spaces; the whiteboard branch passes raw OCR text, which is why this
// helper takes strings rather than token arrays.
//
// `minFrequency` is Filter A's threshold. When it is not given, the snapshot
// branch's rule applies: two frames by default, relaxed to one when only a
// single frame contributes -- the case where a filter that demands two
// would throw the whole consensus away.
function clusterVideoLevelReadings(input, options = {}) {
  const frames = (Array.isArray(input) ? input : []).filter(
    (text) => typeof text === 'string' && text.trim()
  );
  const minFrequency = Number.isFinite(options.minFrequency)
    ? options.minFrequency
    : Math.min(options.defaultMinFrequency || 2, Math.max(1, frames.length));
  if (!frames.length) {
    return { merged_list: [], clusters: [], dropped: [], minFrequency, frames: 0 };
  }
  const result = clusterRawOcrTokens(frames, {
    maxDistance: options.maxDistance || 1,
    minTokenLength: options.minTokenLength || 2,
    minFrequency,
    lexicon: options.lexicon || loadDecodeLexiconSync(),
    // Both OFF unless the caller asks. The corroboration rule changes which
    // holdings a scan publishes, so it has to be measured before it is
    // switched on -- see `clusterRawOcrTokens`.
    requireDistanceOneCorroboration: options.requireDistanceOneCorroboration === true,
    corroborationAllowsVideoSupport: options.corroborationAllowsVideoSupport !== false,
    preferSupportedCorrection: options.preferSupportedCorrection === true,
    preferVideoSupport: options.preferVideoSupport === true,
    publishSwallowedHoldings: options.publishSwallowedHoldings === true,
    swallowedHoldingMinFrames: Number.isFinite(options.swallowedHoldingMinFrames)
      ? options.swallowedHoldingMinFrames
      : 4,
    explainDropped: options.explainDropped === true
  });
  return {
    merged_list: result.merged_list,
    clusters: result.clusters,
    dropped: result.dropped || [],
    minFrequency,
    frames: frames.length
  };
}

// The NAME of a cluster rule.
//
// One implementation, used by BOTH the scan tool and the replay tool: the
// replay compares a log's recorded rule against the rule it is applying, so
// the two have to name the same combination the same way.
//
// They DID drift, twice. The first time the strict flag was checked BEFORE
// the supported one, so `supported+corroborated` under the strict flag was
// misnamed `corroborated-strict`. The second time the two named the
// swallowed rule differently (`swallowed+corroborated` against
// `corroborated+swallowed`), and a scan naming one of them died at
// startup.
//
// The switches are the RESOLVED booleans -- the caller resolves any
// tri-state (the scan tool's `--no-cluster-corroboration` against its
// on-by-default) before calling this.
function clusterRuleName(options = {}) {
  const parts = [];
  if (options.preferVideoSupport === true) parts.push('video-supported');
  else if (options.preferSupportedCorrection === true) parts.push('supported');
  if (options.requireDistanceOneCorroboration === true) {
    parts.push(options.corroborationAllowsVideoSupport === false ? 'corroborated-strict' : 'corroborated');
  }
  if (options.publishSwallowedHoldings === true) parts.push('swallowed');
  return parts.length ? parts.join('+') : 'shipped';
}

// Resolve the cluster-rule OPTIONS into the switches the rule runs on.
//
// The scan tool's CLI option is a TRI-STATE for the corroboration rule:
// `null` means "not mentioned", and the rule is ON by default, so
// `--no-cluster-corroboration` has to be able to turn it off. The strict
// flag is the VARIANT of that rule, so it implies corroboration.
//
// Resolving it in ONE place -- here -- means the clusterer, the rule name
// and the batch runner's flag table cannot disagree about which rule a scan
// ran. They have.
function resolveClusterRuleOptions(options = {}) {
  const strict = options.clusterStrictCorroboration === true;
  const corroboration = options.clusterCorroboration === null
    ? true
    : options.clusterCorroboration === true;
  return {
    requireDistanceOneCorroboration: corroboration || strict,
    corroborationAllowsVideoSupport: !strict,
    preferSupportedCorrection: options.clusterSupported === true,
    preferVideoSupport: options.clusterVideoSupported === true,
    publishSwallowedHoldings: options.clusterSwallowedHoldings === true,
    swallowedHoldingMinFrames: Number.isFinite(options.clusterSwallowedMinFrames)
      ? options.clusterSwallowedMinFrames
      : 4,
  };
}

module.exports = {
  hasPriceNear,
  identifyPositionListColumn,
  findCloseTickerMatch,
  mergeMultiplePositionLists,
  clusterRawOcrTokens,
  clusterVideoLevelReadings,
  clusterRuleName,
  resolveClusterRuleOptions,
  extractZoomStripTickerCandidates,
  parseChartStreamPositionList,
  extractAllTickerCandidates,
  readPanelRowCount,
  setOcrConfusionCsvPath,
  TICKER_BLOCKLIST
};
