'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createWorker } = require('tesseract.js');

const ROOT = path.resolve('data/video_scan_20260912');
const SHOTS = path.join(ROOT, 'screenshots');
const LOGS = path.join(ROOT, 'ocr_probe', 'logs');
const OUT = path.join(ROOT, 'reocr');
fs.mkdirSync(OUT, { recursive: true });

const logFiles = fs.readdirSync(LOGS).filter((name) => name.endsWith('.json')).sort();

const capturesByProbe = new Map();
for (const logFile of logFiles) {
  const parsed = JSON.parse(fs.readFileSync(path.join(LOGS, logFile), 'utf8'));
  capturesByProbe.set(logFile, parsed);
}

const captures = [];
for (const [logFile, parsed] of capturesByProbe) {
  if (!Array.isArray(parsed.captures)) continue;
  for (const cap of parsed.captures) {
    captures.push({
      video_path: parsed.video_path,
      log_file: logFile,
      probe_date_key: parsed.date_key,
      capture: cap
    });
  }
}

async function reocrSingle(worker, png) {
  const { data } = await worker.recognize(png, {}, { text: true });
  return data.text || '';
}

(async () => {
  const worker = await createWorker(['eng'], undefined, {
    logger: () => {}
  });
  const rows = [];
  let done = 0;
  for (const entry of captures) {
    const png = path.basename(entry.capture.output_path);
    const fullPath = path.join(SHOTS, png);
    const text = await reocrSingle(worker, fullPath);
    const cleaned = text.replace(/\s+/g, ' ').trim();
    const outObj = {
      png,
      probe_log: entry.log_file,
      probe_date_key: entry.probe_date_key,
      video_path: entry.video_path,
      frame_index: entry.capture.frame_index,
      timestamp: entry.capture.timestamp,
      timestamp_hms: formatHms(entry.capture.timestamp),
      screen_layout: entry.capture.screen_layout,
      score: entry.capture.score,
      ocr_confidence: entry.capture.ocr_confidence,
      issue_codes: entry.capture.issue_codes,
      ocr_text_full: cleaned,
      ocr_text_snippet: entry.capture.ocr_text_snippet
    };
    rows.push(outObj);
    fs.writeFileSync(
      path.join(OUT, png.replace(/\.png$/, '.json')),
      JSON.stringify(outObj, null, 2),
      'utf8'
    );
    done += 1;
    console.log(`[${done}/${captures.length}] ${png} (${entry.capture.screen_layout} @ t=${formatHms(entry.capture.timestamp)})`);
  }
  fs.writeFileSync(path.join(ROOT, 'reocr_full_text.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`wrote ${path.join(ROOT, 'reocr_full_text.json')}`);
  await worker.terminate();
})().catch((error) => {
  console.error('reocr failed:', error);
  process.exit(1);
});

function formatHms(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00';
  }
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(remainder)}`;
}
