---
name: qmg-layout-scoped-aliases
description: "A garbled form that is a REAL ticker in one QMG layout era can still be aliased in another — via config/ticker_ocr_confusions_right_sidebar.csv, gated by layoutAliasEraForDate (20230518-20231215 only)"
metadata:
  node_type: memory
  type: project
  originSessionId: 909a4330-b5c4-47fe-b9c1-83296bf43698
  modified: 2026-11-04T11:05:11.687Z
---

Added 2026-11-04 (uncommitted at time of writing): `U -> LI` for the 2023
right-sidebar layout only. The shared alias table forbids a garbled form
that is a lexicon ticker (U is a real holding on 20221117, 2022 floating
panel), so it lives in a separate, layout-scoped table.

- Table: `config/ticker_ocr_confusions_right_sidebar.csv`; parser takes
  `parseChartStreamPositionList({ ocr, layoutEra })`, merged via
  `aliasMapForLayout()`.
- Gate: `layoutAliasEraForDate()` in `src/video/chartStreamCrop.js` returns
  'right_sidebar' ONLY for 20230518..20231215. Deliberately narrower than
  `chartStreamEraForDate()` (which says sidebar for ANY later/unknown date):
  `qmg-fixed-20260921c` dated QMG videos by RUN date 20260921, and those may
  be 2022 uploads where U is real.
- Measured (replay, `--no-layout-aliases` is the A/B switch): default
  83/85 -> 84/85 at 100% precision; wide +1 hit, -1 FP; 20230518 8/8,
  20230523 loses the U FP. No date regressed.
- The replay's default cluster rule was also aligned to the scan tool's
  `corroborated+swallowed`.

**Extended 2026-11-05 — the floating-panel table, and the two rows that
were not.** The same pattern rescues the June 2022 captures:

- Table: `config/ticker_ocr_confusions_floating_panel_nfu.csv`, gated by
  `layoutAliasEraForDate()` returning `floating_panel_nfu_20220606_08` for
  **20220606–20260608 only**.
- Rows: `NFU -> NFLX` and `NF -> NFLX`. Both are pixel-verified: the panels
  read NFLX on all three dates. `NFU` is a real seed ticker, so a shared row
  would violate the no-shadow invariant. `NF` is the SAME cell read as two
  glyphs on 20220607 — and because NF is one edit from NFU, the distance-1
  repair would otherwise publish NFU, a real ticker and the wrong holding.
- Blast radius measured over the whole corpus: `NF` occurs ONCE (20220607
  ts=296) and `NFU` eight times, all inside the window.
- The shared table also gained `UNA -> TNA` (20220608, T rendered as U).
  UNA is one edit from DNA as well, and DNA IS a real ticker, so the repair
  was publishing DNA at random. DNA is genuinely held only on the 2023 dates
  (20230523, 20230601, 20230602, 20230605, 20230608, 20230609), where UNA never
  occurs.
- Measured (replay, 40-date rescan corpus): the alias tables are +7 hits and
  −8 false positives (330/360 -> 337/360, fp 19 -> 11). On the 32-date
  rescan corpus the layout table alone is +4 recall and `UNA -> TNA` removes
  exactly one false positive, at no recall cost.

**Why:** a whole class of misreads (collapsed cells that happen to be valid
tickers) was declared unreachable by an invariant that is really per-layout.
**How to apply:** before rejecting an alias because the garbled form is a
lexicon ticker, check whether it is a real holding in THAT layout's dates;
if not, a layout-scoped row is legal. Related: [[qmg-pixel-verified-aliases]],
[[qmg-2022-era-alias-rows]].
