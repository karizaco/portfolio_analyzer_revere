'use strict';

// The chart-stream crop rectangle — and the fact that there are TWO of them.
//
// Qullamaggie changed the layout of his position list between 2023-01-26 and
// 2023-05-18. Before the change it was a floating panel in the bottom-right
// corner of the chart frame; after it, a table docked to the RIGHT edge of the
// screen. The two layouts do not share a column.
//
// The panel geometry, measured off the pixels of the pinned ground-truth
// frames (the OCR word boxes mapped back to source pixels):
//
//   layout          Sym column (source x of 1920)   rows (source y of 1080)
//   floating panel  1795 - 1812                     660 - 940
//   right sidebar   1586 - 1712                     661 - 934
//
// (The sidebar column moves: 1707-1712 on 20230609 and 20231201, 1617-1628 on
// 20230518 / 20230523 / 20230605 / 20230608, 1586-1613 on 20231215. The
// 2022-era panel is stable at 1795-1812.)
//
// The OLD default, `0.86,0.62,0.14,0.22`, is source x 1651-1920, y
// 670-907. It therefore had TWO separate defects:
//
//   * the X window starts to the RIGHT of the sidebar column, so a sidebar-era
//     frame reads ZERO holdings under it — measured 27 of 56 ground-truth
//     holdings across five pinned 2023-era dates, and 0/13 on 20230608 and
//     0/11 on 20230523 under EVERY y variant of x=0.86;
//   * the Y window clips the first and last row of a long list in BOTH eras —
//     measured 11/16 on 20220421, whose panel runs y 664-934.
//
// One rectangle cannot serve both eras, because a crop wide enough for the
// sidebar (x >= 1586) also admits the 2022-era chart ink that fills x
// 1574-1780, and the chart ink costs the 2022 era real holdings. So the crop
// is chosen by the layout era, and the era is read off the upload date.
//
// The era boundary sits in the catalog's own gap: Qullamaggie published
// nothing at all between 2023-01-26 and 2023-05-18, so no video can be
// mis-assigned by the threshold.
//
// Both rectangles are the TIGHTEST crop that still covers the measured panel
// row range, so that neither admits chart ink the panel does not need:
//
//   floating panel   x 1651 - 1920   y 648 - 950   (rows 660 - 940)
//   right sidebar    x 1574 - 1920   y 648 - 994   (rows 661 - 934)
//
// Measured with a fresh EasyOCR pass over the pinned ground-truth frames
// (nine 2022-era frames / 85 holdings, seven 2023-era frames / 75 holdings):
//
//   crop                            era    hits        fp   precision
//   0.86,0.62,0.14,0.22  (old)     2022    74/85      18    80.4 %
//   0.86,0.60,0.14,0.28  (shipped) 2022    78/85      19    80.4 %
//   0.86,0.60,0.14,0.32            2022    80/85      24    76.9 %
//   0.86,0.55,0.14,0.45            2022    80/85      26    75.5 %
//   0.83,0.60,0.17,0.32            2022    76/85      23    76.8 %
//   0.86,0.62,0.14,0.22  (old)     2023    27/56      10    73.0 %
//   0.82,0.60,0.18,0.32  (shipped) 2023    69/75       8    89.6 %
//   0.82,0.60,0.18,0.28            2023    69/75       8    89.6 %
//   0.83,0.60,0.17,0.32            2023    70/75       9    88.6 %
//   0.82,0.55,0.18,0.36            2023    62/68      15    80.5 %
//
// The capture DEDUP hashes the same rectangle (`pickTopDistinctCandidates`
// skips a candidate whose overlay pHash is within Hamming 6 of an already
// picked one), so a rectangle that is too generous makes two DIFFERENT
// position lists look alike and the second capture is thrown away. Measured
// over the 70 distinct-ground-truth capture pairs in the pinned manifest:
//
//   crop                            collapsed pairs   min Hamming
//   0.86,0.62,0.14,0.22  (old)             0              14
//   0.86,0.60,0.14,0.28  (shipped)         1               4
//   0.86,0.60,0.14,0.32                     4               4
//   0.83,0.60,0.17,0.32                     1               6
//   0.82,0.60,0.18,0.32  (shipped)         0               8
//
// This module deliberately holds NO dependency on the OCR stack: `sharp` and
// the EasyOCR adapter stay out of it, so `src/video/ocrScanArgs.js` can
// require it without pulling a subprocess-spawning module into every CLI
// parse.

const CHART_STREAM_CROP_FLOATING_PANEL = '0.86,0.60,0.14,0.28';
const CHART_STREAM_CROP_RIGHT_SIDEBAR = '0.82,0.60,0.18,0.32';

