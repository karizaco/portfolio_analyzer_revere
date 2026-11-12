---
name: revere-ocr-progress
description: Revere whiteboard OCR accuracy status — 47 videos scanned, GT recall 63-86%, EasyOCR confirmed unhelpful, character merging root cause
metadata:
  type: project
  originSessionId: 85592b5a-0751-4168-87a4-d5984b62b725
  modified: 2026-10-04T15:43:44.479Z
---

# Revere OCR Accuracy Status

## 47 Videos Scanned (Oct 4, 2026 — batch 3 complete)

| Date | Status | Merged Tickers |
|------|--------|---------------|
| 20261002 | no_match | — |
| 20261001 | done | 45 |
| 20260930 | no_match | — |
| 20260929 | done | 49 |
| 20260928 | done | 52 |
| 20260926 | done | 16 (weekend OCR garbled) |
| 20260925 | done / no_match (2 videos) | 49 |
| 20260924 | done | 55 |
| 20260923 | done | 65 |
| 20260922 | done | 60 |
| 20260921 | done | 36 |
| 20260919 | NOT DOWNLOADED | — |
| 20260918 | no_match | — |
| 20260917 | done | 58 |
| 20260916 | done | 49 |
| 20260915 | done | 50 |
| 20260914 | done / no_match (2 videos) | 28 |
| 20260912 | no_match (2 videos) | — |
| 20260911 | done | 36 |
| 20260910 | done | 55 |
| 20260909 | done | 27 |
| 20260908 | done | 55 |
| 20260905 | no_match | — (weekend review) |
| 20260904 | done (2 videos) | 49 each |
| 20260903 | done | 34 |
| 20260902 | done | 28 |
| 20260901 | done | 55 |
| 20260831 | done | 29 |
| 20260830 | NOT IN DB | — |
| 20260829 | no_match | — (weekend review) |
| 20260828 | done / no_match (2 videos) | 43 |
| 20260827 | done | 51 |
| 20260826 | done | 24 |
| 20260825 | done | 56 |
| 20260824 | done | 30 |
| 20260822 | no_match | — (weekend review) |
| 20260821 | no_match | — (both videos) |
| 20260820 | done | 47 |
| 20260819 | NOT DOWNLOADED | — |
| 20260818 | done | 53 |
| 20260817 | STOPPED (partial) | — |
| 20260815 | no_match | — (weekend review) |
| 20260814 | done / no_match (2 videos) | — |
| 20260813 | STOPPED (partial) | — |

## GT Recall (4 ground-truth videos)

| Date | Frames | Merged Tickers | GT Recall |
|------|--------|---------------|-----------|
| 20260923 | 393 | 65 | **86%** (18/21) |
| 20260928 | 262 | 52 | **81%** (13/16) |
| 20260922 | 280 | 60 | **78%** (18/23) |
| 20260924 | 193 | 55 | **63%** (12/19) |

## Root Causes of Missed GT Tickers

**Single-frame tickers filtered by cluster-min-frequency=2:**
- `HPE`, `MU`, `P`, `TNA`, `U` — appear in only 1 of 5 frames
- `IBIT` — single-frame garble

**Tesseract OCR character merging (both engines affected — see below):**
- `NCLD` — merged into "TQQNCLD" with misaligned chars; DP split can't help
- `AMD` — similar OCR merge on 20260924
- `P` — trailing period strips to "UP." → "UP" → rejected as <5 chars

**Key insight:** `--cluster-min-frequency 1` fixes recall but causes 30+ min timeouts per video (floods clusterer with garbage). Not practical at scale.

## Why EasyOCR doesn't help Revere

Empirically tested: both Tesseract and EasyOCR produce the SAME character-merging problem on Revere whiteboard images.
- Tesseract reads "TQQNCLD"
- EasyOCR reads "TCOQNCLD"

Both engines physically merge adjacent tickers in the bounding box output. The positional parser's bounding-box filtering makes Revere robust to OCR quality, so EasyOCR's scene-text CNN advantage doesn't apply here. EasyOCR matters for Qullamaggie chart-stream where spatial separation is the only signal.

## Parser fixes (commit 7ae6002 + 1724cb6)

- **GRO section boundary**: Use `* GRO RVAB/REBAR:` action line as section end
- **TURBO section boundary**: Changed `indexOf('*')` to `indexOf('* ')` (asterisk+space)
- **Mode B section filter**: Added `tickerInSection` check to Mode B (next-row) extraction
- **DP ticker splitting**: `tryLexiconSplits()` handles aligned merges like "LITE.DOCN" → LITE + DOCN. Cannot split misaligned merges like "TQQNCLD" where ticker chars don't align with string positions.

## Scan Performance Notes

- **Conservative flags** (use these to avoid 30-min timeouts):
  `--max-captures 3 --fps 0.2 --prefilter-max-frames 10`
- Videos with 400+ frames need 5-8 min with these flags
- Zombie node processes (orphaned by timeouts) accumulate — 61 zombie nodes as of Oct 4 batch
- `--cluster-min-frequency 1` is too expensive for production use

## Remaining Work

~104 Revere videos still unprocessed (total DB: 151, scanned: 47).
Next batch dates to scan (in order, newest first):
- 20260930 (YiEcAWyATLA) — NOT DOWNLOADED, needs redownload
- 20260919 (aM57wbGKKqE) — NOT DOWNLOADED, needs redownload
- 20260821–20260817 (partially done, 20260817 stopped mid-scan)
- 20260814 etNNGIwqZWo (second video same day) — STOPPED, rerun
- 20260813 eWeJSMLlZLs — STOPPED, rerun
- Then dates 20260812 and older

**Not downloaded (NULL download_path in SQLite):** 20260930, 20260919
