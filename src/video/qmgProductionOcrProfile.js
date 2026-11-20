'use strict';

/**
 * The locked production OCR profile for Qullamaggie chart-stream scans.
 *
 * WHY THIS EXISTS
 *
 * Batch runners, ad-hoc scans, work-queue suggested commands, and
 * historical log archaeology all drifted onto different defaults
 * (max-captures 2 vs 3, low-cpu optional vs required, cluster rules).
 * Coverage and queue decisions then depended on filename archaeology
 * rather than "was this video scanned with the current production
 * settings". One named profile is the source of those defaults.
 *
 * analysis_state is NOT this: that column only answers whether the
 * original media file is still needed. OCR progress lives in
 * ocr_scan_outcomes (see src/video/ocrScanOutcomeStore.js).
 */

const PROFILE_ID = 'qmg-production-v1';

const QMG_PRODUCTION_OCR_PROFILE = Object.freeze({
  profileId: PROFILE_ID,
  channel: 'qullamaggie',
  engine: 'easyocr',
  prefilterProfile: 'chart_stream',
  chartStreamParser: true,
  basename: 'qmg',
  outputKind: 'snapshot',
  fps: 0.25,
  prefilterMaxFrames: 12,
  maxCaptures: 2,
  // Matches tools/evalParserReplay.js --cluster-rule names.
  clusterRule: 'corroborated+swallowed',
  // EasyOCR + PyTorch must not fan out thread pools (CLAUDE.md).
  lowCpu: true,
  // Parallelism ceiling when lowCpu is on.
  maxParallel: 2,
  // Per-video wall budget for the batch supervisor (EasyOCR is slow).
  timeoutMs: 40 * 60 * 1000,
});

/**
 * CLI flags that encode the locked production profile.
 *
 * Does not include --video / --date / --output-root / --run-tag: those
 * are per-invocation. Does not include era-specific temporal-decay or
 * crop flags: the crop is derived inside the scan tool from the upload
 * date (src/video/chartStreamCrop.js), and the batch runner still
 * applies the sidebar temporal-decay=0 rule via flagsForDate.
 *
 * @param {{ maxFrames?: number, maxCaptures?: number }} [budget]
 * @returns {string[]}
 */
function productionScanFlags(budget = {}) {
  const maxFrames = budget.maxFrames != null
    ? budget.maxFrames
    : QMG_PRODUCTION_OCR_PROFILE.prefilterMaxFrames;
  const maxCaptures = budget.maxCaptures != null
    ? budget.maxCaptures
    : QMG_PRODUCTION_OCR_PROFILE.maxCaptures;

  return [
    '--prefilter-profile', QMG_PRODUCTION_OCR_PROFILE.prefilterProfile,
    '--chart-stream-parser',
    '--basename', QMG_PRODUCTION_OCR_PROFILE.basename,
    '--output-kind', QMG_PRODUCTION_OCR_PROFILE.outputKind,
    '--ocr-engine', QMG_PRODUCTION_OCR_PROFILE.engine,
    '--fps', String(QMG_PRODUCTION_OCR_PROFILE.fps),
    '--prefilter-max-frames', String(maxFrames),
    '--max-captures', String(maxCaptures),
  ];
}

/**
 * Suggested batch command for one or more YYYYMMDD dates.
 *
 * @param {string|string[]} dates
 * @param {{ parallel?: number, runTag?: string }} [options]
 * @returns {string}
 */
function productionBatchCommand(dates, options = {}) {
  const list = Array.isArray(dates) ? dates.filter(Boolean) : String(dates || '').split(',').filter(Boolean);
  if (!list.length) {
    throw new Error('productionBatchCommand needs at least one date');
  }
  const parallel = Math.max(
    1,
    Math.min(
      options.parallel != null ? Number(options.parallel) : QMG_PRODUCTION_OCR_PROFILE.maxParallel,
      QMG_PRODUCTION_OCR_PROFILE.lowCpu ? QMG_PRODUCTION_OCR_PROFILE.maxParallel : 8,
    ),
  );
  const parts = [
    'node tools/runQmgOcrBatch.js',
    `--dates ${list.join(',')}`,
    '--low-cpu',
    `--parallel ${parallel}`,
  ];
  if (options.runTag) parts.push(`--run-tag ${options.runTag}`);
  return parts.join(' ');
}

module.exports = {
  PROFILE_ID,
  QMG_PRODUCTION_OCR_PROFILE,
  productionBatchCommand,
  productionScanFlags,
};
