# Revere Portfolio Extractor

This workspace contains a small Node.js CLI that reads the linked screenshot directory in read-only mode, OCRs each PNG, extracts the portfolio snapshot fields, and writes CSV outputs inside this workspace.

## Editable Inputs

- `config/ticker_lexicon_seed.csv`: recurring tickers that should be treated as known symbols during cleanup.
- `config/manual_ticker_overrides.csv`: exact per-file or global corrections for OCR mistakes. `replacement` accepts one ticker or a pipe-delimited list such as `TQQQ|IBIT`.

## Outputs

- `data/portfolio_snapshots.csv`: canonical extracted snapshot rows, one per dated screenshot.
- `data/review_queue.csv`: rows flagged for manual review because of missing fields or low OCR confidence.
- `data/position_events.csv`: holdings-derived entry and exit events by portfolio and day.
- `data/position_events_review.csv`: candidate events that were withheld from the trusted output because they conflict with action text or come from noisy holdings.

## Usage

1. Install dependencies:

```bash
npm install
```

2. Verify the linked screenshot inventory:

```bash
npm run discover
```

3. Run a small sample first:

```bash
npm run extract:sample
```

4. Run the full extraction:

```bash
npm run extract
```

## Notes

- `sample_screenshots.lnk` is intentionally kept local and ignored by git. Create your own local shortcut or use `--input-dir` / `--shortcut` when running the CLI.
- If `sample_screenshots.lnk` exists locally, the extractor resolves it automatically and only reads from its target.
- The linked screenshot folder is treated as read-only. All generated files stay under this workspace.
- Legacy `FOCUS` / `PORTFOLIO` screenshots are mapped into the `GRO` columns, with `TURBO` left empty.
- The first snapshot establishes a baseline. Position enter/exit events are only derived when a previous snapshot exists.
- Rows with low OCR confidence or missing core fields are written to `data/review_queue.csv` for manual cleanup rather than being dropped.
- When a row has explicit `BUY` or `SELL` signals, the trusted event file prefers those signals over raw holdings diffs. Unmatched diff-only events are pushed to `data/position_events_review.csv` instead.
