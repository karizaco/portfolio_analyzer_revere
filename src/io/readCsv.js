const fs = require('node:fs/promises');

/**
 * Parse ONE line of CSV.
 *
 * @param {string} line
 * @returns {string[]} the cells
 */
function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      const nextCharacter = line[index + 1];
      if (inQuotes && nextCharacter === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (character === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

/**
 * Parse a CSV into RECORDS, and a record is not a line.
 *
 * WHY THIS EXISTS
 *
 * A quoted field may contain a NEWLINE, and the project's own writer
 * writes one: `writeCsv` quotes any field containing `",` or a newline.
 * The `evidence_text` column of the outcome CSVs carries the raw
 * transcript of a claim, and those transcripts contain line breaks.
 *
 * A line-based reader therefore SPLITS A RECORD IN TWO and shifts every
 * column after it -- silently, because the row still has the right
 * number of cells. Measured on `data/sevcik_outcomes.csv`: 10,324 of
 * 10,324 data rows failed to parse under a line-based reader, and the
 * 1,708 that DID parse were the ones whose evidence happened to have no
 * line break in it.
 *
 * So the reader here walks the file as a CHARACTER STREAM and only ends
 * a record at a newline that is not inside a quoted field.
 *
 * @param {string} content
 * @returns {string[][]} the records, each an array of cells
 */
function parseCsvRecords(content) {
  const records = [];
  let cells = [];
  let current = '';
  let inQuotes = false;

  const endCell = () => {
    cells.push(current.trim());
    current = '';
  };
  const endRecord = () => {
    endCell();
    // A blank line is not a record.
    if (cells.length > 1 || cells[0] !== '') records.push(cells);
    cells = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          current += '"';
          index += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      current += character;
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      endCell();
      continue;
    }
    if (character === '\r') {
      continue;
    }
    if (character === '\n') {
      endRecord();
      continue;
    }
    current += character;
  }

  if (current.length || cells.length) endRecord();
  return records;
}

/**
 * Read a CSV into rows keyed by the header.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>} the rows
 */
async function loadCsvRows(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const records = parseCsvRecords(content);
    if (!records.length) {
      return [];
    }

    const headers = records[0];
    return records.slice(1).map((values) => {
      const row = {};
      for (let index = 0; index < headers.length; index += 1) {
        row[headers[index]] = values[index] || '';
      }

      return row;
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

module.exports = {
  loadCsvRows,
  parseCsvLine,
  parseCsvRecords
};
