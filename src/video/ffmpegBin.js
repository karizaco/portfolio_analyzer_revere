'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Locating ffmpeg and ffprobe.
//
// WHY THIS IS A SHARED MODULE
// Four separate tools grew their own resolver, and they disagreed:
//   tools/scanVideoWithOcr.js        PATH substring -> C:/ffmpeg/bin -> winget Gyan
//   tools/buildSynthetic*Video.js     FFMPEG_BIN env -> `where ffmpeg` -> C:/ffmpeg/bin -> winget Gyan
//   tools/makeBatchSnapshots.js       a hardcoded absolute path to one machine
//   src/video/panelExtract.js         bare 'ffmpeg' / 'ffprobe' — ENOENT whenever
//                                     ffmpeg is not on PATH
//
// The disagreement is not cosmetic. A resolver that only inspects the PATH
// STRING for the substring "ffmpeg" reports success for a PATH that merely
// MENTIONS ffmpeg somewhere, and then spawn fails with ENOENT — the exact
// failure panelExtract.js had. `where` asks the OS where the binary actually
// is, which is the question worth asking.
//
// RESOLUTION ORDER
//   1. an explicit path from the caller
//   2. FFMPEG_BIN / FFPROBE_BIN in the environment
//   3. the OS PATH lookup (`where` on Windows, `which` elsewhere)
//   4. the usual install directories (C:/ffmpeg/bin, Program Files)
//   5. the winget Gyan.FFmpeg package directories
//   6. for ffprobe: the sibling of the resolved ffmpeg
//   7. the bare name, and let the OS try
//
// Steps 2 and 3 are what the synthetic-video tools already did and what the
// scan tool did NOT; steps 4 and 5 are what the scan tool already did and
// what the synthetic-video tools did NOT. The union is what every caller
// wanted.
//
// FFPROBE IS OPTIONAL
// `resolveFfprobeBin` returns null when nothing is found rather than
// throwing, because callers treat ffprobe as a nicety: without it the scan
// skips the keyframe lookup and the resolution check, and says so. ffmpeg
// itself is not optional — every caller that needs it cannot work without it.

const DIRECT_CANDIDATES = {
  ffmpeg: [
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
  ],
  ffprobe: [
    'C:/ffmpeg/bin/ffprobe.exe',
    'C:/Program Files/ffmpeg/bin/ffprobe.exe',
  ],
};

const ENV_VARS = {
  ffmpeg: 'FFMPEG_BIN',
  ffprobe: 'FFPROBE_BIN',
};

/**
 * Ask the OS where a binary lives.
 *
 * `where` on Windows, `which` elsewhere. Both print the resolved path on
 * stdout; both fail with a non-zero status when the binary is not found.
 */
function findOnPath(binaryName) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(lookup, [binaryName], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return null;
    const first = String(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * The ffmpeg.exe / ffprobe.exe inside a winget Gyan.FFmpeg package.
 *
 * The winget package nests the binaries one level down:
 *   Packages/Gyan.FFmpeg_Microsoft.Winget.Source_<hash>/ffmpeg-<version>-full_build/bin/ffmpeg.exe
 * so the package directory has to be walked, not guessed.
 */
function wingetCandidates(binaryName) {
  const wingetRoot = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'Microsoft',
    'WinGet',
    'Packages'
  );
  try {
    if (!fs.existsSync(wingetRoot)) return [];
    return fs
      .readdirSync(wingetRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Gyan.FFmpeg'))
      .flatMap((entry) => {
        const vendorRoot = path.join(wingetRoot, entry.name);
        try {
          return fs
            .readdirSync(vendorRoot, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => path.join(vendorRoot, child.name, 'bin', binaryName));
        } catch {
          return [];
        }
      })
      .filter((candidate) => fs.existsSync(candidate))
      .sort();
  } catch {
    return [];
  }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Resolve the ffmpeg binary.
 *
 * @param {string} [explicitValue] a path the caller insists on. The literal
 *   strings 'ffmpeg' and 'ffprobe' are treated as "no preference" so that a
 *   CLI default does not defeat the search.
 * @returns {string} a path to ffmpeg. Falls back to the bare name 'ffmpeg',
 *   which the OS may still resolve.
 */
function resolveFfmpegBin(explicitValue) {
  return resolveBinary('ffmpeg', explicitValue);
}

/**
 * Resolve the ffprobe binary.
 *
 * @param {string} [explicitValue] a path the caller insists on.
 * @returns {string|null} a path to ffprobe, or null when none was found.
 *   Callers treat null as "the optional step is unavailable", not as an error.
 */
function resolveFfprobeBin(explicitValue) {
  return resolveBinary('ffprobe', explicitValue, { optional: true });
}

function resolveBinary(binaryName, explicitValue, options = {}) {
  const optional = Boolean(options.optional);

  // 1. the caller's explicit path
  if (explicitValue && explicitValue !== binaryName) {
    return explicitValue;
  }

  // 2. the environment
  const envValue = process.env[ENV_VARS[binaryName]];
  if (envValue && fs.existsSync(envValue)) {
    return envValue;
  }

  // 3. the OS PATH
  const onPath = findOnPath(binaryName);
  if (onPath) {
    return onPath;
  }

  // 4. the usual install directories
  const direct = firstExisting(DIRECT_CANDIDATES[binaryName]);
  if (direct) {
    return direct;
  }

  // 5. the winget package
  const winget = wingetCandidates(binaryName);
  if (winget.length) {
    return winget[winget.length - 1];
  }

  // 6. ffprobe usually ships beside ffmpeg
  if (binaryName === 'ffprobe') {
    const ffmpegBin = resolveBinary('ffmpeg', null);
    if (ffmpegBin && ffmpegBin !== 'ffmpeg') {
      const sibling = path.join(path.dirname(ffmpegBin), binaryName);
      try {
        fs.accessSync(sibling);
        return sibling;
      } catch {
        // fall through
      }
    }
  }

  // 7. the bare name.
  //
  // For ffmpeg this is the contract every caller already relies on: the
  // spawn fails loudly if the OS cannot find it either. For ffprobe it
  // would be a LIE — ffprobe is optional, and returning a name that cannot
  // be spawned turns "the optional step is unavailable" into a spawn
  // error. So ffprobe reports absence as null instead.
  return optional ? null : binaryName;
}

module.exports = {
  resolveFfmpegBin,
  resolveFfprobeBin,
  findOnPath,
};
