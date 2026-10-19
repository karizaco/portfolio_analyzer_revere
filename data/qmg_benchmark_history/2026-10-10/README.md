# QMG OCR Benchmark — 2026-10-10 (Tesseract vs EasyOCR)

Historical benchmark results from the first head-to-head comparison of the
two OCR engines against the Qullamaggie chart-stream parser, run on
Saturday 2026-10-10.

## What this is

A 2-video, 2-engine snapshot taken from the `portfolio_analyzer_revere_qmg_benchmark_kit`
sandbox before it was deleted. The runner script is now in `tools/runQmgCuratedBenchmark.js`
and can be re-run any time against the same videos to produce updated numbers.

## Cases

| Date       | Video                                   | Resolution | GT tickers                              |
|------------|-----------------------------------------|------------|-----------------------------------------|
| 20220606   | `downloads_1080p/20220606_ST8lvpOVjeM.mp4` | 1080p      | GOVX, LABU, UCO, ALB, CBIO, VLO, TNA, NFLX |
| 20221104   | `downloads_hires/20221104_9lzYgB-b9yE.mp4` | 720p hires | OIH                                     |

## Files

| File                                | Generated         | Engine    | Notes                                                |
|-------------------------------------|-------------------|-----------|------------------------------------------------------|
| `20220606_tesseract.json`           | 2026-10-10 20:07  | Tesseract | 5 captures, 0/8 GT (no_match on most captures)       |
| `20220606_easyocr.json`             | 2026-10-10 20:07  | EasyOCR   | 5 captures, parser found 3/8 visible in raw OCR      |
| `20220606_st8lvpovjem.json`         | 2026-10-10 19:54  | EasyOCR   | Earlier diagnostic run (3 captures, narrower scope)  |
| `20221104_9lzygb-b9ye.json`         | 2026-10-10 19:54  | Tesseract | 0 captures — prefilter rejected all frames (`status: no_match`) |

## Headline finding

> EasyOCR produces materially cleaner characters on QMG position-list text
> (no `SLETX`/`CBO`-style garble that Tesseract emits). However, the OCR
> engine is not the dominant bottleneck — the chart-stream prefilter still
> rejected all 20221104 frames regardless of engine. Recall floor on
> 20220606 was 0/8 (Tesseract) vs 3/8 (EasyOCR) at the time of this
> snapshot. Subsequent prefilter/parser work in
> `fix/cluster-overrides-capture-tickers` has since raised this; re-run
> the benchmark after that branch to see the current numbers.

## How to reproduce

```bash
# Default (Tesseract):
npm run qmg:benchmark:curated

# EasyOCR:
npm run qmg:benchmark:curated -- --easyocr
```

Outputs go to `artifacts/qmg_video_benchmark/REPORT.txt` and
`benchmark_results.json`.
