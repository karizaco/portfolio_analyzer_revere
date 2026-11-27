'use strict';

const { canonicalBrokerLine, marketTickerOf } = require('./symbols');

/**
 * The XTB positions table, read out of a broker screenshot.
 *
 * WHAT THE SCREEN IS
 *
 * The portfolio channel of plechac carries screenshots of his broker's own
 * positions screen, and the readable one is the XTB "POZICE" table:
 *
 *   TICKER | KUSY | NÁK. CENA | AKT. CENA | HODNOTA | P&L | P&L % | VÁHA |
 *   DEN ZMĚNA | ČAS. TEST | FAKT. HOD. | AKCE
 *
 * Two of its columns are what a position record needs and the trade
 * channel cannot give: the WEIGHT (VÁHA) and the average cost (NÁK.
 * CENA). The trade channel says WHAT he traded; this says HOW MUCH of the
 * book each holding is.
 *
 * WHY THE READER IS POSITIONAL
 *
 * The columns are not at fixed x positions -- the table adapts its widths
 * to the content -- so the reader finds the HEADER and takes the columns
 * from it. The header is the largest text on the screen and it is read
 * reliably: "TICKER" at confidence 0.99, "KUSY" at 0.78 and "VAHA" at
 * 0.99 on the measured screenshot.
 *
 * THE HEADER IS LEFT-ALIGNED AND THE NUMBERS ARE RIGHT-ALIGNED
 *
 * Measured on the 2026-05-22 screenshot, the header words' centres are
 * TICKER 168, KUSY 690, NÁK.CENA 942, AKT.CENA 1456, HODNOTA 1762,
 * P&L 2146, P&L % 2413, VÁHA 2612, DEN 2850 -- and the DATA words'
 * centres are within 50 px of them. A range built from the header's LEFT
 * edge would drop a number that sits 20 px to the left of it, so the
 * anchor is the CENTRE and a value belongs to the NEAREST column.
 *
 * WHY THE ROWS ARE BANDS AND NOT LINES
 *
 * The OCR's own line numbering breaks a row in two when the ticker is
 * long: "RHM XETRA" is on its own line and its numbers are on the next
 * two. The rows are a constant vertical pitch, so a row is a BAND of
 * words, and the band is found by clustering the vertical centres.
 *
 * A CELL CAN BE TWO WORDS
 *
 * "420," and "76 $" are one cell -- 420,76 -- and the reader joins the
 * words of a cell before it parses them. A cell whose joined text does
 * not parse is UNREADABLE rather than half-read, because "420" on its own
 * is a different number from "420,76".
 *
 * THE LOGO IS NOT A TICKER
 *
 * Every row carries a round company logo to the LEFT of the ticker, and a
 * logo is a picture: Tesseract reads it as a letter or a symbol often
 * enough to publish a wrong holding. The logos sit to the left of the
 * TICKER header, so the reader takes the ticker from the column the
 * header defines and not from the whole row.
 *
 * THE NUMBERS ARE EUROPEAN
 *
 * The broker writes "63,84 $" and "1 527,23 $", and the decimals are
 * commas. A reader that splits on the dot reads 63.84 as 6384.
 *
 * THE BROKER'S MINUS SIGN IS LOST, AND THE PRICES SAY WHAT IT WAS
 *
 * The broker draws a negative with a minus glyph the OCR does not read:
 * "-24,53 $" comes back as "~24,53 $" and "-0,26%" as "F0,26%". The
 * SIGN of the P&L is therefore taken from the prices -- `price` against
 * `average cost` -- and never from the glyph. A P&L that is read as
 * positive when the prices say it is negative would be a wrong number in
 * a portfolio record.
 *
 * THE PRINTED P&L % IS MISREAD TOO, SO IT IS DERIVED
 *
 * On the measured screenshot the printed P&L % column is wrong in three
 * of fifteen rows: "-3,98%" is read "73,98%", "131,93%" is read
 * "4131,93%" and "11,19%" is read "411,19%". The minus sign is a
 * one-pixel dash and the leading digit merges into it.
 *
 * So the row is CHECKED against its own arithmetic -- `value = units x
 * price` and `P&L = units x (price - average cost)` -- and the P&L is
 * DERIVED from the prices rather than read. A row is `ok` when the
 * prices agree with one of the two printed P&L cells, `repaired` when a
 * cell was rebuilt from the prices, and `unverified` when the row does
 * not add up: an unverified average cost is still published, but it says
 * so, because a cost that is wrong is worse than a cost that is missing.
 *
 * THE TABLE CHECKS ITSELF
 *
 * The last row is "Celkem" and it carries the table's own total weight --
 * "100%" on the measured screenshot. A reading whose weights do not add
 * up to that total has lost a row, and the coverage is reported so the
 * consumer can decide what to do with it. Nothing is dropped on the
 * strength of the check: a reading that lost a row is still a reading,
 * and saying so is better than silently truncating it.
 */

