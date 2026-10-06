'use strict';

const path = require('node:path');

const PIPELINE_PROFILE_DEFAULT = 'legacy';

const PIPELINE_PROFILES = Object.freeze({
  legacy: Object.freeze({
    name: 'legacy',
    title: 'Current proven pipeline',
    family: 'shared',
    status: 'control',
    description: 'Use the current proven scanner behavior with no experimental overrides.',
    references: [],
    scanArgv: [],
    env: {}
  }),
  'qmg-experimental-v1': Object.freeze({
    name: 'qmg-experimental-v1',
    title: 'Legacy-compatible QMG experimental placeholder',
    family: 'qmg',
    status: 'placeholder',
    description: 'Original generic experimental QMG profile name. Prefer the explicit qmg-* idea profiles for new runs.',
    references: ['docs/production-rollout.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser'
    ],
    env: {}
  }),
  'whiteboard-experimental-v1': Object.freeze({
    name: 'whiteboard-experimental-v1',
    title: 'Legacy-compatible whiteboard experimental placeholder',
    family: 'whiteboard',
    status: 'placeholder',
    description: 'Original generic experimental whiteboard profile name. Reserved for future whiteboard-specific experiments.',
    references: [],
    scanArgv: [
      '--output-kind', 'whiteboard',
      '--prefilter-profile', 'whiteboard',
      '--basename', 'revere'
    ],
    env: {}
  }),
  'qmg-prefilter-v1': Object.freeze({
    name: 'qmg-prefilter-v1',
    title: 'QMG prefilter search-budget experiment',
    family: 'qmg',
    status: 'runnable-option-bundle',
    description: 'Chart-stream experiment focused on prefilter density and candidate budget, based on the documented prefilter comparison work.',
    references: ['docs/qmg-prefilter-comparison-2026-09-29.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser',
      '--fps', '1',
      '--prefilter-max-frames', '12',
      '--max-captures', '3'
    ],
    env: {}
  }),
  'qmg-crop-v1': Object.freeze({
    name: 'qmg-crop-v1',
    title: 'QMG crop-region experiment',
    family: 'qmg',
    status: 'runnable-option-bundle',
    description: 'Chart-stream experiment that applies the tighter validated overlay crop from the QMG crop analysis notes.',
    references: ['docs/qmg-ocr-crop-analysis.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser',
      '--phash-region-fraction', '0.87,0.58,0.13,0.40'
    ],
    env: {}
  }),
  'qmg-easyocr-v1': Object.freeze({
    name: 'qmg-easyocr-v1',
    title: 'QMG EasyOCR engine experiment',
    family: 'qmg',
    status: 'runnable-option-bundle',
    description: 'Chart-stream experiment that switches the OCR engine to EasyOCR while preserving the rest of the scan flow.',
    references: ['docs/production-rollout.md', 'docs/qmg-easyocr-statistical-analysis.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser',
      '--ocr-engine', 'easyocr'
    ],
    env: {}
  }),
  'qmg-consensus-v1': Object.freeze({
    name: 'qmg-consensus-v1',
    title: 'QMG multi-frame consensus experiment',
    family: 'qmg',
    status: 'runnable-option-bundle',
    description: 'Chart-stream experiment that biases the scan toward clustered adjacent captures so raw-token voting and consensus have more signal to work with.',
    references: ['docs/qmg-multiframe-voting.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser',
      '--batch-snapshots',
      '--batch-count', '5',
      '--batch-window', '4',
      '--cluster-min-frequency', '1',
      '--max-captures', '1'
    ],
    env: {}
  }),
  'qmg-lexicon-v1': Object.freeze({
    name: 'qmg-lexicon-v1',
    title: 'QMG Tier-1 lexicon extension experiment',
    family: 'qmg',
    status: 'runnable-option-bundle',
    description: 'Chart-stream experiment that appends the documented Tier-1 QMG ticker additions to the seed lexicon.',
    references: ['docs/lexicon-extension-proposal.md'],
    scanArgv: [
      '--output-kind', 'snapshot',
      '--prefilter-profile', 'chart_stream',
      '--basename', 'qmg',
      '--chart-stream-parser'
    ],
    env: {
      TICKER_LEXICON_APPEND_CSV: path.join('config', 'ticker_lexicon_qmg_tier1.csv')
    }
  })
});

const PIPELINE_PROFILE_SETS = Object.freeze({
  'qmg-five-ideas': Object.freeze([
    'legacy',
    'qmg-prefilter-v1',
    'qmg-crop-v1',
    'qmg-easyocr-v1',
    'qmg-consensus-v1',
    'qmg-lexicon-v1'
  ])
});

function getPipelineProfile(name) {
  const profile = PIPELINE_PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown pipeline profile: ${name}`);
  }
  return profile;
}

function getPipelineProfileNames() {
  return Object.keys(PIPELINE_PROFILES);
}

function getPipelineProfileSet(name) {
  const profileSet = PIPELINE_PROFILE_SETS[name];
  if (!profileSet) {
    throw new Error(`Unknown pipeline profile set: ${name}`);
  }
  return profileSet;
}

function getPipelineProfileSetNames() {
  return Object.keys(PIPELINE_PROFILE_SETS);
}

module.exports = {
  PIPELINE_PROFILE_DEFAULT,
  PIPELINE_PROFILES,
  PIPELINE_PROFILE_SETS,
  getPipelineProfile,
  getPipelineProfileNames,
  getPipelineProfileSet,
  getPipelineProfileSetNames
};