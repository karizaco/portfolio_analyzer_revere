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
# Install Node.js deps
npm install

# Install EasyOCR Python deps (if not already installed)
# Requires Python with PyTorch + OpenCV + NumPy
pip install easyocr opencv-python numpy torch  # or use existing conda env

# Verify EasyOCR works:
python -c "import easyocr; print('EasyOCR OK')"
```

### 3. Sync video files (optional but recommended)

The videos live in `data/video_pipeline/downloads_1080p/` and
`data/video_pipeline/downloads_hires/`. You can either:

**Option A — rsync over network** (fast if on same LAN):
```bash
# On THIS machine (the low-CPU one), run:
rsync -avz --progress \
  data/video_pipeline/downloads_1080p/ \
  user@remote:/path/to/portfolio_analyzer_revere/data/video_pipeline/downloads_1080p/

rsync -avz --progress \
  data/video_pipeline/downloads_hires/ \
  user@remote:/path/to/portfolio_analyzer_revere/data/video_pipeline/downloads_hires/
```

**Option B — work over network share** (no sync needed):
Mount the project directory via SMB/network share and run directly.
The remote machine just needs access to the video files.

### 4. Sync ground truth

```bash
# Copy GT file
scp user@this-machine:/path/to/qmg_ground_truth.json \
      user@remote:/path/to/portfolio_analyzer_revere/data/

# Or copy the whole data dir
rsync -avz --progress data/ user@remote:/path/to/portfolio_analyzer_revere/data/
```

### 5. Run the batch — NO --low-cpu!

```bash
# Navigate to project
cd portfolio_analyzer_revere

# Run a chunk of dates (e.g. 5 at a time)
node tools/runQmgOcrBatch.js \
  --dates 20220302,20220318,20220321,20220405,20220406 \
  --parallel 4 \
  --chunk 1

# Or run all unscanned dates:
node tools/runQmgOcrBatch.js --all-unscanned --parallel 4
```

**IMPORTANT: Do NOT use `--low-cpu` on this machine.** That flag is only
for the low-CPU machine. On this machine, EasyOCR should use all available
cores.

### 6. Copy results back

After each chunk, copy the scan output back:

```bash
# On the REMOTE machine, scp the results:
scp -r data/video_ocr_probe/qmg-easyocr-YYYYMMDD/ \
      user@this-machine:/path/to/portfolio_analyzer_revere/data/video_ocr_probe/

# OR rsync the whole probe dir:
rsync -avz --progress \
  data/video_ocr_probe/qmg-easyocr-YYYYMMDD/ \
  user@this-machine:/path/to/portfolio_analyzer_revere/data/video_ocr_probe/
```

### 7. Score results locally

On THIS machine, after copying results back:

```bash
# Score all results
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

## File locations

| File | Location |
|------|----------|
| GT file | `data/qmg_ground_truth.json` |
| 2022-era videos | `data/video_pipeline/downloads_1080p/` (720p files on disk despite dir name) |
| 2023-era videos | `data/video_pipeline/downloads_1080p/` |
| Scan output | `data/video_ocr_probe/qmg-easyocr-YYYYMMDD/ocr_probe/logs/` |

## Date ranges

| Era | Dates | temporal-decay |
|-----|-------|---------------|
| 2022-era (pre-mid-2023) | 20220218 – 20220517 | 1800 (boost early frames) |
| 2023-era (mid-2023+) | 20230518 – 20230609 | 0 (no bias) |

The batch script applies the correct `--temporal-decay` automatically per date.

## Common commands

```bash
# Run specific dates
node tools/runQmgOcrBatch.js --dates 20220302,20220318,20220321,20220405,20220406 --parallel 4

# Run next chunk
node tools/runQmgOcrBatch.js --chunk 2 --parallel 4

# Dry run (shows what would run)
node tools/runQmgOcrBatch.js --all-unscanned --parallel 4 --dry-run

# Run a single video directly (no batch runner)
KMP_DUPLICATE_LIB_OK=TRUE node tools/scanVideoWithOcr.js \
  --video data/video_pipeline/downloads_1080p/20220302_BAlC_cRvESM.mp4 \
  --date 20220302 --run-tag qmg-easyocr-YYYYMMDD \
  --prefilter-profile chart_stream --chart-stream-parser \
  --basename qmg --output-kind snapshot \
  --ocr-engine easyocr \
  --fps 0.25 --prefilter-max-frames 12 --max-captures 3 \
  --batch-snapshots --batch-count 5 --batch-window 4 \
  --temporal-decay 1800
```

## Notes

- 2022-era videos on disk are actually 720p (1280×720) despite being in `downloads_1080p/`
- 2023-era dates need wide crop (`--phash-region-fraction 0.83,0.55,0.17,0.45`) — batch applies this automatically
- EasyOCR takes ~60s/frame on CPU; with full CPU, `--max-captures 3 --batch-count 5` finishes in ~10-15 min/video
- With 4 parallel workers, expect ~5-10 videos per hour
