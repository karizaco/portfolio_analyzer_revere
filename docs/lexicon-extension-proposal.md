# Seed Lexicon Extension Proposal (QMG)

Date: 2026-10-01

## Scope

- Lexicon file reviewed: `config/ticker_lexicon_seed.csv`
- Logs reviewed: rerun probe logs under `data/video_scan_test/_rerun/**/ocr_probe/logs/*.json`
- Known QMG benchmark dates:
  - 20220606
  - 20220607
  - 20220608
  - 20220614
  - 20221117
  - 20230126

## 1) Captured Tickers Not in Lexicon (Known Benchmark Dates)

From saved rerun captures (raw observed outputs):

- 20220606: `IAN` (4), `UO` (1), `OM` (1)
- 20220607: `RESOT` (2), `JUC` (1), `RISO` (1)
- 20220608: `RASC` (1), `RAS` (1)
- 20220614: none
- 20221117: none
- 20230126: `SQITX` (1)

Interpretation:

- These are overwhelmingly OCR artifacts, not missing lexicon coverage for the benchmark set.
- Action: do not add these to lexicon.

## 2) Ground-truth Coverage Check

For the six benchmark dates, all GT tickers are already present in `ticker_lexicon_seed.csv`.

So for the benchmark set, low recall is not due to missing seed symbols.

## 3) Candidate Additions from Broader QMG Ground-truth Universe

Across full `qmg_ground_truth.json`, multiple plausible QMG symbols are currently missing from lexicon. These are better extension candidates than OCR garbage tokens.

Recommended Tier 1 additions (high plausibility for QMG style / liquid thematic names):

- `KOLD` - inverse natgas ETF, style-consistent with `BOIL`
- `GUSH` - leveraged oil ETF, style-consistent with energy basket
- `ERX` - leveraged energy ETF, same theme
- `SPXL` - leveraged broad market ETF
- `XLV` - sector ETF often used in macro/theme views
- `KRE` - regional bank ETF
- `UPST` - momentum growth ticker with frequent OCR confusion potential
- `SOUN` - high-beta AI/momentum name
- `RGTI` - quantum/momentum name
- `IONQ` - quantum/momentum name
- `QBTS` - quantum/momentum name
- `ARQQ` - speculative momentum name

Recommended Tier 2 additions (add if seen in fresh captures, not just historical GT):

- `MNDY`, `GTLB`, `DNA`, `LAC`, `IBKR`, `VERU`, `NUZE`, `SWN`

Do not add by default (likely noise / uncertain labels):

- `FAULL`, `DCX` and similar malformed tokens from old snapshots.

## 4) Safe Rollout Process for Lexicon Updates

1. Add only Tier 1 first.
2. Re-run benchmark set and compare FP/recall deltas.
3. Promote Tier 2 only if repeatedly observed in new captures with price-nearby support.
4. Never add one-off non-lexicon tokens directly from a single OCR run.

## 5) Expected Impact

- Benchmark-set recall: likely unchanged (already fully covered).
- Broader historical coverage: improved recovery on older/uncommon QMG names.
- FP risk: controlled if additions are phased and validated.
