'use strict';

// The prefilter MEASURES a rectangle, and the rectangle it measures used to
// be a hard-coded fallback that started to the RIGHT of the 2023-era
// sidebar's ticker column. This test pins the era-conditional rectangle that
// replaced it.
//
// The prefilter is what decides which frames get OCR'd, and the capture is
// then chosen by the OCR score. So a prefilter that ranks frames on pixels
// the OCR never sees does not merely score them badly — it decides which
// frames are read at all. Measured on 20230609 (the production smoke scan of
// 2026-11-02): the prefilter's best frame read ZERO holdings, while the
// frame that read the date's 13 ground-truth holdings exactly was near the
// BOTTOM of the candidates.
//
// The rectangle is the CROP's rectangle — the pixels the OCR engine reads —
// so the prefilter measures what it is going to OCR.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CHART_STREAM_CROP_FLOATING_PANEL,
  CHART_STREAM_CROP_RIGHT_SIDEBAR,
  chartStreamCropFractionForDate,
  chartStreamPrefilterRegionForDate,
} = require('../src/video/chartStreamCrop');
const { parseFractionalRegion } = require('../src/video/ocrScanArgs');

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

// The hard-coded fallback `summarizeLumaBuffer` used when a profile carries
// no `tickerRegion` of its own. The `chart_stream` profile never carried
// one, so this is what every chart-stream frame was measured against.
const LEGACY_FALLBACK = { left: 0.85, top: 0.55 };

// The measured ticker columns, in SOURCE pixels of a 1920x1080 frame. These
// are the same measurements `test/chartStreamCropCoverage.test.js` pins for
// the crop; they are repeated here because the prefilter's rectangle is a
// DIFFERENT question — it must contain the ticker column, and the crop's
// rectangle is only the means to that end.
const MEASURED_TICKER_COLUMNS = [
  { layout: 'floating panel', era: '2022', symColumn: [1795, 1812], rows: [660, 940] },
  { layout: 'right sidebar B', era: '2023', symColumn: [1706, 1712], rows: [661, 934] },
  { layout: 'right sidebar A', era: '2023', symColumn: [1617, 1628], rows: [661, 934] },
  { layout: "right sidebar A'", era: '2023', symColumn: [1585, 1613], rows: [736, 934] },
];

/**
 * The prefilter's rectangle is bottom-right-anchored: `left` is its left
 * edge, `top` its top edge, and it runs to the frame's right and bottom
 * edges (see `summarizeLumaBuffer` in src/video/ocrScanLogic.js).
 */
function pixelWindow(region) {
  return {
    left: Math.round(region.left * FRAME_WIDTH),
    top: Math.round(region.top * FRAME_HEIGHT),
    right: FRAME_WIDTH,
    bottom: FRAME_HEIGHT,
  };
}

test("the era's prefilter rectangle contains that era's measured ticker column", () => {
  for (const layout of MEASURED_TICKER_COLUMNS) {
    const dateKey = layout.era === '2023' ? '20230518' : '20220218';
    const window = pixelWindow(chartStreamPrefilterRegionForDate(dateKey));
    const [colLeft, colRight] = layout.symColumn;
    const [rowTop] = layout.rows;

    assert.ok(
      window.left <= colLeft,
      `${layout.layout}: the prefilter rectangle starts at x=${window.left}, but the ticker column starts at `
      + `x=${colLeft} — the rectangle would measure the price column of a panel it cannot see the tickers in`
    );
    assert.ok(
      window.right >= colRight,
      `${layout.layout}: the prefilter rectangle ends at x=${window.right}, but the ticker column ends at x=${colRight}`
    );
    assert.ok(
      window.top <= rowTop,
      `${layout.layout}: the prefilter rectangle starts at y=${window.top}, but the first position row is at y=${rowTop}`
    );
  }
});

test('the legacy fallback EXCLUDED two of the three sidebar columns', () => {
  // This is the defect the era rule replaced, pinned so the rectangle cannot
  // silently regress to the fallback: the fallback starts at source x 1632,
  // and the sidebar's ticker column starts at 1617 (layout A) and 1585
  // (layout A') — to the LEFT of it.
  const window = pixelWindow(LEGACY_FALLBACK);
  assert.equal(window.left, 1632);

  const sidebarA = MEASURED_TICKER_COLUMNS.find((l) => l.layout === 'right sidebar A');
  const sidebarAp = MEASURED_TICKER_COLUMNS.find((l) => l.layout === "right sidebar A'");
  assert.ok(
    window.left > sidebarA.symColumn[0],
    'the fallback is expected to exclude the sidebar-A ticker column'
  );
  assert.ok(
    window.left > sidebarAp.symColumn[0],
    'the fallback is expected to exclude the sidebar-A\' ticker column'
  );

  // …and it did catch only layout B, which is why the defect was invisible on
  // the one date that was scanned first.
  const sidebarB = MEASURED_TICKER_COLUMNS.find((l) => l.layout === 'right sidebar B');
  assert.ok(window.left <= sidebarB.symColumn[0]);
});

test('the prefilter rectangle is the crop rectangle\'s origin', () => {
  // The invariant is "the prefilter measures the pixels the OCR will read".
  // Both eras must satisfy it, so the rectangle cannot drift from the crop.
  for (const [dateKey, fraction] of [
    ['20220218', CHART_STREAM_CROP_FLOATING_PANEL],
    ['20230609', CHART_STREAM_CROP_RIGHT_SIDEBAR],
  ]) {
    const crop = parseFractionalRegion(fraction);
    const region = chartStreamPrefilterRegionForDate(dateKey);
    assert.equal(region.left, crop.x, `${dateKey}: the prefilter's left edge is not the crop's`);
    assert.equal(region.top, crop.y, `${dateKey}: the prefilter's top edge is not the crop's`);
    assert.equal(
      chartStreamPrefilterRegionForDate(dateKey).left,
      parseFractionalRegion(chartStreamCropFractionForDate(dateKey)).x
    );
  }
});

test('the two eras get different rectangles, and an unknown date gets the sidebar one', () => {
  const floating = chartStreamPrefilterRegionForDate('20220218');
  const sidebar = chartStreamPrefilterRegionForDate('20230609');
  // The eras differ HORIZONTALLY only, and that is the dimension Qullamaggie
  // moved: the panel's first row is at y 660 in BOTH eras (0.611 of the
  // frame), but its ticker column runs at x 1795 in the 2022-era floating
  // panel and at x 1585-1712 in the 2023-era right sidebar.
  assert.notEqual(floating.left, sidebar.left);
  assert.equal(floating.top, sidebar.top);

  // The sidebar rectangle is the safer fallback: it reaches further left, so
  // it contains the 2022-era floating panel too.
  assert.ok(sidebar.left < floating.left);
  for (const unknown of ['', '   ', null, undefined, 'not-a-date', '2023051']) {
    assert.deepEqual(
      chartStreamPrefilterRegionForDate(unknown),
      sidebar,
      `an unknown date (${JSON.stringify(unknown)}) must fall back to the sidebar rectangle`
    );
  }
});

test('the prefilter rectangle is a valid fractional region', () => {
  for (const dateKey of ['20220218', '20230518', '20230609', '20231215']) {
    const region = chartStreamPrefilterRegionForDate(dateKey);
    assert.ok(region.left >= 0 && region.left < 1, `${dateKey}: left out of frame`);
    assert.ok(region.top >= 0 && region.top < 1, `${dateKey}: top out of frame`);
  }
});
