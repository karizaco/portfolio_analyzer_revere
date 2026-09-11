const fs = require('node:fs/promises');
const path = require('node:path');

const SCREENSHOT_PATTERN = /^revere_(\d{8})(?:_(\d+))?\.png$/i;

function toIsoDate(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function parseScreenshotFilename(fileName) {
  const match = SCREENSHOT_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }

  const [, dateKey, rawSequence] = match;
  return {
    dateKey,
    asOfDate: toIsoDate(dateKey),
    sequence: rawSequence ? Number(rawSequence) : 1
  };
}

async function discoverScreenshots(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const screenshots = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseScreenshotFilename(entry.name);
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
  discoverScreenshots,
  parseScreenshotFilename
};
