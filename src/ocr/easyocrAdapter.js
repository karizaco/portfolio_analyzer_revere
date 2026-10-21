'use strict';

// Adapter that spawns the EasyOCR Python wrapper (_easyocr_ocr.py) and
// returns a Tesseract-compatible OCR result object compatible with the
// downstream parser (parseChartStream.js expects { text, lines, words[] }).
//
// Used as an alternative OCR engine when Tesseract produces too-garbled
// text for QMG position lists. See _easyocr_ocr.py for the Python side.
//
// On Windows, EasyOCR 1.7.2+ ships wheels for Python 3.9 through 3.14,
// so any modern Python works. The legacy "Python 3.11 required" guidance
// in older docs no longer applies. Override via the EASYOCR_PYTHON env var
// or --easyocr-python CLI arg. The anaconda Python is recommended on dev
// machines because it usually has CUDA-enabled torch pre-installed.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Try the recommended Python first (anaconda with CUDA torch), then fall
// back to any standalone install under the user's AppData. The legacy
// Python 3.11 path is preserved as a fallback for older setups.
const DEFAULT_PYTHON_CANDIDATES = [
  'C:/ProgramData/anaconda3/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python310/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python39/python.exe',
  'C:/Python314/python.exe',
];

function pythonHasEasyOCR(pythonExe) {
  try {
    const { execSync } = require('node:child_process');
    execSync(`"${pythonExe}" -c "import easyocr; print('ok')"`, {
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KMP_DUPLICATE_LIB_OK: 'TRUE' },
    });
    return true;
  } catch {
    return false;
  }
}

function pickPython(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  const envPath = process.env.EASYOCR_PYTHON;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const candidate of DEFAULT_PYTHON_CANDIDATES) {
    if (fs.existsSync(candidate) && pythonHasEasyOCR(candidate)) return candidate;
  }
  return 'python'; // PATH fallback — verified to have EasyOCR earlier in this session
}

// Resolve the Python wrapper script. Lives in tools/_easyocr_ocr.py relative
// to the project root (two dirs up from src/ocr/).
function resolveWrapperPath() {
  // src/ocr/easyocrAdapter.js → ../../tools/_easyocr_ocr.py
  return path.resolve(__dirname, '..', '..', 'tools', '_easyocr_ocr.py');
}

// Detection/recognition tuning forwarded to `_easyocr_ocr.py` as `key=value`
// args. Omitting a key leaves EasyOCR's own default in place, so production
// scans are unaffected unless a caller opts in.
const READTEXT_TUNING_KEYS = [
  'width_ths',
  'height_ths',
  'add_margin',
  'contrast_ths',
  'adjust_contrast',
  'mag_ratio',
  'allowlist',
  'text_threshold',
  'low_text',
  'link_threshold',
];

function buildEasyOcrArgs(imagePath, options = {}) {
  const args = [imagePath];
  for (const key of READTEXT_TUNING_KEYS) {
    if (options[key] === undefined || options[key] === null) continue;
    args.push(`${key}=${typeof options[key] === 'object'
      ? JSON.stringify(options[key])
      : String(options[key])}`);
  }
  return args;
}

function runEasyOcr(imagePath, options = {}) {
  return runEasyOcrBatch([imagePath], options)
    .then((results) => {
      const result = results[0];
      if (result && result.error) {
        throw new Error(`EasyOCR: ${result.error}${result.traceback ? `\n${result.traceback}` : ''}`);
      }
      return result;
    });
}

