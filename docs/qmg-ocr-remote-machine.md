# Running QMG OCR on a Remote (High-CPU) Machine

## Overview

This document covers how to run the QMG EasyOCR batch on a different computer
that has ample CPU (not the low-CPU machine). The `--low-cpu` flag must NOT
be used there — it is only for the machine that cannot handle parallel threading.

## Quick Start

### 1. Clone and sync

```bash
git clone https://github.com/karizaco/portfolio_analyzer_revere.git
cd portfolio_analyzer_revere
git checkout fix/cluster-overrides-capture-tickers
git pull  # keep in sync with this machine
```

### 2. Install dependencies

```bash
npm install

# Verify EasyOCR works:
python -c "import easyocr; print('EasyOCR OK')"
# If not installed:
pip install easyocr opencv-python numpy torch
```

### 3. Sync video files

Videos are in two directories. **Check both** — some 2022-era dates are in hires:

```bash
# Check which files you need:
ls data/video_pipeline/downloads_1080p/ | grep -E "^(20220414|20220418|20220419|20220421|20220425|20220426|20220428|20220506|20220510|20220517|20220606|20220614|20221117|20230601|20220323)"
ls data/video_pipeline/downloads_hires/ | grep -E "^(20220414|20220418|20220419|20220421|20220425|20220426|20220428|20220506|20220510|20220517|20220606|20220614|20221117|20230601|20220323)"
```

**Rsync to remote:**
```bash
rsync -avz --progress \
  data/video_pipeline/downloads_1080p/ \
  user@remote:/path/to/portfolio_analyzer_revere/data/video_pipeline/downloads_1080p/

rsync -avz --progress \
  data/video_pipeline/downloads_hires/ \
  user@remote:/path/to/portfolio_analyzer_revere/data/video_pipeline/downloads_hires/
```

### 4. Sync ground truth and data dir

```bash
rsync -avz --progress data/ user@remote:/path/to/portfolio_analyzer_revere/data/
```

### 5. Run the batch — NO --low-cpu!

```bash
cd portfolio_analyzer_revere

# Run the 16 remaining dates (split into chunks of 4):
node tools/runQmgOcrBatch.js \
  --dates 20220414,20220418,20220419,20220421 \
  --parallel 4

node tools/runQmgOcrBatch.js \
  --dates 20220425,20220426,20220428,20220506 \
  --parallel 4

node tools/runQmgOcrBatch.js \
  --dates 20220510,20220517,20220606,20220614 \
  --parallel 4

node tools/runQmgOcrBatch.js \
  --dates 20220323,20221117,20230601 \
  --parallel 4
```

**IMPORTANT: Do NOT use `--low-cpu` on this machine.** That flag is only
for the low-CPU machine.

### 6. Copy results back

```bash
# On the REMOTE machine, rsync results back:
rsync -avz --progress \
  data/video_ocr_probe/qmg-easyocr-YYYYMMDD/ \
  user@this-machine:/path/to/portfolio_analyzer_revere/data/video_ocr_probe/
```

### 7. Score results locally

On THIS machine, after copying results back:

```bash
node -e "
const fs = require('fs');
const gt = require('./data/qmg_ground_truth.json');
const logDir = 'data/video_ocr_probe/qmg-easyocr-YYYYMMDD/ocr_probe/logs';
let totalHit=0, totalGT=0;
const files = fs.readdirSync(logDir);
for (const f of files) {
  if (!f.endsWith('.json')) continue;
  const log = JSON.parse(fs.readFileSync(logDir+'/'+f,'utf8'));
  if (log.status === 'error') continue;
  const date = f.slice(0,8);
  const gtEntry = gt[date];
  if (!gtEntry) continue;
  const merged = new Set(log.merged_position_list||[]);
  const gtTickers = [...new Set(Object.values(gtEntry).flatMap(v=>v.tickers||[]))];
  const hit = gtTickers.filter(t=>merged.has(t));
  totalHit+=hit.length; totalGT+=gtTickers.length;
  console.log(date+' '+hit.length+'/'+gtTickers.length+' | '+hit.join(','));
}
console.log('TOTAL: '+totalHit+'/'+totalGT+' ('+Math.round(100*totalHit/totalGT)+'%)');
"
```

---

## Remaining Dates to Scan (16 total)