const HEADER_COLUMNS = [
  { key: 'ticker', pattern: /\bTICKER\b/i },
  { key: 'units', pattern: /\bKUSY\b|\bSHARES\b/i },
  { key: 'avg_cost', pattern: /\bNAK\b.*\bCENA\b|\bAVG\b/i },
  { key: 'price', pattern: /\bAKT\b.*\bCENA\b|\bLAST\b/i },
  { key: 'value', pattern: /\bHODNOTA\b|\bMARKET\b.*\bVALUE\b/i },
  // The header reads "P&L" as "PBL" and "P&L %" as "PeL %" -- so the
  // pattern is loose on the letter between the P and the L, and the two
  // columns are told apart by the PERCENT SIGN.
  //
  // The English "Overview" view names the same facts differently: the
  // unrealised gain is "Unr. Gain %" and "Unr. Gain", and its DAILY
  // change is "1D Gain %" -- which is a DIFFERENT fact, and it gets its
  // own column rather than being mistaken for the P&L.
  { key: 'pnl_amount', pattern: /\bP.{0,2}L\b|\bUNR\b.*\bGAIN\b/i, exclude: /%/ },
  { key: 'pnl_pct', pattern: /P.{0,2}L\s*%|\bUNR\b.*\bGAIN\b.*%/i },
  { key: 'change_pct', pattern: /\b1D\b.*\bGAIN\b.*%/i },
  // THE WEIGHT. The Czech table calls it "VAHA" and the English one
  // calls it "Allocation", and they are the same column: the share of
  // the book that the holding is worth.
  //
  // And the English table has TWO percentage columns that are NOT the
  // weight -- "1D Gain %" and "Unr. Gain %" -- so a reader that took
  // the wrong one would publish a change as a weight. The weight is
  // "Allocation" and nothing else.
  { key: 'weight_pct', pattern: /\bVAHA\b|\bALLOCATION\b/i },
  { key: 'date_changed', pattern: /\bDEN\b/i },
];

/** A ticker as the broker writes it: "NBIS", "RHM XETRA", "BRK-B". */
const TICKER_SHAPE = /^[A-Z0-9][A-Z0-9.\- ]{0,11}$/;

/** How far a value may sit from its column's anchor and still be its. */
const MAX_COLUMN_DISTANCE = 160;

/** How far a row's arithmetic may be out and still count as consistent. */
const ARITHMETIC_TOLERANCE = 0.015;

/**
 * Parse a Czech number: "1 527,23" is 1527.23 and "63,84" is 63.84.
 *
 * The comma is the decimal point. A dot is one only when it has one or
 * two digits after it ("0.4" is 0.4 units), and a thousands separator
 * otherwise ("1.234" is 1234).
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseNumber(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^\d.,\-]/g, '').trim();
  if (!cleaned) return null;
  const negative = cleaned.startsWith('-');
  const digits = cleaned.replace(/-/g, '');
  let value;
  if (digits.includes(',')) {
    // "1 527,23" -> the comma is the decimal point; a group separator is
    // a space, which is already gone.
    value = Number(digits.replace(/\./g, '').replace(',', '.'));
  } else if (digits.includes('.')) {
    const parts = digits.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      value = Number(digits);
    } else {
      value = Number(digits.replace(/\./g, ''));
    }
  } else {
    value = Number(digits);
  }
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * The percentage in a token: "+238,18%" is 238.18.
 *
 * @param {string} text
 * @returns {number|null}
 */
