const fs = require('node:fs/promises');
const path = require('node:path');

// Build the regex that matches screenshot PNGs for one channel. The basename
// comes from the `--basename` CLI flag (default `revere`). Filenames look like
// `<basename>_<YYYYMMDD>.png` or `<basename>_<YYYYMMDD>_<n>.png`. We anchor
// the regex on a sanitized basename (lowercased, only [a-z0-9_-]) so it can't
// be tricked into matching arbitrary filenames.
function buildScreenshotPattern(basename) {
  const safe = String(basename || 'revere').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() || 'revere';
  return new RegExp(`^${safe}_(\\d{8})(?:_(\\d+))?\\.png$`, 'i');
}

// Default pattern (revere) — preserved for callers that only ever run against
// the revere screenshot directory. New code should call buildScreenshotPattern
// with the channel-specific basename.
const SCREENSHOT_PATTERN = buildScreenshotPattern('revere');

function toIsoDate(dateKey) {
  return `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
}

function parseScreenshotFilename(fileName, basename = 'revere') {
  const pattern = basename === 'revere' ? SCREENSHOT_PATTERN : buildScreenshotPattern(basename);
  const match = pattern.exec(fileName);
  if (!match) {
    return null;
  }

  const [, dateKey, rawSequence] = match;
  return {
    basename,
    dateKey,
    asOfDate: toIsoDate(dateKey),
    sequence: rawSequence ? Number(rawSequence) : 1
  };
}

async function discoverScreenshots(directoryPath, options = {}) {
  const basename = String(options.basename || 'revere');
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const screenshots = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const parsed = parseScreenshotFilename(entry.name, basename);
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
  SCREENSHOT_PATTERN,
  buildScreenshotPattern,
  discoverScreenshots,
  parseScreenshotFilename
};
