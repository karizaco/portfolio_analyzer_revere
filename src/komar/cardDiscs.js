'use strict';

/**
 * The trend arrows of a Komar market card, read from PIXELS.
 *
 * WHY THE ARROWS CANNOT BE OCR'd
 *
 * The card's trend arrows are IMAGES: a coloured disc with a white
 * arrow glyph inside it. No OCR reads a picture of an arrow -- and the
 * measured whole-card read of `komar_20260509.pdf` page 2 comes back
 * with "NASDAQ @ @& 2 enim", which is three discs and a mangled
 * percentage.
 *
 * So the STATE is read from the DISC'S COLOUR, which is what carries
 * the meaning:
 *
 *   green  rgb(83,190,107)    up
 *   amber  rgb(232,179,64)    flat / sideways
 *   red    rgb(209,56,49)     down
 *
 * Those three are MEASURED from the corpus's own cards, at the disc's
 * own pixels, not chosen.
 *
 * WHY THE DISC IS SAMPLED IN A RING AND NOT FLOOD-FILLED
 *
 * The white ARROW GLYPH lies across the disc and cuts it into pieces,
 * so a flood fill of the disc's colour finds fragments rather than the
 * disc. Measured: a flood fill of `komar_20260509.pdf`'s card finds 2
 * blobs where there are 6 discs.
 *
 * So the disc is found by its CENTRE: a candidate centre is scored by
 * how much of the disc around it carries the disc's colour. The arrow
 * takes about a fifth of the area, so the disc still scores far above
 * the background, and the background never scores at all.
 *
 * WHY THE COLOUR WINDOW IS NARROW
 *
 * The card's background is green -- rgb(38,87,25) -- and the chart
 * photograph showing through is green too, rgb(69,100,33). A disc is
 * separated from the background by its GREEN (190 against 87 and 100)
 * and by its BLUE (107 against 25 and 33). The amber and the red are
 * separated from the green by their hue.
 */

const { DISC_WINDOWS } = require('./cardLayout');

/**
 * The radius, in pixels, of the ring sampled around a candidate centre.
 *
 * The discs are 33-38 px across, so a ring at 9-16 px sits inside the
 * disc and outside the arrow's core.
 */
const RING_INNER = 9;
const RING_OUTER = 16;

/**
 * The fraction of the ring that must carry the disc's colour.
 *
 * The arrow glyph takes about a fifth of the disc, so a real disc scores
 * 0.92 and up, while a candidate in the GAP between two discs scores
 * 0.47. The threshold sits between the two.
 */
const MIN_RING_MATCH = 0.6;

/**
 * Is this pixel a disc candidate?
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
function isDiscPixel(r, g, b) {
  const max = Math.max(r, g, b);
  if (max < 90) return false;
  const min = Math.min(r, g, b);
  return (max - min) / max >= 0.4;
}

/**
 * The direction a colour means.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {string} 'up' | 'flat' | 'down' | ''
 */
function classifyDiscColour(r, g, b) {
  for (const name of Object.keys(DISC_WINDOWS)) {
    const window = DISC_WINDOWS[name];
    if (r >= window.r[0] && r <= window.r[1]
      && g >= window.g[0] && g <= window.g[1]
      && b >= window.b[0] && b <= window.b[1]) {
      return name;
    }
  }
  return '';
}

/**
 * The fraction of a ring around a centre that carries a colour.
 *
 * @param {Buffer} raw
 * @param {{width:number,height:number,channels:number}} info
 * @param {number} cx
 * @param {number} cy
 * @param {(r:number,g:number,b:number)=>boolean} test
 * @returns {number} 0..1
 */
function ringMatch(raw, info, cx, cy, test) {
  let matched = 0;
  let total = 0;
  for (let y = cy - RING_OUTER; y <= cy + RING_OUTER; y += 1) {
    for (let x = cx - RING_OUTER; x <= cx + RING_OUTER; x += 1) {
      if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (distance < RING_INNER || distance > RING_OUTER) continue;
      const offset = (y * info.width + x) * info.channels;
      total += 1;
      if (test(raw[offset], raw[offset + 1], raw[offset + 2])) matched += 1;
    }
  }
  return total ? matched / total : 0;
}