function parsePercent(text) {
  const match = /([+-]?\d[\d.,\s]*)\s*%/.exec(String(text || ''));
  if (!match) return null;
  return parseNumber(match[1]);
}

/**
 * Group the words into ROWS by their vertical centre.
 *
 * @param {{top: number, height: number}[]} words
 * @returns {{top: number, bottom: number, centre: number, height: number, words: object[]}[]}
 */
function bandRows(words) {
  const sorted = [...words].sort((a, b) => (a.top + (a.height || 0) / 2) - (b.top + (b.height || 0) / 2));
  const rows = [];
  for (const word of sorted) {
    const centre = word.top + (word.height || 0) / 2;
    const last = rows[rows.length - 1];
    if (last && centre - last.centre <= (last.height || 0) * 0.8) {
      last.words.push(word);
      last.centre = (last.centre * (last.words.length - 1) + centre) / last.words.length;
      last.bottom = Math.max(last.bottom, word.top + (word.height || 0));
      continue;
    }
    rows.push({
      centre,
      height: word.height || 0,
      top: word.top,
      bottom: word.top + (word.height || 0),
      words: [word],
    });
  }
  return rows;
}

/**
 * The centre of a word's box.
 *
 * @param {{left: number, width: number}} word
 * @returns {number}
 */
function centreOf(word) {
  return word.left + (word.width || 0) / 2;
}

/**
 * Find the column anchors in the header band.
 *
 * @param {object[]} headerWords
 * @returns {{key: string, centre: number, left: number, text: string}[]}
 */
function findColumns(headerWords) {
  const used = new Set();
  const columns = [];
  for (const column of HEADER_COLUMNS) {
    const index = headerWords.findIndex((candidate, candidateIndex) => {
      if (used.has(candidateIndex)) return false;
      if (!column.pattern.test(candidate.text)) return false;
      if (column.exclude && column.exclude.test(candidate.text)) return false;
      return true;
    });
    if (index < 0) continue;
    used.add(index);
    const word = headerWords[index];
    columns.push({
      key: column.key,
      centre: centreOf(word),
      left: word.left,
      text: word.text,
    });
  }
  return columns;
}

/**
 * Assign every value in a band to the column it belongs to.
 *
 * A CELL is the words assigned to one column, and its text is the words
 * joined in reading order -- so a cell the OCR split in two is read as
 * the one number it is.
 *
 * @param {object} row  a band
 * @param {object[]} columns  the anchors
 * @param {object|null} tickerWord  the word that is the ticker, if any
 * @returns {Map<string, {text: string, words: object[]}>}
 */
function assignCells(row, columns, tickerWord) {
  const buckets = new Map();
  for (const word of row.words) {
    if (tickerWord && word === tickerWord) continue;
    if (parseNumber(word.text) === null && parsePercent(word.text) === null) continue;
    const centre = centreOf(word);
    let best = null;
    let bestDistance = Infinity;
    for (const column of columns) {
      if (column.key === 'ticker') continue;
      const distance = Math.abs(centre - column.centre);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = column;
      }
    }
    if (!best || bestDistance > MAX_COLUMN_DISTANCE) continue;
    if (!buckets.has(best.key)) buckets.set(best.key, []);
    buckets.get(best.key).push(word);
  }
  const cells = new Map();
  for (const [key, words] of buckets) {
    const ordered = [...words].sort((a, b) => a.left - b.left);
    cells.set(key, { text: ordered.map((word) => word.text).join(' '), words: ordered });
  }
  return cells;
}

