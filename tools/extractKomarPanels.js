'use strict';

/**
 * Extract the PANEL FRAMES of the Komar corpus.
 *
 * WHAT THIS IS FOR
 *
 * The panel reader is measured against ONE pinned frame today, and one
 * frame is not a measurement: the corpus holds 29 dated sessions, each
 * with a portfolio panel, and they span 19 months and two applications
 * (TradingView on macOS and Windows, and the MarketSmith screens of
 * the 2022-2023 era). So this tool samples the sessions, finds the
 * frames where the portfolio panel is on screen, and writes them out
 * with a manifest -- the material for the pinned expectation that the
 * reader is then scored against.
 *
 *   node tools/extractKomarPanels.js --sessions 5
 *   node tools/extractKomarPanels.js --out data/komar_work/panels
 *
 * WHY THE DETECTION IS CHEAP
 *
 * The detection only asks "is the panel's HEADER on screen" -- one
 * OCR read of the panel's region per frame -- and the frames that
 * pass are then read IN FULL by the reader, once, for the score. So
 * the expensive reading happens on a handful of frames, not on every
 * candidate.
 *
 * WHY THE FRAMES ARE AT THE SOURCE RESOLUTION
 *
 * The panel's text is 9-13 px tall in the source. A downscaled frame
 * has no readable panel at all.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');

const { readCell } = require('../src/table/tableReader');
const { panelRegionForFrame } = require('../src/komar/panelLayout');
const { closeWorker } = require('../src/table/tableReader');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'derived.sqlite');
const SOURCE_DIR = process.env.KOMAR_SOURCE_DIR || 'D:\\courses_nosync\\julian_komar';

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  out: readFlag(argv, '--out') || path.join(ROOT, 'data', 'komar_work', 'panels'),
  sessions: Number(readFlag(argv, '--sessions')) || 0,
  from: readFlag(argv, '--from') || '',
  to: readFlag(argv, '--to') || '',
  manifest: readFlag(argv, '--manifest') || '',
};

/** How many candidate frames are sampled per session. */
const CANDIDATES = 10;

/**
 * The dated sessions, and the video that holds each one's portfolio.
 *
 * The 2026 reports are split into three videos ("- Market Overview",
 * "- My Portfolio", "- Stocks Analysis"), and the portfolio one is
 * named. The earlier sessions are a single file per report, and the
 * portfolio is a section inside it -- so those are sampled across
 * their whole length and the panel is FOUND.
 *
 * @returns {object[]}
 */
function listSessions() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db.prepare(`
    SELECT video_id, session_date, report_number, kind, part, title,
           duration_sec, media_path, folder, width, height
    FROM komar_videos
    WHERE kind = 'weekend' AND session_date <> ''
    ORDER BY session_date, video_id
  `).all();
  db.close();

  const bySession = new Map();
  for (const row of rows) {
    const key = `${row.session_date}-${row.report_number}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(row);
  }

  const sessions = [];
  for (const [key, videos] of bySession.entries()) {
    const portfolio = videos.find((video) => /portfolio/i.test(video.title || ''));
    // The named portfolio video, or every video of the session (the
    // panel is found by sampling).
    const candidates = portfolio ? [portfolio] : videos;
    sessions.push({
      candidates,
      key,
      report_number: Number(videos[0].report_number),
      session_date: videos[0].session_date,
    });
  }
  return sessions.sort((a, b) => a.session_date.localeCompare(b.session_date));
}

/**
 * Where a video's media is.
 *
 * The catalog stores the path relative to the corpus root, and the
 * folder column carries the sub-folder for the videos that live in
 * `_finished` -- but the stored path carries it too for some of them,
 * so the candidates are tried in turn rather than assumed.
 *
 * @param {object} video
 * @returns {string|null}
 */
function resolveMedia(video) {
  const relative = String(video.media_path || '');
  const folder = String(video.folder || '');
  const candidates = [
    path.join(SOURCE_DIR, relative),
    path.join(SOURCE_DIR, folder, relative),
    path.join(SOURCE_DIR, folder, path.basename(relative)),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Is the panel's HEADER on screen in this frame?
 *
 * @param {Buffer} raw
 * @param {{width: number, height: number, channels: number}} info
 * @returns {Promise<boolean>}
 */
async function panelOnScreen(raw, info) {
  const region = panelRegionForFrame('20260101', info);
  const rect = {
    bottom: region.top + Math.round(region.height * 0.12),
    left: region.left,
    right: region.left + region.width,
    top: region.top,
  };
  try {
    const read = await readCell(raw, info, rect, { scale: 2 });
    const text = (read.words || []).map((word) => String(word.text || '').toLowerCase()).join(' ');
    return /symbol/.test(text) && /last|chg/.test(text);
  } catch {
    return false;
  }
}

/**
 * One frame, extracted at the source resolution.
 *
 * @param {string} videoPath
 * @param {number} atSec
 * @param {string} outPath
 * @returns {boolean}
 */
function extractFrame(videoPath, atSec, outPath) {
  const result = spawnSync('ffmpeg', [
    '-y', '-ss', String(atSec), '-i', videoPath,
    '-frames:v', '1', outPath,
  ], { encoding: 'utf8', timeout: 120000 });
  return result.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

async function main() {
  fs.mkdirSync(options.out, { recursive: true });
  const sessions = listSessions();
  const chosen = options.sessions ? sessions.slice(0, options.sessions) : sessions;
  const manifest = [];

  for (const session of chosen) {
    for (const video of session.candidates) {
      const videoPath = resolveMedia(video);
      if (!videoPath) {
        console.log(`${session.session_date} r${session.report_number}: ${video.video_id} has no media`);
        continue;
      }
      const duration = Number(video.duration_sec) || 0;
      if (!duration) continue;
      // The portfolio is in the session's middle, so the candidates are
      // spread over the middle 80 % of it.
      const first = duration * 0.1;
      const step = (duration * 0.8) / Math.max(1, CANDIDATES - 1);
      for (let index = 0; index < CANDIDATES; index += 1) {
        const at = Math.round(first + step * index);
        const framePath = path.join(options.out, `${session.session_date}_r${session.report_number}_t${at}.png`);
        if (!extractFrame(videoPath, at, framePath)) continue;
        const source = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const onScreen = await panelOnScreen(source.data, source.info);
        console.log(`${session.session_date} r${session.report_number} t=${at}s ${source.info.width}x${source.info.height} `
          + `${onScreen ? 'THE PANEL IS ON SCREEN' : ''}`);
        if (!onScreen) {
          fs.unlinkSync(framePath);
          continue;
        }
        manifest.push({
          at_sec: at,
          frame: path.basename(framePath),
          height: source.info.height,
          report_number: session.report_number,
          session_date: session.session_date,
          title: video.title,
          video_id: video.video_id,
          width: source.info.width,
        });
      }
    }
  }

  const manifestPath = options.manifest || path.join(options.out, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\n${manifest.length} panel frames -> ${options.out}`);
  console.log(`the manifest: ${manifestPath}`);
  await closeWorker();
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
