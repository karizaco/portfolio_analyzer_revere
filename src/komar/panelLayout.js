'use strict';

/**
 * The Komar PANEL: the on-screen table at the right edge of every
 * session, and where it is.
 *
 * WHAT THE PANEL IS
 *
 * Every session is a screen share with a TradingView table docked to
 * the right edge. It has two MODES, which are a per-session-kind
 * decision rather than a per-frame one:
 *
 *   WATCHLIST -- the Stocks Analysis part. Theme-grouped.
 *   PORTFOLIO -- the My Portfolio part. The HOLDINGS, plus an explicit
 *                `CLOSED` group of exited names.
 *
 * Both are the same three-or-four column table, so the same reader
 * serves both and only the meaning of the rows differs.
 *
 * THE GEOMETRY, MEASURED OFF THE PIXELS (2026-11-17)
 *
 * Three frames, one per era, at their native resolutions:
 *
 *   era A  Weekend-Report 51  (2022-01-14)  1920x1080
 *   era B  Weekend-Report 193 (2025)         1280x720
 *   era C  Weekend-Report 224 (2026-04-25)  1920x1080
 *
 *   - the table is the RIGHT ~15 % of the screen in every era: its
 *     left edge measured at x=1660/1920 (0.865) in era A, 1640/1920
 *     (0.854) in era C and 1128/1280 (0.881) in era B;
 *   - the header row sits at y=0.132 of the height in era A and
 *     0.128 in era C;
 *   - the ROW PITCH is 25px at 1080 and 17px at 720, which is 0.023 of
 *     the height in both -- so the pitch is a FRACTION and not a
 *     pixel count, which is what makes one crop work at every
 *     resolution;
 *   - the WEBCAM CIRCLE overlaps the panel's lower right. Its top edge
 *     moves with the frame (measured at 0.57 of the height in era C
 *     and 0.80 in another), so rows that fall behind it are recorded
 *     as OCCLUDED and not as absent.
 *
 * THE ERAS DIFFER IN ONE THING: THE COLUMN COUNT
 *
 *   era A  Symbol | Last | Chg | Chg%     (four)
 *   era B  Symbol | Last | Chg | Chg%     (four)
 *   era C  Symbol | Last | Chg%           (three)
 *
 * and in the group headers they carry: era A and B print `STOCKS`,
 * era C prints the THEME names (`DATA CENTER`, `SEMICONDUCTORS`,
 * `LITHIUM / RARE EARTH`, `SOFTWARE`, ...) and `CLOSED` for the
 * exited names.
 *
 * WHAT THE READER HAS TO KNOW BEYOND THE SHARED ONE
 *
 * `src/video/positionColumn.js` finds the ticker column from the ink
 * runs and `src/video/positionPanel.js` anchors on the header row to
 * choose among the left-aligned candidates. Two things are Komar's
 * own, and they belong here rather than in the shared modules:
 *
 *   1. THE HEADER SAYS "Symbol", NOT "Sym" -- and the era A/B header
 *      has a FOURTH column, so a reader that expects three columns
 *      reads the wrong ones.
 *   2. A GROUP HEADER IS A ROW WITH NO NUMBERS ("CLOSED", "STOCKS",
 *      "DATA CENTER"). It is a section, not a position, and it must
 *      not be published as one.
 */

/**
 * The panel's eras.
 *
 * The windows are the corpus's own dates, and the undated
 * 2023-2024 sessions are placed by the layout they show rather than
 * by a date they do not carry.
 */
const PANEL_ERAS = [
  {
    era: 'A',
    from: '20220101',
    to: '20231231',
    columns: ['symbol', 'last', 'chg', 'chg_pct'],
    header: 'Symbol | Last | Chg | Chg%',
    group_headers: ['STOCKS', 'NASDAQ.COM/W'],
    note: 'TradingView on macOS, and MarketSmith screens in some parts',
  },
  {
    era: 'B',
    from: '20250101',
    to: '20250812',
    columns: ['symbol', 'last', 'chg', 'chg_pct'],
    header: 'Symbol | Last | Chg | Chg%',
    group_headers: ['COMMODITIES & BONDS', 'STOCKS'],
    note: 'TradingView on macOS',
  },
  {
    era: 'C',
    from: '20250813',
    to: '20261231',
    columns: ['symbol', 'last', 'chg_pct'],
    header: 'Symbol | Last | Chg%',
    group_headers: [
      'DATA CENTER', 'SEMICONDUCTORS', 'LITHIUM / RARE EARTH', 'SOFTWARE',
      'OTHERS', 'SAAS / AI / DATA', 'FRESH OFFICIAL EARNINGS', 'CLOSED',
    ],
    note: 'TradingView on Windows',
  },
];

