'use strict';

// Fetch YouTube auto-captions for every video in the catalog that doesn't yet
// have a transcript on disk. Channels with English auto-captions yield the
// best coverage; Qullamaggie often has none, so the tool gracefully reports
// per-row success rate.
//
// Reads:
//   data/video_pipeline/state.sqlite  (videos.channel, transcript_path, etc.)
// Writes:
//   data/video_pipeline/transcripts/<video_id>.json   (parsed segments)
//   data/video_pipeline/transcripts/<video_id>.en.vtt  (raw VTT)
//
// Usage:
//   node tools/fetchCaptions.js                   # all channels
//   CHANNEL=qullamaggie node tools/fetchCaptions.js
//   CHANNEL=revere node tools/fetchCaptions.js
//   node tools/fetchCaptions.js --limit 10        # first 10
//   node tools/fetchCaptions.js --video-id abc123 # one specific id

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const limit = Number(readFlag(argv, '--limit')) || 0;
const channelArg = process.env.CHANNEL || readFlag(argv, '--channel') || '';
const videoIdArg = readFlag(argv, '--video-id') || '';

const dbPath = path.resolve('data/video_pipeline/state.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error(`No SQLite state at ${dbPath}. Run 'npm run video:init' first.`);
  process.exit(1);
}

const transcriptsDir = path.resolve('data/video_pipeline/transcripts');
fs.mkdirSync(transcriptsDir, { recursive: true });

// yt-dlp is installed as a Python module; use 'py -3 -m yt_dlp' instead of
// a bare 'yt-dlp' command so the tool is found on all install methods.
const py = process.platform === 'win32' ? 'py' : 'python3';
const ytdlpBin = [py, '-3', '-m', 'yt_dlp'];
const script = `
import json, sqlite3, sys
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
filters = ["transcript_path = ''", "video_url != ''"]
params = []
${channelArg ? `filters.append('channel = ?'); params.append(${JSON.stringify(channelArg)})` : ''}
${videoIdArg ? `filters.append('video_id = ?'); params.append(${JSON.stringify(videoIdArg)})` : ''}
limit_clause = 'LIMIT ' + str(${limit}) if ${limit} else ''
rows = conn.execute(
    f"SELECT video_id, channel, title, video_url FROM videos WHERE {' AND '.join(filters)} "
    f"ORDER BY upload_date DESC {limit_clause}",
    params
).fetchall()
json.dump([dict(r) for r in rows], sys.stdout, default=str)
`;
const res = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
if (res.status !== 0) {
  console.error(res.stderr);
  process.exit(1);
}
const rows = JSON.parse(res.stdout);
console.log(`[fetch-captions] candidates=${rows.length} channel=${channelArg || 'all'}`);

let fetched = 0;
let skipped = 0;
let errors = 0;
for (const row of rows) {
  const { video_id: videoId, channel, title, video_url: videoUrl } = row;
  const baseOut = path.join(transcriptsDir, videoId);
  const vttPath = `${baseOut}.en.vtt`;
  const jsonPath = `${baseOut}.json`;
  if (fs.existsSync(jsonPath)) {
    skipped += 1;
    continue;
  }
  console.log(`[fetch-captions] ${videoId} (${channel}) "${(title || '').slice(0, 50)}"`);
  const ytdlp = spawnSync(ytdlpBin[0], ytdlpBin.slice(1).concat([
    '--write-auto-subs',
    '--skip-download',
    '--sub-lang', 'en',
    '--convert-subs', 'vtt',
    '-o', `${baseOut}.%(ext)s`,
    videoUrl
  ]), { encoding: 'utf8' });
  if (ytdlp.status !== 0) {
    errors += 1;
    console.error(`[fetch-captions] yt-dlp failed for ${videoId}: ${(ytdlp.stderr || '').slice(0, 200)}`);
    continue;
  }
  if (!fs.existsSync(vttPath)) {
    errors += 1;
    console.error(`[fetch-captions] no .en.vtt produced for ${videoId} (likely no auto-captions)`);
    continue;
  }
  let segments;
  try {
    segments = parseVtt(fs.readFileSync(vttPath, 'utf8'));
  } catch (e) {
    errors += 1;
    console.error(`[fetch-captions] VTT parse failed for ${videoId}: ${e.message}`);
    continue;
  }
  fs.writeFileSync(jsonPath, JSON.stringify({
    video_id: videoId,
    channel,
    title,
    fetched_at: new Date().toISOString(),
    segment_count: segments.length,
    segments
  }, null, 2), 'utf8');
  fetched += 1;
  // Mark transcript_path in SQLite so we don't re-fetch next run.
  const update = `
import sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.execute(
    "UPDATE videos SET transcript_path = ?, transcript_segment_count = ?, transcript_fetched_at = ? "
    "WHERE video_id = ?",
    (${JSON.stringify(jsonPath)}, ${segments.length}, ${JSON.stringify(new Date().toISOString())}, ${JSON.stringify(videoId)})
)
conn.commit()
`;
  const updRes = spawnSync(py, ['-3', '-c', update], { encoding: 'utf8' });
  if (updRes.status !== 0) {
    console.error(`[fetch-captions] WARN: failed to update transcript_path for ${videoId}: ${updRes.stderr}`);
  }
}

console.log(`[fetch-captions] done: fetched=${fetched} skipped=${skipped} errors=${errors} total=${rows.length}`);

// Minimal WebVTT → JSON parser. The shape is intentionally simple — we don't
// need styling or position metadata, only the (start, end, text) triples for
// downstream consumers. Tags like <c>...</c> are stripped; line breaks inside
// a single cue are collapsed to spaces.
function parseVtt(vttText) {
  const lines = String(vttText || '').replace(/\r\n/g, '\n').split('\n');
  const segments = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Look for a timestamp header; skip metadata and empty lines.
    if (!line.includes('-->')) {
      i += 1;
      continue;
    }
    const timestampMatch = line.match(
      /(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/
    );
    if (!timestampMatch) {
      i += 1;
      continue;
    }
    const startTs = vttTimestampToSeconds(timestampMatch);
    const endTimestampMatch = line.match(/-->\s+(.+)/);
    const endRaw = endTimestampMatch ? endTimestampMatch[1].trim().split(/\s+/)[0] : null;
    const endTs = endRaw ? vttTimestampToSeconds(parseVttTimestamp(endRaw)) : startTs + 1;
    i += 1;
    // Collect content lines until we hit an empty line or the next timestamp header.
    const textLines = [];
    while (i < lines.length) {
      const nextLine = lines[i].trim();
      if (nextLine === '' || /-->/.test(nextLine)) break;
      textLines.push(nextLine);
      i += 1;
    }
    const text = textLines
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      segments.push({ start_ts: Number(startTs.toFixed(3)), end_ts: Number(endTs.toFixed(3)), text });
    }
    // If we broke on an empty line, consume it and loop to the next timestamp.
    if (i < lines.length && lines[i].trim() === '') i += 1;
  }
  return segments;
}

function parseVttTimestamp(stamp) {
  const match = String(stamp).match(/(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return null;
  return { hours: match[1] ? Number(match[1].replace(':', '')) : 0, minutes: Number(match[2]), seconds: Number(match[3]), millis: Number(match[4]) };
}

function vttTimestampToSeconds(parsed) {
  if (!parsed) return 0;
  const h = parsed.hours || 0;
  return h * 3600 + parsed.minutes * 60 + parsed.seconds + parsed.millis / 1000;
}

function readFlag(arr, flag) {
  const i = arr.indexOf(flag);
  if (i === -1) return null;
  return arr[i + 1] || '';
}