// The first upload date that used the right-sidebar layout. It is the first
// video of the era — 20230518 — and the last video of the old era is
// 20230126, four months earlier.
const CHART_STREAM_RIGHT_SIDEBAR_FROM = '20230518';

/**
 * Is this date in the right-sidebar era?
 *
 * An unknown or malformed date IS treated as the sidebar era — the same
 * fallback the crop uses, and for the same reason, which is asymmetric: the
 * sidebar crop still contains the 2022-era floating panel (x 1574-1920 covers
 * x 1795-1812), so it reads that panel, just with more chart ink beside it.
 * The floating-panel crop does NOT contain the sidebar column at all, so it
 * reads a sidebar frame as EMPTY.
 *
 * The era is decided in ONE place (`chartStreamEraForDate`), because the crop
 * and the per-date flags have to agree: a date that gets the sidebar crop
 * and the floating-panel flags would be scanned with two different layouts.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {boolean}
 */
function isRightSidebarDate(dateKey) {
  return chartStreamEraForDate(dateKey) === 'right_sidebar';
}

/**
 * Which layout era does this date use?
 *
 * The single source of truth for the era question. Everything that has to
 * follow the era — the crop rectangle, the prefilter's measurement rectangle,
 * the per-date scan flags — derives its answer from here.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {'right_sidebar'|'floating_panel'}
 */
function chartStreamEraForDate(dateKey) {
  const key = String(dateKey || '').trim();
  if (!/^20\d{6}$/.test(key)) return 'right_sidebar';
  return key >= CHART_STREAM_RIGHT_SIDEBAR_FROM ? 'right_sidebar' : 'floating_panel';
}

/**
 * The fractional crop rectangle for a given upload date.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {string} the region as `"x,y,w,h"` fractions of the frame
 */
function chartStreamCropFractionForDate(dateKey) {
  return chartStreamEraForDate(dateKey) === 'right_sidebar'
    ? CHART_STREAM_CROP_RIGHT_SIDEBAR
    : CHART_STREAM_CROP_FLOATING_PANEL;
}

// The prefilter's measurement rectangle, per era.
//
// The prefilter measures a bottom-right-anchored rectangle (see
// `summarizeLumaBuffer` in src/video/ocrScanLogic.js): `left` is the LEFT
// edge, `top` the TOP edge, and the rectangle runs to the frame's right and
// bottom edges. It is the rectangle the prefilter counts mid-tone pixels and
// row transitions in.
//
// It used to be a hard-coded fallback, `left: 0.85, top: 0.55`, for every
// chart-stream frame. That rectangle starts at source x 1632, and the
// 2023-era sidebar's Sym column does not start there:
//
//   sidebar A  (20230518, 20230523, 20230605, 20230608)  x 1617 - 1628
//   sidebar A' (20231215)                                x 1585 - 1613
//   sidebar B  (20230609, 20231201)                      x 1706 - 1712
//
// So the fallback rectangle excluded the ticker column ENTIRELY for two of
// the three sidebar layouts, and caught only layout B. It measured the price
// and %-Change columns of a panel it could not see the tickers in.
//
// The rectangle is now the CROP's rectangle — the same pixels the OCR engine
// will read — so the prefilter measures what it is going to OCR:
//
//   2022-era  left 0.86  top 0.60   (floating panel, Sym column x 1795-1812)
//   2023-era  left 0.82  top 0.60   (right sidebar,  Sym column x 1585-1712)
//
// The 2022-era floating panel's column (1795-1812, i.e. 0.935-0.944) and the
// 2023-era sidebar's (1585-1712, i.e. 0.826-0.896) both sit inside the
// rectangle their era gets, with margin on both sides.

/**
 * The prefilter's measurement rectangle for a given upload date.
 *
 * The rectangle is bottom-right-anchored: `left` is its left edge and `top`
 * its top edge, and it runs to the frame's right and bottom edges.
 *
 * @param {string} dateKey an `YYYYMMDD` upload date
 * @returns {{left: number, top: number}} the region's left and top fractions
 */
function chartStreamPrefilterRegionForDate(dateKey) {
  const key = String(dateKey || '').trim();
  const fraction = chartStreamCropFractionForDate(key);
  const [x, y] = fraction.split(',').map((part) => Number(part));
  return { left: x, top: y };
}

module.exports = {
  CHART_STREAM_CROP_FLOATING_PANEL,
  CHART_STREAM_CROP_RIGHT_SIDEBAR,
  CHART_STREAM_RIGHT_SIDEBAR_FROM,
  chartStreamCropFractionForDate,
  chartStreamEraForDate,
  chartStreamPrefilterRegionForDate,
  isRightSidebarDate,
};
