'use strict';

/**
 * Where video media lives.
 *
 * Default: <repo>/data/video_pipeline/{downloads_1080p,downloads_hires,downloads}
 *
 * Override (first match wins per key):
 *   1. Env:
 *      PORTFOLIO_PIPELINE_ROOT
 *      PORTFOLIO_DOWNLOADS_1080P
 *      PORTFOLIO_DOWNLOADS_HIRES
 *      PORTFOLIO_DOWNLOADS
 *      PORTFOLIO_MEDIA_EXTRA_DIRS   (comma/semicolon-separated extra search folders)
 *   2. Config file data/video_pipeline/media_roots.json
 *      {
 *        "pipeline_root": null,
 *        "downloads_1080p": null,
 *        "downloads_hires": null,
 *        "downloads": null,
 *        "extra_dirs": ["D:/data/portfolio_analyzer_revere/videos"]
 *      }
 *
 * New downloads still go to downloads_1080p / downloads_hires (the primary
 * dirs). extra_dirs are searched for existing media so a library can span
 * C: and D: at the same time. Catalog download_path may be repo-relative or
 * an absolute path on any drive; resolveMediaPath() handles both.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PIPELINE = path.join(ROOT, 'data', 'video_pipeline');
const CONFIG_PATH = path.join(DEFAULT_PIPELINE, 'media_roots.json');

const DIR_KEYS = Object.freeze({
  downloads_1080p: 'downloads_1080p',
  downloads_hires: 'downloads_hires',
  downloads: 'downloads',
});

const ENV_KEYS = Object.freeze({
  pipeline_root: 'PORTFOLIO_PIPELINE_ROOT',
  downloads_1080p: 'PORTFOLIO_DOWNLOADS_1080P',
  downloads_hires: 'PORTFOLIO_DOWNLOADS_HIRES',
  downloads: 'PORTFOLIO_DOWNLOADS',
  extra_dirs: 'PORTFOLIO_MEDIA_EXTRA_DIRS',
});

let _cached = null;

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function expandPath(value) {
  if (value == null || value === '') return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/\//g, path.sep);
  if (s.startsWith('~')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    s = path.join(home, s.slice(1).replace(/^[\\/]/, ''));
  }
  if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    return path.resolve(s);
  }
  return path.resolve(ROOT, s);
}

function splitPathList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => splitPathList(v));
  }
  return String(value)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueResolvedDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    if (!d) continue;
    const resolved = path.resolve(String(d));
    const key = resolved.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

function parseExtraDirs(fileCfg, env) {
  const parts = [
    ...splitPathList(env[ENV_KEYS.extra_dirs]),
    ...splitPathList(fileCfg.extra_dirs),
    ...splitPathList(fileCfg.search_dirs),
  ];
  return uniqueResolvedDirs(parts.map(expandPath).filter(Boolean));
}

/**
 * Snapshot of resolved roots. Cached per process; call resetMediaRootsCache()
 * in tests after changing env/config.
 */
function getMediaRoots(options = {}) {
  if (_cached && !options.force) return _cached;

  const fileCfg = options.config || readConfigFile();
  const env = options.env || process.env;

  const pipelineFromEnv = expandPath(env[ENV_KEYS.pipeline_root]);
  const pipelineFromFile = expandPath(fileCfg.pipeline_root);
  const pipelineRoot = pipelineFromEnv || pipelineFromFile || DEFAULT_PIPELINE;

  function resolveDir(key) {
    const fromEnv = expandPath(env[ENV_KEYS[key]]);
    if (fromEnv) return fromEnv;
    const fromFile = expandPath(fileCfg[key]);
    if (fromFile) return fromFile;
    return path.join(pipelineRoot, key);
  }

  const extra_dirs = parseExtraDirs(fileCfg, env);

  _cached = Object.freeze({
    repoRoot: ROOT,
    configPath: CONFIG_PATH,
    pipelineRoot: path.resolve(pipelineRoot),
    downloads_1080p: resolveDir('downloads_1080p'),
    downloads_hires: resolveDir('downloads_hires'),
    downloads: resolveDir('downloads'),
    extra_dirs,
    usingDefaults:
      path.resolve(pipelineRoot) === path.resolve(DEFAULT_PIPELINE)
      && !env[ENV_KEYS.downloads_1080p]
      && !env[ENV_KEYS.downloads_hires]
      && !env[ENV_KEYS.downloads]
      && !env[ENV_KEYS.extra_dirs]
      && !fileCfg.downloads_1080p
      && !fileCfg.downloads_hires
      && !fileCfg.downloads
      && !fileCfg.pipeline_root
      && !(Array.isArray(fileCfg.extra_dirs) && fileCfg.extra_dirs.length)
      && !(Array.isArray(fileCfg.search_dirs) && fileCfg.search_dirs.length)
      && !env[ENV_KEYS.pipeline_root],
  });
  return _cached;
}