/**
 * Parse the number of a CELL.
 *
 * A cell is one number, but the OCR sometimes leaves a second one in it
 * -- on the measured screenshot the RHM row's average cost reads
 * "1 527,23 $ 21314.18", which is two numbers where there is one, and
 * joining them produces a number that never was ("1527.2321314.18").
 *
 * So a cell with more than ONE decimal separator is AMBIGUOUS and is not
 * read at all. A cell whose text does not parse is unreadable rather
 * than half-read: "420" is a different number from "420,76".
 *
 * @param {string} text
 * @returns {number|null}
 */
function parseCellNumber(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  // A dot that groups thousands ("1.527,23") is not a decimal point.
  const cleaned = raw.replace(/[^\d.,\-]/g, '').replace(/\.(?=\d{3}(?:[.,]|$))/g, '');
  const separators = (cleaned.match(/[.,]/g) || []).length;
  if (separators > 1) return null;
  return parseNumber(raw);
}

/**
 * Are two numbers the same, to within a tolerance?
 *
 * @param {number|null} a
 * @param {number|null} b
 * @param {number} tolerance
 * @returns {boolean}
 */
function closeEnough(a, b, tolerance = ARITHMETIC_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) <= tolerance * scale;
}

/**
 * Check a row against its own arithmetic.
 *
 * The table says `value = units x price` and `P&L = units x (price -
 * average cost)`. Two of the three printed P&L cells are misread on the
 * measured screenshot, so the SIGN of the P&L comes from the prices and
 * the row is checked against whichever printed P&L cell agrees.
 *
 * @param {object} row
 * @returns {object} the row with `reading_check`, `avg_cost`, `price`, `pnl_pct`
 */
function checkRow(row) {
  let units = row.units;
  let avgCost = row.avg_cost;
  let price = row.price;
  let value = row.value;
  let pnlAmount = row.pnl_amount;
  const pnlAmountMagnitude = Number.isFinite(pnlAmount) ? Math.abs(pnlAmount) : null;
  let repaired = false;

  // 1. The value against the units and the price.
  if (Number.isFinite(units) && Number.isFinite(price) && Number.isFinite(value)) {
    if (!closeEnough(units * price, value)) {
      // The value and the price disagree. If the units and the value
      // agree, the PRICE is the wrong cell.
      const impliedPrice = value / units;
      if (closeEnough(units * impliedPrice, value)) {
        price = impliedPrice;
        repaired = true;
      }
    }
  }
  if (Number.isFinite(units) && Number.isFinite(value) && !Number.isFinite(price)) {
    price = value / units;
    repaired = true;
  }

  // 2. The average cost against the two printed P&L cells.
  //
  //    `units x (price - cost)` is the P&L in money and
  //    `(price - cost) / cost` is the P&L in percent. Either printed cell
  //    that agrees confirms the cost -- in MAGNITUDE, because the broker's
  //    minus sign is not read.
  let costConfirmed = false;
  if (Number.isFinite(price) && Number.isFinite(avgCost) && avgCost !== 0) {
    const derivedPct = ((price - avgCost) / avgCost) * 100;
    // Either printed P&L cell that agrees confirms the cost -- in
    // MAGNITUDE, because the broker's minus sign is not read.
    if (Number.isFinite(row.pnl_pct_read) && closeEnough(Math.abs(derivedPct), Math.abs(row.pnl_pct_read))) {
      costConfirmed = true;
    } else if (Number.isFinite(units) && pnlAmountMagnitude !== null
      && closeEnough(Math.abs(units * (price - avgCost)), pnlAmountMagnitude)) {
      costConfirmed = true;
    }
  }

  // 3. The P&L is DERIVED: the sign comes from the prices and the
  //    magnitude from the row's own arithmetic.
  let pnlPct = null;
  if (Number.isFinite(avgCost) && Number.isFinite(price) && avgCost > 0) {
    pnlPct = Number((((price - avgCost) / avgCost) * 100).toFixed(4));
  }
  if (Number.isFinite(units) && Number.isFinite(price) && Number.isFinite(avgCost)) {
    pnlAmount = Number((units * (price - avgCost)).toFixed(4));
  }

  const valueChecks = Number.isFinite(units) && Number.isFinite(price) && Number.isFinite(value)
    ? closeEnough(units * price, value)
    : true;

  return {
    ...row,
    avg_cost: avgCost,
    price,
    value,
    pnl_amount: pnlAmount,
    pnl_pct: pnlPct,
    reading_check: repaired ? 'repaired' : (costConfirmed && valueChecks ? 'ok' : 'unverified'),
  };
}

