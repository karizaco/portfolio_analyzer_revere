/**
 * Experiment A5: Test ticker post-correction via edit-distance to seed lexicon
 *
 * Method:
 * 1. Load seed lexicon from config/ticker_lexicon_seed.csv
 * 2. For each of the 27 probe captures, extract raw ocr_text
 * 3. Find all uppercase token-like strings (4-5 chars) NOT already in seed lexicon
 * 4. Compute Levenshtein distance from each token to ALL seed tickers
 * 5. Flag tokens where min distance <= 2 as correction candidates
 * 6. Report candidates, closest matches, missed real tickers, recommendation
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = 'C:\\Users\\admin\\Projects\\portfolio_analyzer_revere';
const LOGS_DIR = path.join(PROJECT_ROOT, 'data/video_ocr_probe/qmg-1080p-batch1/ocr_probe/logs');
const LEXICON_PATH = path.join(PROJECT_ROOT, 'config/ticker_lexicon_seed.csv');
const ANALYSIS_PATH = path.join(PROJECT_ROOT, 'data/video_ocr_probe/analysis.json');

// Levenshtein distance
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_,i) => Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

// Load seed lexicon (CSV with header: ticker,note)
const seedLexicon = new Set(
  fs.readFileSync(LEXICON_PATH, 'utf8')
    .split('\n')
    .slice(1) // skip header
    .map(line => {
      const ticker = line.split(',')[0].trim().toUpperCase();
      return ticker;
    })
    .filter(line => line.length >= 2 && line.length <= 5 && /^[A-Z]+$/.test(line))
);
console.log(`Seed lexicon size: ${seedLexicon.size} tickers`);

// Strict ticker pattern: uppercase, 2-5 letters, no digits/special chars
const TICKER_RE = /^[A-Z]{2,5}$/;

// Extract uppercase 4-5 char tokens that look like tickers but are NOT in lexicon
function extractCandidateTokens(ocrText) {
  const tokens = new Set();
  // Find all contiguous uppercase alphabetic sequences of length 2-5
  const matches = ocrText.matchAll(/[A-Z]{2,5}/g);
  for (const m of matches) {
    const t = m[0];
    if (TICKER_RE.test(t) && !seedLexicon.has(t)) {
      tokens.add(t);
    }
  }
  return tokens;
}

// Find min edit distance to any seed ticker
function findClosestSeed(token) {
  let minDist = Infinity;
  let closest = null;
  for (const seed of seedLexicon) {
    // Length filter: if diff > 2, can't be <= 2 anyway (unless same length diff)
    if (Math.abs(token.length - seed.length) > 2) continue;
    const d = levenshtein(token, seed);
    if (d < minDist) {
      minDist = d;
      closest = seed;
    }
  }
  return { minDist, closest };
}

// Load all probe log files
const logFiles = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'));
console.log(`Found ${logFiles.length} probe log files`);

// Also load known tickers from analysis.json for ground truth
const analysis = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
const allKnownTickers = new Set(analysis.totals.unique_tickers);
console.log(`Known captured tickers from analysis.json: ${[...allKnownTickers].sort().join(', ')}`);

// Track all candidates across all captures
const allCandidates = []; // { token, minDist, closest, file, captureIdx, ocrTextSnippet }
const capturedTickersMissedByParser = []; // tokens that ARE real tickers but weren't in parser output

// Process each log file
for (const logFile of logFiles.sort()) {
  const logPath = path.join(LOGS_DIR, logFile);
  const logData = JSON.parse(fs.readFileSync(logPath, 'utf8'));

  const captures = logData.captures || [];
  for (let ci = 0; ci < captures.length; ci++) {
    const cap = captures[ci];
    const ocrText = cap.ocr_text || '';
    const parsedTickers = new Set(cap.tickers || []);
    const tokens = extractCandidateTokens(ocrText);

    for (const token of [...tokens]) {
      const { minDist, closest } = findClosestSeed(token);
      if (minDist <= 2) {
        // Check if this is actually a real ticker that was missed
        const isRealTicker = allKnownTickers.has(token);
        allCandidates.push({
          token,
          minDist,
          closest,
          file: logFile,
          captureIdx: ci,
          ocrTextSnippet: ocrText.substring(0, 120).replace(/\n/g, ' ').trim(),
          isRealTicker,
          wasParsed: parsedTickers.has(token)
        });

        if (isRealTicker && !parsedTickers.has(token)) {
          capturedTickersMissedByParser.push({
            token,
            minDist,
            closest,
            file: logFile,
            captureIdx: ci
          });
        }
      }
    }
  }
}

// Report
console.log('\n========== EXPERIMENT A5 RESULTS ==========\n');
console.log(`Total correction candidates (min edit dist <= 2): ${allCandidates.length}`);
console.log(`  - Candidates that are actual real tickers: ${allCandidates.filter(c => c.isRealTicker).length}`);
console.log(`  - Candidates that are NOT real tickers: ${allCandidates.filter(c => !c.isRealTicker).length}`);
console.log(`\nReal tickers missed by parser: ${capturedTickersMissedByParser.length}`);
for (const m of capturedTickersMissedByParser) {
  console.log(`  ${m.token} -> ${m.closest} (dist=${m.minDist}) in ${m.file}[${m.captureIdx}]`);
}

// Breakdown by distance
const byDist = {};
for (const c of allCandidates) {
  byDist[c.minDist] = (byDist[c.minDist] || 0) + 1;
}
console.log('\nCandidates by edit distance:');
for (const d of [1, 2]) {
  console.log(`  dist=${d}: ${byDist[d] || 0}`);
}

// Show top candidates with distance=1
const dist1 = allCandidates.filter(c => c.minDist === 1 && !c.isRealTicker);
console.log(`\nDistance-1 candidates (likely OCR errors, not real tickers): ${dist1.length}`);
if (dist1.length > 0) {
  const unique = [...new Map(dist1.map(c => [c.token, c])).values()];
  console.log('Unique distance-1 tokens:');
  for (const c of unique.slice(0, 30)) {
    console.log(`  "${c.token}" -> "${c.closest}" (dist=1)`);
  }
}

// Show distance-2 candidates that are not real tickers
const dist2NotReal = allCandidates.filter(c => c.minDist === 2 && !c.isRealTicker);
console.log(`\nDistance-2 candidates (not real tickers): ${dist2NotReal.length}`);
if (dist2NotReal.length > 0) {
  const unique = [...new Map(dist2NotReal.map(c => [c.token, c])).values()];
  console.log('Unique distance-2 tokens (top 30):');
  for (const c of unique.slice(0, 30)) {
    console.log(`  "${c.token}" -> "${c.closest}" (dist=2)`);
  }
}

// Cross-reference: for each capture, were any real tickers in ocr_text but not in parsedTickers?
console.log('\n========== MISSED TICKER ANALYSIS ==========\n');
const missedRealTickers = [];
for (const logFile of logFiles.sort()) {
  const logPath = path.join(LOGS_DIR, logFile);
  const logData = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const captures = logData.captures || [];
  for (let ci = 0; ci < captures.length; ci++) {
    const cap = captures[ci];
    const ocrText = cap.ocr_text || '';
    const parsedTickers = new Set(cap.tickers || []);
    const tokens = extractCandidateTokens(ocrText);
    for (const t of tokens) {
      if (allKnownTickers.has(t) && !parsedTickers.has(t)) {
        missedRealTickers.push({ token: t, file: logFile, captureIdx: ci });
      }
    }
  }
}
console.log(`Real tickers present in OCR text but not captured: ${missedRealTickers.length}`);
for (const m of missedRealTickers) {
  console.log(`  "${m.token}" in ${m.file}[${m.captureIdx}]`);
}

console.log('\n========== RECOMMENDATION ==========\n');
const falsePositiveRate = allCandidates.filter(c => !c.isRealTicker).length / Math.max(allCandidates.length, 1);
const realTickerRecovery = capturedTickersMissedByParser.length;
console.log(`Correction candidates: ${allCandidates.length}`);
console.log(`False positive rate: ${(falsePositiveRate * 100).toFixed(1)}%`);
console.log(`Real tickers recovered (that parser missed): ${realTickerRecovery}`);
if (allCandidates.length > 0 && falsePositiveRate < 0.5 && realTickerRecovery > 0) {
  console.log('RECOMMENDATION: Edit-distance correction is USEFUL - low false positive rate with real ticker recovery.');
} else if (allCandidates.length > 0 && falsePositiveRate >= 0.5) {
  console.log('RECOMMENDATION: Edit-distance correction has HIGH FALSE POSITIVE RATE - most candidates are noise.');
} else if (realTickerRecovery === 0) {
  console.log('RECOMMENDATION: No real tickers were missed by the parser - edit-distance correction may not be needed for this corpus.');
} else {
  console.log('RECOMMENDATION: Mixed results - further tuning needed.');
}

console.log('\n========== SAMPLE OCR FRAGMENTS WITH CANDIDATES ==========\n');
const samples = allCandidates.filter(c => c.minDist === 1).slice(0, 5);
for (const s of samples) {
  console.log(`"${s.token}" -> "${s.closest}" (dist=1)`);
  console.log(`  File: ${s.file}[${s.captureIdx}]`);
  console.log(`  OCR: ${s.ocrTextSnippet}`);
  console.log('');
}
