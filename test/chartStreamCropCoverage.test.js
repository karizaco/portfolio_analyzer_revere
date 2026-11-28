'use strict';

// The chart-stream crop is ERA-CONDITIONAL, and the boundary between the two
// rectangles is a fact about Qullamaggie's channel, not about the code. This
// test pins three things:
//
//   1. COVERAGE — each shipped rectangle actually covers the panel it is
//      responsible for, measured off the pixels of the pinned ground-truth
//      frames (the OCR word boxes mapped back to source pixels).
//   2. THE ERA GAP — the threshold sits inside a gap in the catalog, so no
//      video can be mis-assigned to the wrong layout.
//   3. THE FALLBACK — an unknown date gets the sidebar crop, because that is
//      the safer of the two (it still contains the 2022-era floating panel,
//      while the floating-panel crop does NOT contain the sidebar column).
//
// The crop is also the capture-dedup rectangle, so a rectangle that is too
// generous makes two DIFFERENT position lists look alike. That is measured
// in src/video/chartStreamCrop.js's doc comment; what is pinned here is the
// geometry.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const {
  CHART_STREAM_CROP_FLOATING_PANEL,
  CHART_STREAM_CROP_RIGHT_SIDEBAR,
  CHART_STREAM_RIGHT_SIDEBAR_FROM,
  chartStreamCropFractionForDate,
  isRightSidebarDate,
} = require('../src/video/chartStreamCrop');
const { parseFractionalRegion } = require('../src/video/ocrScanArgs');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

// The frame is 1920x1080. The measured geometry below is in SOURCE pixels of
// that frame; the crop is a fraction of it.
const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

// The four layouts that have been measured off the pinned frames' pixels.
// `symColumn` is the x-range of the ticker column; `rows` is the y-range the
// position rows occupy.
//
// The x-ranges are the LEFT edge of the column that matters: a crop that
// starts to the right of it shaves the first glyph off every ticker, which
// turns "PDD" into "TX" and every holding in the list into a wrong one.
//
//   layout          symColumn (source x)      rows (source y)      dates
//   floating panel  1795 - 1812               660 - 940            20220218 .. 20230126
//   sidebar B       1706 - 1712               661 - 934            20230609, 20231201
//   sidebar A       1617 - 1628               661 - 934            20230518, 20230523, 20230605, 20230608
//   sidebar A'      1585 - 1613               736 - 934            20231215
const MEASURED_LAYOUTS = [
  {
    layout: 'floating panel',
    era: '2022',
    symColumn: [1795, 1812],
    rows: [660, 940],
    dates: ['20220218', '20220222', '20220421', '20220419', '20220608', '20220606', '20221104', '20230126'],
  },
  {
    layout: 'right sidebar B',
    era: '2023',
    symColumn: [1706, 1712],
    rows: [661, 934],
    dates: ['20230609', '20231201'],
  },
  {
    layout: 'right sidebar A',
    era: '2023',
    symColumn: [1617, 1628],
    rows: [661, 934],
    dates: ['20230518', '20230523', '20230605', '20230608'],
  },
  {
    layout: "right sidebar A'",
    era: '2023',
    symColumn: [1585, 1613],
    rows: [736, 934],
    dates: ['20231215'],
  },
];

function cropFor(era) {
  return parseFractionalRegion(
    era === '2023' ? CHART_STREAM_CROP_RIGHT_SIDEBAR : CHART_STREAM_CROP_FLOATING_PANEL
  );
}

/** The crop's pixel window on a 1920x1080 frame. */
function pixelWindow(region) {
  return {
    left: Math.round(region.x * FRAME_WIDTH),
    top: Math.round(region.y * FRAME_HEIGHT),
    right: Math.round((region.x + region.w) * FRAME_WIDTH),
    bottom: Math.round((region.y + region.h) * FRAME_HEIGHT),
  };
}

test('every measured layout is covered by its era\'s crop', () => {
  for (const layout of MEASURED_LAYOUTS) {
    const window = pixelWindow(cropFor(layout.era));
    const [colLeft, colRight] = layout.symColumn;
    const [rowTop, rowBottom] = layout.rows;

    assert.ok(
      window.left <= colLeft,
      `${layout.layout}: crop starts at x=${window.left}, but the ticker column starts at x=${colLeft} `
      + `— the first glyph of every ticker would be cut off`
    );
    assert.ok(
      window.right >= colRight,
      `${layout.layout}: crop ends at x=${window.right}, but the ticker column ends at x=${colRight}`
    );
    assert.ok(
      window.top <= rowTop,
      `${layout.layout}: crop starts at y=${window.top}, but the first position row is at y=${rowTop}`
    );
    assert.ok(
      window.bottom >= rowBottom,
      `${layout.layout}: crop ends at y=${window.bottom}, but the last position row is at y=${rowBottom}`
    );
  }
});

test('the floating-panel crop does not clip the last row of a long 2022-era list', () => {
  // 20220421's panel runs 16 rows down to y=934. The shipped 2022-era crop
  // used to end at y=907, which read 11 of 16.
  const window = pixelWindow(cropFor('2022'));
  assert.ok(window.bottom >= 940, `2022-era crop ends at y=${window.bottom}, but a 16-row panel runs to y=940`);
});

