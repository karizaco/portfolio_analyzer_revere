const fs = require('node:fs/promises');
const path = require('node:path');

const WHITEBOARD_PATTERN = /^(\d{8})_ps(?:_(\d+))?\.(?:jpg|jpeg|png|webp)$/i;

function toIsoDate(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function parseWhiteboardFilename(fileName) {
  const match = WHITEBOARD_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }

  const [, dateKey, rawSequence] = match;
  return {
    asOfDate: toIsoDate(dateKey),
    dateKey,
    sequence: rawSequence ? Number(rawSequence) : 1
  };
}

async function discoverWhiteboardScreenshots(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const screenshots = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseWhiteboardFilename(entry.name);
    if (!parsed) {
      continue;
    }

    screenshots.push({
      ...parsed,
      fileName: entry.name,
      fullPath: path.join(directoryPath, entry.name)
    });
  }

  screenshots.sort((left, right) => {
    if (left.dateKey !== right.dateKey) {
      return left.dateKey.localeCompare(right.dateKey);
    }

    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    return left.fileName.localeCompare(right.fileName);
  });

  return screenshots;
}

module.exports = {
  discoverWhiteboardScreenshots,
  parseWhiteboardFilename
};