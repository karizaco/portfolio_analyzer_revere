# Multi-frame RAW OCR Voting for QMG Chart-stream

Date: 2026-10-01

## Why `mergeMultiplePositionLists` Was Not Enough

`mergeMultiplePositionLists` merges already-accepted ticker lists and keeps names that repeat across captures.

Problem:

- If each frame is garbled differently, accepted lists become disjoint.
- Real signal is still present in raw OCR text, but not in accepted outputs.

Example failure mode:

- Frame A accepts `ALB`, `TNA`
- Frame B accepts `CBIO`, `UCO`
- Intersection-based merge under-reports true holdings.

## How `clusterRawOcrTokens` Works

Implemented in `src/parse/parseChartStream.js`.

Pipeline:

1. Collect ticker-shape tokens from each frame's raw OCR text.
2. Dedupe within each frame.
3. Build frequency map across frames.
4. Cluster tokens using Union-Find where edit distance <= `maxDistance`.
5. Pick canonical ticker per cluster:
   - prefer lexicon member
   - otherwise nearest lexicon correction within threshold
6. Drop clusters with no valid canonical.
7. Return sorted merged list.

Why Union-Find is used:

- Clustering by pairwise edit-distance forms connected components.
- Union-Find makes this linear-ish after O(N^2) pair checks and is simple to reason about.

## `maxDistance` Guidance

### Use `maxDistance = 1` (default for production scans)

Best when:

- You want to avoid over-merging unrelated tokens.
- Lexicon is broad and contains many near-neighbor symbols.

Benefit:

- Lower false-positive propagation through bridge tokens.

### Use `maxDistance = 2` (diagnostic mode)

Best when:

- OCR is very noisy and single-edit linkage is insufficient.
- You are investigating missed recoveries on a bounded test set.

Risk:

- Can merge semantically unrelated short tokens through transitive links.

Rule of thumb:

- Start at 1.
- Increase to 2 only if recall loss is clearly due to near-miss token variants and FP growth stays acceptable.

## Example Clusters from 20220606

From `no_col_filter_v25_20220606` and related rerun logs, multi-frame raw voting surfaces clusters with canonicals such as:

- `ALB`
- `BOIL`
- `CBIO`
- `COIN`
- `GOVX`
- `LABU`
- `UCO`
- `VLO`

Observed behavior:

- Canonicals recover several true symbols (`GOVX`, `LABU`, `CBIO`) even when per-frame accepted lists are inconsistent.
- Some FP canonicals can still survive (`COIN` in this set), so downstream confidence thresholds still matter.

## Tuning Checklist for New Video Batches

1. Keep crop and prefilter stable first.
2. Compare `merged_position_list` vs `merged_raw_token_list` against GT.
3. Track two KPIs:
   - recall lift from raw voting
   - FP delta from raw voting
4. If FP rises faster than recall, lower distance back to 1 and tighten candidate frame pool.
5. Prefer feeding raw voting with stronger candidate frames (not all low-score candidates).

## Practical Notes

- Raw voting is a recovery layer, not a substitute for good frame selection.
- When timestamp selection is poor, raw voting tends to amplify wrong context tokens.
- Best results come from: good prefilter -> plausible captures -> raw voting consolidation.