test('the era boundary is the first video of the sidebar era', () => {
  assert.equal(CHART_STREAM_RIGHT_SIDEBAR_FROM, '20230518');
  assert.ok(isRightSidebarDate('20230518'));
  assert.ok(!isRightSidebarDate('20230126'));
});

test('an unknown date is the sidebar era, and the crop and the era agree', () => {
  // The two functions used to answer this differently: the crop fell back to
  // the sidebar rectangle for an unknown date, while the era predicate said
  // "not the sidebar era". A date could therefore be scanned with the
  // sidebar CROP and the floating-panel FLAGS — two different layouts at
  // once. The era is now decided in one place, so the two cannot disagree.
  for (const unknown of ['', '   ', null, undefined, 'not-a-date', '2023051', '1999']) {
    assert.ok(
      isRightSidebarDate(unknown),
      `an unknown date (${JSON.stringify(unknown)}) must be treated as the sidebar era`
    );
    assert.equal(
      chartStreamCropFractionForDate(unknown),
      CHART_STREAM_CROP_RIGHT_SIDEBAR,
      `an unknown date (${JSON.stringify(unknown)}) must fall back to the sidebar crop`
    );
  }

  // …and they agree for every well-formed date too.
  for (const dateKey of ['20220218', '20230126', '20230517', '20230518', '20230609', '20231215']) {
    const expected = dateKey >= '20230518' ? CHART_STREAM_CROP_RIGHT_SIDEBAR : CHART_STREAM_CROP_FLOATING_PANEL;
    assert.equal(chartStreamCropFractionForDate(dateKey), expected);
    assert.equal(isRightSidebarDate(dateKey), expected === CHART_STREAM_CROP_RIGHT_SIDEBAR);
  }
});

test('the era boundary sits inside a gap in the catalog', () => {
  // Qullamaggie published nothing between 2023-01-26 and 2023-05-18, so no
  // video can be assigned to the wrong layout by the threshold. If a video
  // ever appears inside that gap, the threshold has to move.
  if (!fs.existsSync(DB_PATH)) {
    // The catalog is tracked, but a checkout without `data/video_pipeline/`
    // is still a valid clone; skip rather than fail.
    return;
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT upload_date FROM videos WHERE channel = 'qullamaggie' "
        + 'AND upload_date >= ? AND upload_date <= ? ORDER BY upload_date'
      )
      .all('20230127', '20230517');
    assert.deepEqual(
      rows.map((row) => row.upload_date),
      [],
      'a Qullamaggie video was published inside the era gap — the crop threshold must be re-examined'
    );
  } finally {
    db.close();
  }
});

test('an unknown date gets the sidebar crop, which is the safer fallback', () => {
  // The sidebar crop (x 1574-1920) still CONTAINS the 2022-era floating panel
  // (x 1795-1812). The floating-panel crop (x 1651-1920) does NOT contain the
  // sidebar column (x 1585-1712 at its leftmost), so it reads a sidebar frame
  // as EMPTY. The fallback has to be the sidebar crop.
  const sidebar = pixelWindow(cropFor('2023'));
  const floating = pixelWindow(cropFor('2022'));

  const floatingPanel = MEASURED_LAYOUTS[0];
  assert.ok(
    sidebar.left <= floatingPanel.symColumn[0] && sidebar.right >= floatingPanel.symColumn[1],
    'the sidebar crop must still contain the 2022-era floating panel'
  );

  const sidebarLayout = MEASURED_LAYOUTS[MEASURED_LAYOUTS.length - 1];
  assert.ok(
    floating.left > sidebarLayout.symColumn[0],
    'the floating-panel crop must NOT contain the sidebar column, or the fallback would be safe either way'
  );

  for (const unknown of ['', '   ', null, undefined, 'not-a-date', '2023051', '1999']) {
    assert.equal(
      chartStreamCropFractionForDate(unknown),
      CHART_STREAM_CROP_RIGHT_SIDEBAR,
      `an unknown date (${JSON.stringify(unknown)}) must fall back to the sidebar crop`
    );
  }
});

test('the crop for a known date is the one for its era', () => {
  assert.equal(chartStreamCropFractionForDate('20220218'), CHART_STREAM_CROP_FLOATING_PANEL);
  assert.equal(chartStreamCropFractionForDate('20230126'), CHART_STREAM_CROP_FLOATING_PANEL);
  assert.equal(chartStreamCropFractionForDate('20230518'), CHART_STREAM_CROP_RIGHT_SIDEBAR);
  assert.equal(chartStreamCropFractionForDate('20231215'), CHART_STREAM_CROP_RIGHT_SIDEBAR);
});

test('the two crops are distinct, and both are valid fractional regions', () => {
  assert.notEqual(CHART_STREAM_CROP_FLOATING_PANEL, CHART_STREAM_CROP_RIGHT_SIDEBAR);
  for (const fraction of [CHART_STREAM_CROP_FLOATING_PANEL, CHART_STREAM_CROP_RIGHT_SIDEBAR]) {
    const region = parseFractionalRegion(fraction);
    assert.ok(region.x >= 0 && region.x + region.w <= 1.0001, `x out of frame: ${fraction}`);
    assert.ok(region.y >= 0 && region.y + region.h <= 1.0001, `y out of frame: ${fraction}`);
    assert.ok(region.w > 0 && region.h > 0, `empty region: ${fraction}`);
  }
});
