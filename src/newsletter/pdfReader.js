'use strict';

/**
 * The Node side of the newsletter PDF reader.
 *
 * The corpus is "Microsoft Print to PDF" renders of a Substack post, and the
 * BODY TEXT of those renders is drawn as vector outlines rather than as
 * text -- so the text layer is a free, exact index of the STRUCTURE and the
 * CONTENT has to be OCR'd, which means the pages have to be rasterised.
 * Rasterising a PDF is a PyMuPDF job, so `tools/_oconnell_pdf.py` does it
 * and this module speaks JSON to it.
 *
 * WHY THE PYTHON IS PICKED, NOT ASSUMED
 *
 * `src/ocr/easyocrAdapter.js` already learned this lesson: the project
 * runs several interpreters (anaconda, the per-user installs, the system
 * Python) and only some of them have the package. A wrapper that hard
 * codes one interpreter is a wrapper that breaks on the next machine, so
 * the candidates are tried in order and the first one that can actually
 * import the module wins.
 *
 * The difference here is that the module is PyMuPDF rather than EasyOCR,
 * and the interpreter is a DIFFERENT one in general: PyMuPDF lives in the
 * system Python here, while EasyOCR lives in the anaconda one. So the
 * candidate list is checked for PyMuPDF specifically, and the two never
 * have to agree.
 */

const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const HELPER = path.join(ROOT, 'tools', '_oconnell_pdf.py');

/**
 * The interpreters to try, most likely first.
 *
 * `C:/Python314/python.exe` is first because that is where PyMuPDF is
 * installed on the machine this was written on; the anaconda interpreter
 * is second because it is the project's general-purpose Python.
 */
const PYTHON_CANDIDATES = [
  process.env.OCONNELL_PYTHON,
  'C:/Python314/python.exe',
  'C:/ProgramData/anaconda3/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python310/python.exe',
  'C:/Users/Admin/AppData/Local/Programs/Python/Python39/python.exe',
];

let cachedPython = null;

function pythonHasModule(pythonExe, moduleName) {
  try {
    execFileSync(pythonExe, ['-c', `import ${moduleName}; print('ok')`], {
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The interpreter that can import PyMuPDF.
 *
 * @returns {string} the executable path
 * @throws when no candidate has the module -- an honest failure beats a
 *   silent fallback to a parser that cannot read the corpus.
 */
function pickPython() {
  if (cachedPython) return cachedPython;
  for (const candidate of PYTHON_CANDIDATES) {
    if (!candidate) continue;
    if (!fs.existsSync(candidate)) continue;
    if (!pythonHasModule(candidate, 'pymupdf')) continue;
    cachedPython = candidate;
    return cachedPython;
  }
  throw new Error(
    'No Python with PyMuPDF was found. Tried: ' +
      PYTHON_CANDIDATES.filter(Boolean).join(', ') +
      '. Set OCONNELL_PYTHON to an interpreter that can `import pymupdf`.'
  );
}

function runHelper(args, { timeoutMs = 180000 } = {}) {
  const python = pickPython();
  const result = spawnSyncCapture(python, [HELPER, ...args], timeoutMs);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.error) {
    const error = new Error(parsed.error);
    error.payload = parsed;
    throw error;
  }
  if (result.status !== 0 && !parsed) {
    throw new Error(
      `PDF helper failed (exit ${result.status}): ${(result.stderr || '').trim().slice(0, 400)}`
    );
  }
  if (!parsed) {
    throw new Error(
      `PDF helper returned no JSON: ${(result.stdout || '').trim().slice(0, 400)}`
    );
  }
  return parsed;
}

function spawnSyncCapture(command, args, timeoutMs) {
  // spawnSync rather than execFileSync: the helper's stdout can be a few
  // hundred KB for a 30-page document, and execFileSync's default maxBuffer
  // is 1 MB, which a large document can exceed.
  const { spawnSync } = require('node:child_process');
  const outcome = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: outcome.status,
    stderr: outcome.stderr || '',
    stdout: outcome.stdout || '',
  };
}

/**
 * The structure of a document: page count, metadata, and per page the text
 * blocks (with bbox and font size) and the embedded images.
 *
 * @param {string} pdfPath
 * @returns {object} the helper's payload
 */
function readMeta(pdfPath) {
  return runHelper(['meta', pdfPath]);
}

/**
 * The structure of MANY documents, in one interpreter.
 *
 * The corpus is 302 PDFs, and spawning Python per document would spend
 * more time starting interpreters than parsing pages. One spawn for the
 * whole corpus is the difference between seconds and minutes.
 *
 * The list is CHUNKED: 302 absolute paths would be ~21 KB of command line,
 * which is inside the Windows limit but close enough to it that a corpus
 * twice this size would break it.
 *
 * @param {string[]} pdfPaths
 * @param {number} [chunkSize=40]
 * @returns {object[]} one result per input, in order. A document that
 *   could not be read is an object carrying `error`.
 */
function readMetaMany(pdfPaths, chunkSize = 40) {
  const paths = Array.isArray(pdfPaths) ? pdfPaths.filter(Boolean) : [];
  const results = [];
  for (let i = 0; i < paths.length; i += chunkSize) {
    const chunk = paths.slice(i, i + chunkSize);
    const parsed = runHelper(['meta-many', ...chunk], { timeoutMs: 600000 });
    if (!Array.isArray(parsed)) {
      // The helper returns an array; anything else means the contract broke.
      throw new Error(`PDF helper meta-many returned ${typeof parsed}, expected an array`);
    }
    for (const entry of parsed) results.push(entry);
  }
  return results;
}

/**
 * Rasterise one page to a PNG.
 *
 * @param {string} pdfPath
 * @param {number} page - 1-based
 * @param {string} outPath
 * @param {number} [dpi=200]
 * @returns {object} { width, height, out }
 */
function renderPage(pdfPath, page, outPath, dpi = 200) {
  return runHelper(['render', pdfPath, '--page', String(page), '--dpi', String(dpi), '--out', outPath]);
}

/**
 * Write one embedded image out at its NATIVE resolution.
 *
 * @param {string} pdfPath
 * @param {number} page - 1-based
 * @param {number} xref
 * @param {string} outPath
 * @returns {object} { width, height, out }
 */
function extractEmbeddedImage(pdfPath, page, xref, outPath) {
  return runHelper([
    'extract-image',
    pdfPath,
    '--page',
    String(page),
    '--xref',
    String(xref),
    '--out',
    outPath,
  ]);
}

module.exports = {
  PYTHON_CANDIDATES,
  extractEmbeddedImage,
  pickPython,
  readMeta,
  readMetaMany,
  renderPage,
};