// OCR many images in ONE process. EasyOCR loads an ~80MB model per process, so
// the previous one-spawn-per-frame shape spent more wall-clock loading models
// than reading text — a 12-frame scan paid 12 model loads. Batch mode loads
// once and costs only recognition time per image.
//
// Returns an array in the same order as `imagePaths`. A per-image failure is
// reported as `{ error }` at that index rather than failing the whole batch.
function runEasyOcrBatch(imagePaths, options = {}) {
  const python = pickPython(options.pythonPath);
  const scriptPath = resolveWrapperPath();
  if (!Array.isArray(imagePaths) || !imagePaths.length) {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    const missing = imagePaths.filter((p) => !fs.existsSync(p));
    if (missing.length === imagePaths.length) {
      reject(new Error(`EasyOCR: image not found: ${missing[0]}`));
      return;
    }
    const args = [scriptPath];
    for (const imagePath of imagePaths) {
      args.push(...buildEasyOcrArgs(imagePath, options));
    }
    const child = spawn(python, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Low-CPU env is MANDATORY (see CLAUDE.md): EasyOCR's PyTorch/OpenMP
      // backend otherwise spawns one thread per core per process and
      // saturates the whole machine. Enforced here — at the single choke
      // point for every EasyOCR call — so no caller can forget it.
      env: {
        ...process.env,
        OMP_NUM_THREADS: '1',
        MKL_NUM_THREADS: '1',
        KMP_DUPLICATE_LIB_OK: 'TRUE',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    // One process now serves the whole batch, so the budget has to cover
    // recognition for every image, not just one (~60-150s each on CPU) plus the
    // one-time model load.
    const perImageMs = options.timeoutMs || 600000;
    const totalMs = Math.ceil(perImageMs * imagePaths.length) + 120000;
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`EasyOCR timeout after ${totalMs}ms for ${imagePaths.length} image(s)\nstderr: ${stderr}`));
    }, totalMs);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`EasyOCR exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed)) {
          // Single-image mode: the wrapper emits a bare object.
          if (parsed && parsed.error) {
            reject(new Error(`EasyOCR returned error: ${parsed.error}\nstderr: ${stderr}`));
            return;
          }
          resolve([parsed]);
          return;
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(`EasyOCR: failed to parse JSON: ${e.message}\nstdout(first 500): ${stdout.slice(0, 500)}`));
      }
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(new Error(`EasyOCR spawn error: ${err.message}`));
    });
  });
}

// Map the EasyOCR output (and a confidence value) to the schema that the
// chart-stream parser expects. Currently identical to EasyOCR's output
// (already has text/lines/words), but we explicitly normalize the field
// names and compute an overall confidence from per-word confidences.
//
// `options.cropWidth` MUST be the pixel width of the image EasyOCR actually
// read. parseChartStream.js scales its X_POSITION_LIST_MIN threshold by
// (cropWidth / 750) to locate the position-list column, so a wrong width
// silently rejects every ticker (too large) or accepts chart-area bleed
// (too small). It depends on the source video resolution AND the overlay
// upscale factor — e.g. 1920x1080 @ scale 5 -> 1345px, 1280x720 @ scale 5
// -> 895px — so it must be measured, never hardcoded.
function adaptToParserSchema(easyocrResult, options = {}) {
  const words = Array.isArray(easyocrResult.words) ? easyocrResult.words : [];
  const confs = words.map((w) => Number(w.conf || 0)).filter((c) => c > 0);
  const confidence = confs.length
    ? confs.reduce((a, b) => a + b, 0) / confs.length
    : 0;
  return {
    text: String(easyocrResult.text || ''),
    lines: Array.isArray(easyocrResult.lines) ? easyocrResult.lines : [],
    words: words.map((w) => ({
      lineKey: `easy:${Number(w.line || 0)}`,
      text: String(w.text || ''),
      left: Number(w.left || 0),
      top: Number(w.top || 0),
      width: Number(w.width || 0),
      height: Number(w.height || 0),
      conf: Number(w.conf || 0),
      line: Number(w.line || 0),
    })),
    confidence,
    _engine: 'easyocr',
    // Width of the image EasyOCR actually read, in pixels — the caller measures
    // it from the crop it produced. Not hardcoded: the upscale factor depends on
    // source resolution and crop fraction, so it varies per run. (The position
    // column gate in parseChartStream.js no longer branches on this value, but
    // it is kept for diagnostics.)
    _cropWidth: Number.isFinite(options.cropWidth) ? options.cropWidth : null,
  };
}

module.exports = {
  runEasyOcr,
  runEasyOcrBatch,
  adaptToParserSchema,
  pickPython,
  resolveWrapperPath,
  buildEasyOcrArgs,
  READTEXT_TUNING_KEYS,
};