/**
 * Find the arrow discs in an image.
 *
 * @param {Buffer} raw - the image pixels
 * @param {{width:number,height:number,channels:number}} info
 * @param {object} [options]
 * @param {{left:number,top:number,width:number,height:number}} [options.region]
 *   where to look; the trend table is in the card's top-left
 * @returns {Array<{x:number,y:number,direction:string,score:number}>}
 */
function findArrowDiscs(raw, info, options = {}) {
  const region = options.region || {
    height: info.height,
    left: 0,
    top: 0,
    width: info.width,
  };
  const x0 = Math.max(0, Math.floor(region.left));
  const x1 = Math.min(info.width, Math.ceil(region.left + region.width));
  const y0 = Math.max(0, Math.floor(region.top));
  const y1 = Math.min(info.height, Math.ceil(region.top + region.height));

  const tests = {
    down: (r, g, b) => classifyDiscColour(r, g, b) === 'down',
    flat: (r, g, b) => classifyDiscColour(r, g, b) === 'flat',
    up: (r, g, b) => classifyDiscColour(r, g, b) === 'up',
  };

  // Collect the candidate CENTRES: every pixel that is itself
  // disc-coloured.
  const candidates = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      const r = raw[offset];
      const g = raw[offset + 1];
      const b = raw[offset + 2];
      if (!isDiscPixel(r, g, b)) continue;
      const direction = classifyDiscColour(r, g, b);
      if (!direction) continue;
      candidates.push({ direction, x, y });
    }
  }

  // Cluster the candidates into discs. The clustering is by PROXIMITY
  // and not by colour, because the arrow glyph splits a disc into
  // pieces of different colours -- and because one disc's claimed area
  // must not swallow the next disc's centre.
  const clusters = [];
  for (const candidate of candidates) {
    let placed = false;
    for (const cluster of clusters) {
      if (Math.abs(cluster.x - candidate.x) <= RING_OUTER
        && Math.abs(cluster.y - candidate.y) <= RING_OUTER) {
        cluster.members.push(candidate);
        cluster.x = Math.round(cluster.members.reduce((sum, m) => sum + m.x, 0) / cluster.members.length);
        cluster.y = Math.round(cluster.members.reduce((sum, m) => sum + m.y, 0) / cluster.members.length);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ members: [candidate], x: candidate.x, y: candidate.y });
  }

  // Score each cluster by the best ring match of any of its directions,
  // and take the direction that wins. The arrow takes about a fifth of
  // the disc, so the disc's own colour still wins the ring.
  const scored = [];
  for (const cluster of clusters) {
    let best = null;
    for (const direction of Object.keys(tests)) {
      const score = ringMatch(raw, info, cluster.x, cluster.y, tests[direction]);
      if (!best || score > best.score) best = { direction, score };
    }
    if (!best || best.score < MIN_RING_MATCH) continue;
    scored.push({ direction: best.direction, score: best.score, x: cluster.x, y: cluster.y });
  }

  // NON-MAXIMUM SUPPRESSION.
  //
  // Two discs side by side leave a gap between them, and a candidate
  // centre in that gap scores about 0.47 against BOTH of them -- its
  // ring reaches into the disc on either side. So a candidate is
  // dropped when a STRONGER candidate sits within a disc's radius.
  //
  // Measured on a synthetic pair: without this, two discs read as
  // three.
  scored.sort((a, b) => b.score - a.score);
  const discs = [];
  for (const candidate of scored) {
    const suppressed = discs.some((kept) => (
      Math.abs(kept.x - candidate.x) <= RING_OUTER * 2
      && Math.abs(kept.y - candidate.y) <= RING_OUTER * 2
    ));
    if (suppressed) continue;
    discs.push(candidate);
  }

  discs.sort((a, b) => a.y - b.y || a.x - b.x);
  return discs;
}