/**
 * The panel's region, as FRACTIONS of the frame.
 *
 * Measured on the three frames above. The region is deliberately
 * generous on the left: the reader finds the columns from the header,
 * and a generous crop only costs a little OCR.
 */
const PANEL_REGION = { left: 0.84, top: 0.10, width: 0.16, height: 0.90 };

/** The row pitch, as a fraction of the frame's height (measured 0.0231
 *  at 1080 and 0.0236 at 720 -- the same pitch at both). */
const PANEL_ROW_PITCH = 0.0231;

/** The lowest measured top edge of the webcam circle, as a fraction of
 *  the height. A row below it may be hidden by the circle, and the
 *  reader records that rather than reporting a short list. */
const WEBCAM_TOP = 0.57;

/**
 * The era a session is in.
 *
 * @param {string} dateKey - YYYYMMDD, or '' when the session has no date
 * @returns {object} the era record
 */
function panelEraForDate(dateKey) {
  const date = String(dateKey || '');
  if (/^\d{8}$/.test(date)) {
    for (const era of PANEL_ERAS) {
      if (date >= era.from && date <= era.to) return era;
    }
  }
  // An undated session, or one past the last era: the era whose
  // LAYOUT is the safe default. The three-column era is the current
  // one and the four-column era is the older one, so an unknown date
  // reads the CURRENT layout and lets the header decide.
  return PANEL_ERAS[PANEL_ERAS.length - 1];
}

/**
 * The crop rectangle of the panel, in pixels.
 *
 * @param {string} dateKey
 * @param {{width: number, height: number}} frame
 * @returns {{left: number, top: number, width: number, height: number}}
 */
function panelRegionForFrame(dateKey, frame) {
  const region = PANEL_REGION;
  const left = Math.max(0, Math.floor(frame.width * region.left));
  const top = Math.max(0, Math.floor(frame.height * region.top));
  return {
    left,
    top,
    width: Math.max(1, Math.floor(frame.width * region.width)),
    height: Math.max(1, Math.floor(frame.height * region.height)),
  };
}

/**
 * The row pitch in pixels, for a frame.
 *
 * @param {{height: number}} frame
 * @returns {number}
 */
function panelRowPitch(frame) {
  return Math.max(8, Math.round(frame.height * PANEL_ROW_PITCH));
}

/**
 * Is a row hidden behind the webcam circle?
 *
 * @param {number} y - the row's top edge, in frame pixels
 * @param {{height: number}} frame
 * @returns {boolean}
 */
function isOccluded(y, frame) {
  return y >= frame.height * WEBCAM_TOP;
}

/**
 * Is this row a GROUP HEADER rather than a position?
 *
 * A group header is one of the era's OWN labels -- "CLOSED",
 * "STOCKS", "DATA CENTER" -- and the era carries the list. It is not
 * a shape test: a row whose prices could not be read leaves a lone
 * symbol in the column, and a shape rule would call that a group
 * header and drop the position.
 *
 * @param {string} text - the row's text
 * @param {object} [era] - the era record (or anything with
 *   `group_headers`)
 * @returns {boolean}
 */
function isGroupHeader(text, era) {
  const value = String(text || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!value) return false;
  const headers = (era && era.group_headers) || [];
  return headers.some((header) => String(header).toUpperCase().replace(/\s+/g, ' ') === value);
}

module.exports = {
  PANEL_ERAS,
  PANEL_REGION,
  PANEL_ROW_PITCH,
  WEBCAM_TOP,
  isGroupHeader,
  isOccluded,
  panelEraForDate,
  panelRegionForFrame,
  panelRowPitch,
};