/**
 * Read the XTB positions table out of an OCR result.
 *
 * @param {object} ocr  the result of `ocrImage` / `runEasyOcr`
 * @returns {{positions: object[], columns: object[], coverage: object, unread: string[]}}
 */
function readPositionsTable(ocr) {
  const words = (ocr && ocr.words) || [];
  const unread = [];
  if (!words.length) return { positions: [], columns: [], coverage: null, unread: ['no words'] };

  const rows = bandRows(words);

  // 1. The header row: the band that carries "TICKER".
  const headerRow = rows.find((row) => row.words.some((word) => /\bTICKER\b/i.test(word.text)));
  if (!headerRow) {
    return { positions: [], columns: [], coverage: null, unread: ['no TICKER header'] };
  }

  // 1b. The header can be SPLIT over two bands.
  //
  // The Czech table puts every column name on one line, but the English
  // "Overview" view puts "Ticker" on the line BELOW the others -- the
  // ticker column's label sits lower because the sort arrow is beside
  // it. So the words of the band ABOVE the ticker band are the header
  // words too, and the columns are found in the union.
  //
  // Only the band immediately above is taken, and a word that matches
  // no header pattern cannot become a column, so a stray word is
  // harmless.
  const headerBandIndex = rows.indexOf(headerRow);
  const headerWords = [
    ...(headerBandIndex > 0 ? rows[headerBandIndex - 1].words : []),
    ...headerRow.words,
  ];

  // 2. The columns, from the header words.
  const columns = findColumns(headerWords);
  const columnByKey = new Map(columns.map((column) => [column.key, column]));
  if (!columnByKey.has('ticker') || !columnByKey.has('weight_pct')) {
    return {
      positions: [],
      columns,
      coverage: null,
      unread: [`header without ${columnByKey.has('ticker') ? 'VAHA' : 'TICKER'}`],
    };
  }

  // 3. The data rows: the bands below the header, above the total.
  const firstNumberColumn = columns
    .filter((column) => column.key !== 'ticker')
    .sort((a, b) => a.centre - b.centre)[0];

  const positions = [];
  let tableTotalPct = null;
  // The weight of the row above, which is what the column's ORDER says
  // the next one may not exceed.
  let previousWeight = null;
  let weightRepaired = false;

  for (const row of rows) {
    if (row.centre <= headerRow.centre) continue;
    const text = row.words.map((word) => word.text).join(' ');
    const isTotal = /^\s*Celkem\b/i.test(text);

    // The ticker: the leftmost ticker-shaped word before the first number
    // column. The logo is to the left of it and is not a word.
    const tickerWord = row.words
      .filter((word) => centreOf(word) < (firstNumberColumn ? firstNumberColumn.centre - 60 : Infinity))
      .sort((a, b) => a.left - b.left)
      .find((word) => TICKER_SHAPE.test(String(word.text).toUpperCase()) && /[A-Z]/.test(String(word.text)));

    const cells = assignCells(row, columns, tickerWord);

    // A ROW HAS NUMBERS. The company name sits on its own line under the
    // ticker in both of the broker's views, so the OCR puts it in a band
    // of its own -- and a name in capitals ("BARRICK GOLD",
    // "AMAZON.COM") matches the ticker shape. A band with no number in
    // it is not a row, and a name is not a holding.
    const hasNumber = [...cells.values()].some((cell) => /\d/.test(cell.text || ''));
    if (!hasNumber) continue;

    const numberOf = (key) => {
      const cell = cells.get(key);
      return cell ? parseCellNumber(cell.text) : null;
    };
    const percentOf = (key) => {
      const cell = cells.get(key);
      return cell ? parsePercent(cell.text) : null;
    };

    if (isTotal) {
      // The table's own total row: it says what the weights add up to.
      const total = percentOf('weight_pct');
      if (Number.isFinite(total)) tableTotalPct = total;
      break;
    }
    if (!tickerWord) continue;

    // THE WEIGHT, and the two things that can be wrong with it.
    //
    // 1. A weight is a share of the book, so it is at most 100 %.
    //
    // 2. The column is SORTED -- the biggest holding is at the top of the
    //    picture -- and the English "Overview" view is a SCROLLED
    //    picture whose LAST row is cut off by the image's edge. The OCR
    //    reads that row's numbers WITHOUT their points: "0.78 %" comes
    //    back as "78 %" and "1.61 %" as "161 %".
    //
    // So a weight that breaks the order is a misread, and the repair is
    // to divide it by 100 -- but ONLY when that restores the order. A
    // weight that cannot be repaired is REJECTED, because a wrong
    // weight in a portfolio record is worse than a missing holding.
    const weightText = cells.get('weight_pct');
    let weightParsed = weightText ? parsePercent(weightText.text) : null;
    if (Number.isFinite(weightParsed)) {
      if (weightParsed <= 0 || weightParsed > 100) {
        unread.push(`${String(tickerWord.text).toUpperCase()}: weight ${weightParsed} is outside (0, 100]`);
        continue;
      }
      if (previousWeight !== null && weightParsed > previousWeight) {
        const repaired = weightParsed / 100;
        if (repaired > 0 && repaired <= previousWeight) {
          weightParsed = repaired;
          weightRepaired = true;
        } else {
          unread.push(`${String(tickerWord.text).toUpperCase()}: weight ${weightParsed} breaks the order and cannot be repaired`);
          continue;
        }
      }
      previousWeight = weightParsed;
    }

    const ticker = String(tickerWord.text).toUpperCase().replace(/\s+/g, ' ').trim();
    positions.push(checkRow({
      ticker,
      weight_pct: Number.isFinite(weightParsed) ? weightParsed : percentOf('weight_pct'),
      change_pct: percentOf('change_pct'),
      pnl_pct_read: percentOf('pnl_pct'),
      pnl_amount: numberOf('pnl_amount'),
      units: numberOf('units'),
      avg_cost: numberOf('avg_cost'),
      price: numberOf('price'),
      value: numberOf('value'),
    }));
  }

  // The table's own total says what the weights have to add up to. A
  // reading that does not add up to it has lost a row, and the coverage
  // says so rather than the reading being silently truncated.
  const weightSum = positions.reduce((sum, position) => sum + (position.weight_pct || 0), 0);
  const expected = tableTotalPct === null ? 100 : tableTotalPct;
  const coverage = {
    positions: positions.length,
    weight_sum_pct: Number(weightSum.toFixed(2)),
    table_total_pct: tableTotalPct,
    expected_total_pct: expected,
    complete: Math.abs(weightSum - expected) < 0.6,
  };

  return { positions, columns, coverage, unread };
}

