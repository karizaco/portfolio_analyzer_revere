'use strict';

// The ticker list a capture actually shows.
//
// A probe-log capture carries its holdings in one of two places, and which
// one depends on the screen layout:
//
//   - chart_stream: the column-filtered, per-frame parse
//     (`capture.chart_stream.position_list`). The chart-area bleed that the
//     raw OCR text carries is already filtered out at that point, which is
//     why the raw text is not used here.
//
//   - everything else (whiteboard, structured_whiteboard, dmi,
//     tale_of_the_tape): `capture.tickers`. For a whiteboard capture this is
//     the union of the bounding-box parser's holdings across the frame's
//     parsed rows, with a text-only extraction as the fallback when the bbox
//     parser found nothing.
//
// WHY THIS IS A SEPARATE MODULE
// The routing used to live inline in tools/aggregateScanResults.js, and for
// whiteboard captures it read `capture.tickers_from_bbox`. That field is
// never written at CAPTURE level — it is written per observation, as
// `capture.parsed_observations[].tickers_from_bbox` — so every whiteboard
// capture resolved to an empty list.
//
// Measured over 677 probe logs / 1281 captures:
//   - the top-level `tickers_from_bbox` key is present in 0 captures;
//   - of 360 whiteboard captures, 336 have a non-empty `capture.tickers`;
//   - 0 whiteboard captures have observations without `capture.tickers`.
//
// So `capture.tickers` is a strict superset of the per-observation set, and
// reading it recovers every holding. It also reproduces, exactly, the
// `data/analysis.json` that the tool produced before the routing was
// changed: 269 captures with tickers and 52 unique tickers. The routing
// that reads `tickers_from_bbox` yields 29 and 15 instead — it drops the
// whole Revere half of the report.

/**
 * The holdings a capture shows, per its screen layout.
 *
 * @param {object} capture - one capture from a probe log
 * @returns {string[]} the tickers, or [] when the capture shows none
 */
function getCaptureTickers(capture) {
  if (!capture || typeof capture !== 'object') return [];
  if (capture.screen_layout === 'chart_stream') {
    return Array.isArray(capture.chart_stream?.position_list)
      ? capture.chart_stream.position_list
      : [];
  }
  return Array.isArray(capture.tickers) ? capture.tickers : [];
}

module.exports = { getCaptureTickers };