function resetMediaRootsCache() {
  _cached = null;
}

function getDownloadDir(kind = '1080p') {
  const roots = getMediaRoots();
  if (kind === '1080p' || kind === 'downloads_1080p') return roots.downloads_1080p;
  if (kind === 'hires' || kind === '720p' || kind === 'downloads_hires') return roots.downloads_hires;
  if (kind === 'downloads' || kind === 'legacy') return roots.downloads;
  throw new Error(`unknown download kind: ${kind}`);
}

/**
 * Directories to scan for existing media (primary 1080p, extras, then
 * lower-res fallbacks). New downloads still write only to getDownloadDir().
 */
function mediaSearchDirs(options = {}) {
  const roots = options.roots || getMediaRoots();
  return uniqueResolvedDirs([
    roots.downloads_1080p,
    ...(roots.extra_dirs || []),
    roots.downloads_hires,
    roots.downloads,
  ]);
}

/**
 * Dirs that may hold a finished 1080p (or equivalent) copy — used by the
 * 1080p downloader's "already on disk?" check. Excludes downloads_hires.
 */
function media1080SearchDirs(options = {}) {
  const roots = options.roots || getMediaRoots();
  return uniqueResolvedDirs([
    roots.downloads_1080p,
    ...(roots.extra_dirs || []),
  ]);
}

/**
 * Resolve a catalog download_path to an absolute local path.
 * Absolute paths (including other drives) are kept; repo-relative paths
 * resolve against the repository root.
 */
function resolveMediaPath(downloadPath, options = {}) {
  if (!downloadPath) return null;
  const raw = String(downloadPath).trim();
  if (!raw) return null;
  const normalised = raw.replace(/\\/g, '/');
  const cwd = options.cwd || ROOT;

  // Paths under this repo data tree rewrite from the data/ segment so a
  // foreign absolute checkout path still resolves here. External media roots
  // such as D:/portfolio_media/video_pipeline do not contain data/video_pipeline
  // and stay absolute.
  const marker = 'data/';
  const idx = normalised.toLowerCase().indexOf(marker);
  if (idx !== -1) {
    const after = normalised.slice(idx);
    if (
      after.startsWith('data/video_pipeline')
      || /^data\/video_scan_/i.test(after)
      || after.startsWith('data/video_ocr_probe')
    ) {
      return path.resolve(cwd, after);
    }
  }

  // Absolute Windows / POSIX / UNC (foreign media drives, etc.)
  if (/^[A-Za-z]:[\\/]/.test(raw) || normalised.startsWith('/') || normalised.startsWith('//')) {
    return path.resolve(raw);
  }

  return path.resolve(cwd, raw);
}

function videoIdFromStem(stem) {
  const m = String(stem).match(/^(?:\d{8}_)?(.+)$/);
  const id = m ? m[1] : String(stem);
  const m2 = id.match(/([A-Za-z0-9_-]{11})$/);
  return m2 ? m2[1] : id;
}

function dateFromStem(stem) {
  const m = String(stem).match(/^(20\d{6})_/);
  return m ? m[1] : null;
}

function resolutionLabelForDir(dir) {
  const n = String(dir || '').replace(/\\/g, '/').toLowerCase();
  if (n.includes('downloads_1080p')) return '1080p';
  if (n.includes('downloads_hires')) return '720p';
  if (n.includes('/downloads') && !n.includes('downloads_')) return 'legacy';
  return 'extra';
}

function hitFromFile(dir, file, overrides = {}) {
  const stem = path.parse(file).name;
  return {
    file,
    dir,
    path: path.join(dir, file),
    resolution: overrides.resolution || resolutionLabelForDir(dir),
    videoId: overrides.videoId || videoIdFromStem(stem),
    date: overrides.date || dateFromStem(stem),
  };
}