| Date | Video File | Notes |
|------|-----------|-------|
| 20220414 | `downloads_1080p/20220414_mKkOtiFjc_E.mp4` | 2022-era |
| 20220418 | `downloads_1080p/20220418_KQplQq01oy0.mp4` | 2022-era |
| 20220419 | `downloads_1080p/20220419_yn2pIMXdFg8.mp4` | 2022-era |
| 20220421 | `downloads_1080p/20220421_BMl5Ml24crg.mp4` | 2022-era |
| 20220425 | `downloads_1080p/20220425_s6jdpRmrGck.mp4` | 2022-era |
| 20220426 | `downloads_1080p/20220426_uDfm0ClZ8yE.mp4` | 2022-era |
| 20220428 | `downloads_1080p/20220428_PquLytys1k4.mp4` | 2022-era |
| 20220506 | `downloads_1080p/20220506_NtIRVae1Igo.mp4` | 2022-era |
| 20220510 | `downloads_1080p/20220510_3ZRiHbMRr0w.mp4` | 2022-era |
| 20220517 | `downloads_1080p/20220517_eX7XDCdoa0c.mp4` | 2022-era |
| 20220606 | `downloads_1080p/20220606_Axs8VyUKFRk.mp4` OR `20220606_ST8lvpOVjeM.mp4` OR `20220606_aaIlqb7HUJQ.mp4` | Has 3 files — scan ALL 3 |
| 20220614 | `downloads_1080p/20220614_faG8Mb_tV9g.mp4` | 2022-era |
| 20220323 | `downloads_1080p/20220323_Xsk8dD6eoEA.mp4` | Low-CPU machine did 64% |
| 20221117 | `downloads_1080p/20221117_sN_vorSS83c.mp4` | Late 2022-era |
| 20230601 | `downloads_1080p/20230601_1HFPeLD2zwc.mp4` | 2023-era, wide crop + temporal-decay=0 |

### Notes on 20220606
There are 3 video files for 20220606. Run all 3:
```bash
node tools/runQmgOcrBatch.js \
  --dates 20220606,20220606b,20220606c \
  --parallel 4
```

### Notes on 20230601
This is a 2023-era date — it needs:
- Wide crop: `--phash-region-fraction 0.83,0.55,0.17,0.45`
- No temporal decay: `--temporal-decay 0`

The batch runner applies these automatically via `WIDE_CROP_DATES`.

---

## Already Scanned (26 dates)

| Date | Score | Source |
|------|-------|--------|
| 20220218 | 6/10 (60%) | Prior run |
| 20220222 | 4/7 (57%) | Prior run |
| 20220223 | ~5/11 (45%) | Prior run |
| 20220301 | 4/11 (36%) | Prior run |
| 20220302 | ~4/7 (57%) | Prior run |
| 20220318 | ~4/7 (57%) | Prior run |
| 20220321 | ~4/8 (50%) | Prior run |
| **20220323** | **7/11 (64%)** | Low-CPU machine |
| 20220330 | 6/8 (75%) | Prior run |
| 20220331 | 5/8 (63%) | Prior run |
| 20220405 | 6/11 (55%) | Prior run |
| 20220406 | 4/8 (50%) | Prior run |
| **20220412** | **7/11 (64%)** | Low-CPU machine |
| 20220413 | ~5/11 (45%) | Prior run |
| 20220427 | ~2/3 (67%) | Prior run |
| 20220429 | ~2/5 (40%) | Prior run |
| 20220607 | 4/7 (57%) | Prior run |
| 20220608 | 4/9 (44%) | Prior run |
| 20221104 | 1/1 (100%) | Prior run |
| 20230126 | 3/8 (38%) | Prior run |
| 20230518 | 5/8 (63%) | Prior run |
| 20230522 | 3/7 (43%) | Prior run |
| 20230523 | 5/11 (45%) | Prior run |
| 20230602 | 5/12 (42%) | Prior run |
| 20230605 | 7/11 (64%) | Prior run |
| 20230608 | 2/13 (15%) | Prior run |
| 20230609 | 5/13 (38%) | Prior run |

**Low-CPU machine results (2022-era, 5 dates):** 29/49 = 59%

---

## Flag Settings

| Era | Dates | temporal-decay | Crop |
|-----|-------|---------------|------|
| 2022-era | 20220218 – 20220517 | 1800 (boost early) | Default (0.86,0.55,0.14,0.45) |
| 2023-era | 20230518 – 20230609 | 0 (no bias) | Wide (0.83,0.55,0.17,0.45) |

The batch runner (`runQmgOcrBatch.js`) applies the correct flags automatically.

Default EasyOCR settings used:
- `--max-captures 3 --batch-snapshots --batch-count 5 --batch-window 4`
- `--fps 0.25 --prefilter-max-frames 12`
- `--ocr-engine easyocr`

---

## Common commands

```bash
# Chunk 1 (4 dates)
node tools/runQmgOcrBatch.js \
  --dates 20220414,20220418,20220419,20220421 \
  --parallel 4

# Chunk 2 (4 dates)
node tools/runQmgOcrBatch.js \
  --dates 20220425,20220426,20220428,20220506 \
  --parallel 4

# Chunk 3 (4 dates)
node tools/runQmgOcrBatch.js \
  --dates 20220510,20220517,20220606,20220614 \
  --parallel 4

# Chunk 4 (4 dates, 20220606x3 + 2023-era + late 2022)
node tools/runQmgOcrBatch.js \
  --dates 20220323,20220606,20220606b,20220606c,20221117,20230601 \
  --parallel 4

# Dry run (verify what would run)
node tools/runQmgOcrBatch.js --all-unscanned --parallel 4 --dry-run
```

---

## Notes

- 2022-era videos are in `downloads_1080p/` but are actually 720p (1280×720) on disk
- EasyOCR takes ~60s/frame on CPU; with `--max-captures 3 --batch-count 5` expect ~10-15 min/video
- With 4 parallel workers, each chunk of 4 dates finishes in ~15-20 min
- 20220606 has 3 video files — all need scanning to cover the full stream
