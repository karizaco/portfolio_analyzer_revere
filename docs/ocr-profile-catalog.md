# OCR Profile Catalog

This repository now keeps the OCR experiment ideas in git as named pipeline profiles instead of only in chat history.

## One-command handoff

If another machine has the repo and dependencies, the easiest command is:

```bash
node tools/runOcrProfiles.js --set qmg-five-ideas --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 --date 20220606
```

That runs the current `legacy` control plus the five named QMG idea profiles.

To inspect the catalog without running OCR:

```bash
node tools/runOcrProfiles.js --list
```

To print the exact commands and environment only:

```bash
node tools/runOcrProfiles.js --set qmg-five-ideas --video data/video_pipeline/downloads_1080p/20220606_Axs8VyUKFRk.mp4 --date 20220606 --dry-run
```

## Profile set

- `qmg-five-ideas`
  - `legacy`
  - `qmg-prefilter-v1`
  - `qmg-crop-v1`
  - `qmg-easyocr-v1`
  - `qmg-consensus-v1`
  - `qmg-lexicon-v1`

## What each profile changes

- `legacy`
  - No experimental overrides; current proven baseline.

- `qmg-prefilter-v1`
  - Higher-density chart-stream prefilter search budget.
  - Reference: `docs/qmg-prefilter-comparison-2026-09-29.md`

- `qmg-crop-v1`
  - Uses the tighter validated chart-stream overlay crop.
  - Reference: `docs/qmg-ocr-crop-analysis.md`

- `qmg-easyocr-v1`
  - Switches the OCR engine to EasyOCR.
  - References: `docs/production-rollout.md`, `docs/qmg-easyocr-statistical-analysis.md`

- `qmg-consensus-v1`
  - Uses clustered adjacent captures so multi-frame consensus has more raw OCR signal.
  - Reference: `docs/qmg-multiframe-voting.md`

- `qmg-lexicon-v1`
  - Appends the Tier-1 QMG ticker additions in `config/ticker_lexicon_qmg_tier1.csv` to the seed lexicon.
  - Reference: `docs/lexicon-extension-proposal.md`

## Notes

- These profiles are intended to make the experiment set easy to run and reason about on another machine.
- They are tracked in `src/config/pipelineProfiles.js`.
- The wrapper script does not invent new ideas at runtime; it reads the checked-in profile catalog and expands the command lines directly.
- Not every profile is guaranteed to improve OCR quality. The goal here is reproducible comparison against `legacy`.