/**
 * Find a media file for a catalog date (YYYYMMDD). Prefers 1080p dir, then
 * extra_dirs, then lower-res fallbacks. Optional downloadPath is a catalog
 * pointer used when the date is not found by directory scan.
 */
function findMediaForDate(dateKey, options = {}) {
  const date = String(dateKey || '').replace(/-/g, '').slice(0, 8);
  if (!/^20\d{6}$/.test(date)) return null;
  const dirs = options.dirs || mediaSearchDirs();
  const exists = options.exists || fs.existsSync;
  const readdir = options.readdir || ((d) => fs.readdirSync(d));

  for (const dir of dirs) {
    if (!exists(dir)) continue;
    let files;
    try {
      files = readdir(dir);
    } catch {
      continue;
    }
    const match = files.find((f) => f.startsWith(`${date}_`) && f.endsWith('.mp4'));
    if (!match) continue;
    return hitFromFile(dir, match, { date });
  }

  if (options.downloadPath) {
    const p = resolveMediaPath(options.downloadPath, options);
    if (p && exists(p)) {
      return {
        file: path.basename(p),
        dir: path.dirname(p),
        path: p,
        resolution: resolutionLabelForDir(path.dirname(p)),
        videoId: videoIdFromStem(path.parse(p).name),
        date,
      };
    }
  }
  return null;
}

/**
 * Find media by video id across configured dirs, or via catalog download_path.
 */
function findMediaForVideoId(videoId, options = {}) {
  const id = String(videoId || '').trim();
  if (!id) return null;
  const dirs = options.dirs || mediaSearchDirs();
  const exists = options.exists || fs.existsSync;
  const readdir = options.readdir || ((d) => fs.readdirSync(d));

  for (const dir of dirs) {
    if (!exists(dir)) continue;
    let files;
    try {
      files = readdir(dir);
    } catch {
      continue;
    }
    const match = files.find((f) => {
      if (!f.endsWith('.mp4')) return false;
      const stem = path.parse(f).name;
      return videoIdFromStem(stem) === id || stem.endsWith(`_${id}`) || stem === id;
    });
    if (!match) continue;
    return hitFromFile(dir, match, { videoId: id });
  }

  if (options.downloadPath) {
    const p = resolveMediaPath(options.downloadPath, options);
    if (p && exists(p)) {
      return {
        file: path.basename(p),
        dir: path.dirname(p),
        path: p,
        resolution: resolutionLabelForDir(path.dirname(p)),
        videoId: id,
        date: dateFromStem(path.parse(p).name),
      };
    }
  }
  return null;
}

/**
 * Unified lookup: directory scan by date and/or id, then catalog pointer.
 */
function findMedia(options = {}) {
  const {
    dateKey,
    videoId,
    downloadPath,
    dirs,
    exists,
    readdir,
    cwd,
  } = options;
  const common = { dirs, exists, readdir, cwd, downloadPath };

  if (dateKey) {
    const byDate = findMediaForDate(dateKey, common);
    if (byDate) return byDate;
  }
  if (videoId) {
    const byId = findMediaForVideoId(videoId, common);
    if (byId) return byId;
  }
  if (downloadPath) {
    const p = resolveMediaPath(downloadPath, { cwd });
    const existsFn = exists || fs.existsSync;
    if (p && existsFn(p)) {
      return {
        file: path.basename(p),
        dir: path.dirname(p),
        path: p,
        resolution: resolutionLabelForDir(path.dirname(p)),
        videoId: videoId || videoIdFromStem(path.parse(p).name),
        date: dateKey || dateFromStem(path.parse(p).name),
      };
    }
  }
  return null;
}

/**
 * Ensure primary download directories exist (for downloaders).
 */
function ensureDownloadDirs() {
  const roots = getMediaRoots();
  for (const dir of [roots.downloads_1080p, roots.downloads_hires, roots.downloads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return roots;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_PIPELINE,
  DIR_KEYS,
  ENV_KEYS,
  ROOT,
  ensureDownloadDirs,
  findMedia,
  findMediaForDate,
  findMediaForVideoId,
  getDownloadDir,
  getMediaRoots,
  media1080SearchDirs,
  mediaSearchDirs,
  resetMediaRootsCache,
  resolveMediaPath,
  uniqueResolvedDirs,
  videoIdFromStem,
};