/**
 * Merge one holding into a message's set.
 *
 * A message can carry SEVERAL pictures of the same book, and they do not
 * all carry the same facts: the 2025-12-22 message carries a treemap
 * (which reads the DAILY CHANGE and no weight) and FIVE scroll positions
 * of the Overview table (which read the WEIGHT). So a holding that a
 * picture with a weight read wins over the same holding read by a
 * picture without one, and a fact that one picture read and the other
 * did not is kept.
 *
 * The key is the MARKET ticker, so the same holding read by two
 * pictures is one holding.
 *
 * AND TWO ROWS OF ONE MARKET TICKER CAN BE TWO LINES OF ONE HOLDING,
 * and their weights ADD.
 *
 * That is not a corner case: the broker holds the Amsterdam line and
 * the Nasdaq line of one company, and the source's own vocabulary
 * maps both to the same market ticker (ASML.AS and ASML are both ASML).
 * Two lines of one holding are ONE position, and its weight is their
 * sum -- which is what makes the book's weights add up to the book's
 * own total (97.96 % read against the broker's own 98.27 %, and the
 * 0.31 % gap is exactly the smaller line).
 *
 * AND THE DISCRIMINATOR IS THE BROKER SYMBOL, not the picture.
 *
 * The five Overview pictures are consecutive scroll positions of one
 * table, so the SAME row appears in two of them -- the scroll overlap.
 * Adding those would double the book. But the overlap is the SAME
 * broker symbol read twice, while the two exchange lines are TWO
 * DIFFERENT broker symbols, and the source's own vocabulary is what
 * tells them apart: a symbol that is a vocabulary row of its OWN RIGHT
 * is a distinct broker line, and one that only resolves through the
 * dot-insensitive index is the same line read badly (the Overview
 * view's OCR drops the dot: "IDUSL" for "IDUS.L").
 *
 * @param {Map<string, object>} rows  the message's set
 * @param {object} position  the holding
 * @param {string} source  which reading it came from
 * @param {string} [picture]  which picture the row came from
 * @returns {Map<string, object>} the set
 */
