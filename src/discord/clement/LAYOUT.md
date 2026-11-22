# Clement Daily Market Plan — layout (human-verified 2026-11-22)

Source: user inspection of dashboard screenshots + setup charts under
`data/discord_pipeline/media/clement/`.

## Dashboard (~2989×2120 "Daily Market Plan")

Do **not** OCR the full page as one top-to-bottom text stream for the
watchlist. The page is a **two-column layout**.

### Vertical split (do this first)

1. Find the vertical gutter of white space between:
   - **left:** gray-backed content cells (borders + whitespace between blocks)
   - **right:** blue-and-white monitor table(s)
2. Crop / OCR the **left half** for ideas and narrative blocks.
3. Crop / OCR the **right half** separately for market monitor tables.

### Left half (primary — ideas / plan content)

Typical stack (gray cells, separated by borders and white space):

1. **Header** — "Daily Market Plan" + date + Franklin quote  
2. **1. Market Trend** — checklist of YES/NO signal rows (verified: all five
   can be YES on a given day; sample 2026-01-09 was all YES)  
3. **Market commentary** prose  
4. **Technical Theme of The Market**  
5. **2. Primary Watchlist** — this is a **section header**, not the S&P table.
   The body under it is theme/focus content (e.g. "Metal Miners, Other
   Commodities, Argentina, China (Robotics)", Long: theme lines, tickers).  
6. Further left-column blocks as posted (focus lists, long ideas, etc.)

### Right half (market monitor — not the primary watchlist)

- **"S&P 500 Sub-Market Performance"** (and similar) is a **market monitor
  table**, not the Primary Watchlist body.  
- **"S&P 500 Sub-Sector Performance"** / situational tables sit here too.  
- Sector ETF codes (XLE, XLK, …) OCR relatively cleanly; % columns are noisier.

### OCR notes (dashboards)

- Full-page EasyOCR still recovers title, Market Trend YES/NO, and many
  sector codes, but **mis-assigns Primary Watchlist vs Sub-Market table**
  if read line-by-line without the split.  
- Watchlist ticker symbols on the left often garble (leading S, O/0, AI→Al).  
- Prefer caption cashtags + left-half crop + lexicon repair for tickers.

## Setup / idea charts (~2k wide TradingView-style)

Verified examples (message `1407919000381423686`, 2025-08-21):

| file | asset |
|---|---|
| `...8998687060018.png` | **ETHUSDT** |
| `...8999559340262.png` | **IWM** |
| `...9000113123368.png` | **TEM** |

### Ticker text on chart

- Chart **ticker** label is often **dark gray on light gray** → EasyOCR fails
  most of the time.  
- **Black title text** usually repeats the instrument as a **name**, not a
  ticker, e.g. `Ethereum / TetherUS 1D KuCoin` for ETHUSDT.  
- Use that name line (plus Discord caption `$ETHUSD` / `$TEM`) as the
  reliable path; do not depend on gray-on-gray ticker OCR.

### Caption still wins for multi-chart posts

One Discord message can attach several charts; the long caption lists
tickers and thesis. Chart OCR is secondary identification of *which image
is which name*.

## Measured split (2026-11-22 probe)

On two 2989×2120 Daily Market Plan PNGs, the white gutter peaks at
**x ≈ 1271 (42.5% width)**. Method: column white-fraction smoothed, max in
band 35–72% of width (`white_gutter`).

Left crop OCR (EasyOCR, max width 1100) recovered:
- all five Market Trend YES/NO rows
- "2. Primary Watchlist" + Focus Themes / Focus List (`Long: …`)
- Situational + Emotional sections

Right crop OCR recovered:
- S&P Sub-Market / Sub-Sector tables and sector ETF codes
- Market Commentary (often sits on the right of the header band)

Code: `src/discord/clement/dashboardSplit.js`,
`parseDashboardLeft.js`, `tools/clementDashboardSplitOcr.py`.