/**
 * The trend rows of a card, from the discs that were found.
 *
 * THE LATTICE IS FOUND, NOT ASSUMED
 *
 * The card prints the index names down the left and the discs to their
 * right, one row per index and one column per horizon. The discs are
 * therefore sorted into rows by their Y, and the rows are matched to the
 * indices by their ORDER -- the card always prints NASDAQ, then
 * S&P 500, then Russell 2000.
 *
 * A row with no disc is 'unknown', never 'flat'. A missing reading and
 * a flat reading are different facts.
 *
 * @param {Array<object>} discs - { x, y, direction }
 * @returns {{nasdaq:string,sp500:string,russell2000:string,horizons:string[]}}
 */
function readTrendFromDiscs(discs) {
  const rows = { nasdaq: 'unknown', russell2000: 'unknown', sp500: 'unknown' };
  const horizons = [];
  if (!discs || !discs.length) return { horizons, ...rows };

  const sorted = [...discs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  for (const disc of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.y - disc.y) <= 14) {
      last.discs.push(disc);
      continue;
    }
    groups.push({ discs: [disc], y: disc.y });
  }

  const INDEX_ORDER = ['nasdaq', 'sp500', 'russell2000'];
  groups.slice(0, INDEX_ORDER.length).forEach((group, index) => {
    const byX = [...group.discs].sort((a, b) => a.x - b.x);
    // The FIRST disc in the row is the LONGEST horizon, and the card
    // prints one disc per horizon it shows.
    rows[INDEX_ORDER[index]] = byX[0].direction;
  });

  // The horizons are the COLUMNS of the lattice.
  //
  // The columns are found from the discs' X positions ALONE, not from
  // the row-major order: the discs are sorted by row first, so a
  // row-major scan sees "x=270, x=318, x=270, x=318" and clusters those
  // into one column of four. The columns are therefore clustered from
  // the X values, sorted, and named from the RIGHT, because the card
  // prints the horizons longest-first: Long, Mid, Short.
  const xs = sorted.map((disc) => disc.x).sort((a, b) => a - b);
  const columns = [];
  for (const x of xs) {
    const last = columns[columns.length - 1];
    if (last && Math.abs(last.x - x) <= 16) {
      last.n += 1;
      last.x = Math.round((last.x * (last.n - 1) + x) / last.n);
      continue;
    }
    columns.push({ n: 1, x });
  }
  const HORIZON_NAMES = ['Long', 'Mid', 'Short'];
  // The card prints at most three horizons, so a fourth column is a
  // stray blob and is dropped. When more than three survive, the ones
  // with the fewest discs go.
  let usable = columns.filter((column) => column.n >= 1);
  if (usable.length > HORIZON_NAMES.length) {
    usable = [...usable]
      .sort((a, b) => b.n - a.n)
      .slice(0, HORIZON_NAMES.length)
      .sort((a, b) => a.x - b.x);
  }
  usable.forEach((column, index) => {
    const name = HORIZON_NAMES[HORIZON_NAMES.length - usable.length + index];
    horizons.push(name || `col${index}`);
  });

  // The direction per horizon, per index, so nothing is lost: the card
  // prints two or three horizons and they can disagree.
  const byHorizon = {};
  groups.forEach((group, groupIndex) => {
    const field = INDEX_ORDER[groupIndex];
    if (!field) return;
    const byX = [...group.discs].sort((a, b) => a.x - b.x);
    const entry = {};
    byX.forEach((disc, discIndex) => {
      const horizon = HORIZON_NAMES[HORIZON_NAMES.length - byX.length + discIndex];
      if (!horizon) return;
      entry[horizon] = disc.direction;
    });
    byHorizon[field] = entry;
  });

  return { byHorizon, horizons, ...rows };
}

module.exports = {
  MIN_RING_MATCH,
  RING_INNER,
  RING_OUTER,
  classifyDiscColour,
  findArrowDiscs,
  isDiscPixel,
  readTrendFromDiscs,
  ringMatch,
};





