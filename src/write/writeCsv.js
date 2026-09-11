const fs = require('node:fs/promises');
const path = require('node:path');

function serializeCell(value) {
  if (Array.isArray(value)) {
    return value.join('|');
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function escapeCsv(value) {
  const text = serializeCell(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

async function writeCsv(filePath, columns, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(','));
  }

  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

module.exports = {
  writeCsv
};
