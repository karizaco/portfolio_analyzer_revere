# Roppel Signal Confidence — Calibration Notes

## Confidence Model

Every signal in `roppel_signals.csv` has a `confidence` score:

| Signal type | Formula |
|---|---|
| HOLDING | Always `1.0` (explicit disclosure = highest conviction) |
| IDEA | `min(mentions / 5, 0.8)` — 1 mention = 0.2, 5+ mentions = 0.8 |
| IDEA + chart_confirmed | `min(confidence × 1.2, 0.96)` — 1.2× boost, capped at 0.96 |

The chart OCR boost is applied when a ticker appears in ≥2 chart image OCR passes.

## Current Distribution (6 reports, March–June 2026)

```
HOLDING signals: 78 total
  chart-confirmed: 11 (14%)

IDEA signals: 67 total
  chart-confirmed: 21 (31%)

Confidence breakdown:
  1.0   (HOLDING):    78
  0.7–0.99:            7  (IDEA + chart-confirmed + multiple mentions)
  0.4–0.69:           15  (IDEA, 2–3 mentions)
  0.0–0.39:           45  (IDEA, 1 mention)
```

## Signal Tier Breakdown

- **HOLDING+IDEA (10 tickers):** Appear in both the disclosure page AND the actionable ideas section. High conviction — confirmed as explicit positions AND discussed as ideas.
  Examples: XBI, MRVL, GLW, SNDK, NBIS, AAPL, AMZN, ANET, ALAB, CIEN

- **HOLDING only (23 tickers):** Explicit positions disclosed, not discussed in ideas section. These may be longer-term holdings not currently highlighted.
  Examples: NVDA, ARM, BE, RKLB, GDX, GLD, TSLA, LLY, CRCL, SOL, etc.

- **IDEA only (39 tickers):** Appear only in the ideas section — watchlist tier. Confidence ranges from 0.2 (1 mention) to 0.96 (4+ mentions + chart-confirmed).
  Top by confidence: CRDO (0.96), SATS (0.72), TER (0.72), VRT (0.72), etc.

## Calibration Questions

When adding new PDFs, revisit these assumptions:

1. **Is the 1.2× chart boost still appropriate?**
   - Currently 31% of IDEA signals are chart-confirmed
   - Check: do chart-confirmed IDEA tickers actually appear in the same week's video or other sources?
   - If chart OCR is too noisy, consider raising the threshold to ≥3 appearances

2. **Should IDEA confidence cap at 0.8 or higher?**
   - A ticker mentioned 10 times in a report is not necessarily 2× more conviction than 5 mentions
   - Consider a log scale: `log(mentions + 1) / log(6) * 0.8`

3. **Should HOLDING signals have a chart-confirmed boost too?**
   - 14% of HOLDINGs are also chart-confirmed
   - A HOLDING+chart_confirmed ticker could warrant a `1.0` vs `0.96` distinction

4. **When does a ticker graduate from IDEA to HOLDING?**
   - Currently tracked separately by `signal_type`
   - A "cross-signal" tier (HOLDING+IDEA) could be auto-tagged when the same ticker appears in both sections across any report

## Recalibration Command

```bash
python - << 'PYEOF'
import csv
from collections import defaultdict

signals = []
with open('data/sources/roppel/roppel_signals.csv') as f:
    for row in csv.DictReader(f):
        signals.append(row)

h = sum(1 for s in signals if s['signal_type']=='HOLDING')
i = sum(1 for s in signals if s['signal_type']=='IDEA')
i_cc = sum(1 for s in signals if s['signal_type']=='IDEA' and s['chart_confirmed']=='true')
h_cc = sum(1 for s in signals if s['signal_type']=='HOLDING' and s['chart_confirmed']=='true')
print(f"HOLDING={h} (chart_confirmed={h_cc}, {100*h_cc/h:.0f}%)")
print(f"IDEA={i} (chart_confirmed={i_cc}, {100*i_cc/i:.0f}%)")
from collections import Counter
for lo, hi, label in [(1.0,1.0,'1.0'),(0.7,0.99,'0.7-0.99'),(0.4,0.69,'0.4-0.69'),(0.0,0.39,'0.0-0.39')]:
    n = sum(1 for s in signals if lo <= float(s['confidence']) <= hi)
    print(f"  {label}: {n}")
PYEOF
```