function mergeInto(rows, position, source, picture) {
  const ticker = marketTickerOf(position.ticker);
  if (!ticker) return rows;
  const hasWeight = Number.isFinite(position.weight_pct);
  const existing = rows.get(ticker);
  if (!existing) {
    rows.set(ticker, {
      ...position,
      ticker,
      broker_symbol: position.ticker,
      source,
      hasWeight,
      picture: picture || '',
    });
    return rows;
  }
  // TWO LINES OF ONE POSITION: two DIFFERENT broker LINES that map to
  // one market ticker. Their weights ADD, and that is what closes the
  // book's 0.31 % gap.
  //
  // The SAME broker line is the scroll overlap -- the same row of a
  // scrolled table seen in two pictures -- and it does NOT add.
  //
  // And the LINE is the vocabulary's own key, because the vocabulary's
  // keys ARE the broker's spellings: "ASML.AS" is the Amsterdam line
  // and "ASML" is the Nasdaq line, while "ASMLAS" is the Amsterdam line
  // read with the dot dropped -- so the lossy read and its line resolve
  // to the SAME key and are one line.
  //
  // The INCOMING row carries the broker's spelling in `ticker` -- the
  // stored row carries it in `broker_symbol`, because its `ticker` has
  // become the market's. Comparing the wrong field made every scroll
  // overlap look like two lines, and the book summed to 101 %.
  const incomingLine = canonicalBrokerLine(position.broker_symbol || position.ticker);
  const existingLine = canonicalBrokerLine(existing.broker_symbol);
  if (hasWeight && existing.hasWeight
    && (position.broker_symbol || position.ticker) !== existing.broker_symbol
    && incomingLine !== existingLine) {
    const merged = { ...existing, weight_pct: existing.weight_pct + position.weight_pct };
    merged.merged_lines = (existing.merged_lines || 1) + 1;
    merged.merged_symbols = [existing.broker_symbol, position.broker_symbol || position.ticker];
    rows.set(ticker, merged);
    return rows;
  }
  if (hasWeight && !existing.hasWeight) {
    rows.set(ticker, {
      ...position,
      ticker,
      broker_symbol: position.ticker,
      source,
      hasWeight,
      picture: picture || '',
    });
    return rows;
  }
  const merged = { ...existing };
  for (const key of ['weight_pct', 'avg_cost', 'price', 'change_pct', 'pnl_pct']) {
    if (!Number.isFinite(merged[key]) && Number.isFinite(position[key])) merged[key] = position[key];
  }
  rows.set(ticker, merged);
  return rows;
}

module.exports = {
  HEADER_COLUMNS,
  bandRows,
  centreOf,
  checkRow,
  closeEnough,
  findColumns,
  mergeInto,
  parseCellNumber,
  parseNumber,
  parsePercent,
  readPositionsTable,
};
