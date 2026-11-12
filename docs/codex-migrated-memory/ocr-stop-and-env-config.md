---
name: ocr-stop-and-env-config
description: Stop mechanism verified + EasyOCR KMP env var + ffmpeg binary copy fix
metadata:
  node_type: memory
  type: reference
  originSessionId: 898e9339-ec4d-4a06-b26a-676eda7cf28d
  modified: 2026-10-11T11:10:02.151Z
---

# OCR Stop / Kill / Env Config

## Stop mechanism

`TaskStop` (Claude Code background task kill) works cleanly:
- `[killed]` appears in the scan's stdout
- No orphan `python.exe` or `ffmpeg.exe` processes remain
- `KMP_DUPLICATE_LIB_OK=TRUE` must be set before killing, otherwise EasyOCR exits with code 3 on restart

**Critical:** EasyOCR Python subprocess MUST have `KMP_DUPLICATE_LIB_OK=TRUE` env var set. Without it, every EasyOCR call fails with:
```
OMP: Error #15: Initializing libiomp5md.dll, but found libiomp5md.dll already initialized.
```

**Required prefix for all EasyOCR runs:**
```bash
KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js ... --ocr-engine easyocr
```

## FFmpeg binary copy fix

The `tools/ffmpeg.exe` symlink was missing (broke after some update). `mklink` requires admin privileges so fall back to binary copy:

```bash
cp "C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe" tools/ffmpeg.exe
cp "C:/Users/admin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffprobe.exe" tools/ffprobe.exe
```

This should be automated in the ffmpeg path resolution or a setup script so it doesn't regress.

## Known issue: clusterer FP bleed

The `clusterRawOcrTokens` runs on raw `ocr_text` (chart + position list combined) at `scanVideoWithOcr.js:1373-1374`:
```javascript
clusterResult = clusterRawOcrTokens(
  (scanResult.topCandidates || []).map((c) => c.ocr_text || ''), ...
```

This means chart-area tickers (CF, XOM, ON, P, SI, SPYM, BOIL, SIGA, etc.) slip through the lexicon gate — they ARE real tickers, so the lexicon check passes. The per-frame `position_list` correctly filters to the position-list column, but the clusterer override uses raw text instead.

Fix: use per-frame `position_list` arrays for clustering instead of raw `ocr_text`. See `[[qmg-ocr-crop-analysis]]` for related context.
