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

function runEasyOcr(imagePath, options = {}) {
  const python = pickPython(options.pythonPath);
  const scriptPath = resolveWrapperPath();
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(imagePath)) {
      reject(new Error(`EasyOCR: image not found: ${imagePath}`));
      return;
    }
    const child = spawn(python, [scriptPath, imagePath], {
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
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`EasyOCR timeout after ${options.timeoutMs || 600000}ms\nstderr: ${stderr}`));
    }, options.timeoutMs || 600000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`EasyOCR exited with code ${code}\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.error) {
          reject(new Error(`EasyOCR returned error: ${parsed.error}\nstderr: ${stderr}`));
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
    // cropWidth used by identifyPositionListColumn in parseChartStream.js to scale
    // X_POSITION_LIST_MIN. Measured from the OCR input image by the caller.
    _cropWidth: Number.isFinite(options.cropWidth) ? options.cropWidth : null,
  };
}

module.exports = { runEasyOcr, adaptToParserSchema, pickPython, resolveWrapperPath };
