'use strict';
// Orchestrate positional whiteboard OCR scan across all Revere videos.
// Usage: node tools/_revere_scan.js [--parallel N] [--fps F] [--max-captures N]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { superviseChild } = require('./qmg_scan_daemon_support');

const ROOT = path.resolve(__dirname, '..');
const VIDEO_DIR = path.join(ROOT, 'data/video_pipeline/downloads_hires');
const OUT_ROOT = path.join(ROOT, 'data');

function parseArgs(argv) {
  const args = { parallel: 1, fps: 0.1, maxCaptures: 1, prefilterMaxFrames: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--parallel') args.parallel = Math.max(1, parseInt(argv[++i] || '1', 10));
    else if (a === '--fps') args.fps = parseFloat(argv[++i] || '0.25');
    else if (a === '--max-captures') args.maxCaptures = parseInt(argv[++i] || '1', 10);
    else if (a === '--prefilter-max-frames') args.prefilterMaxFrames = parseInt(argv[++i] || '6', 10);
  }
  return args;
}

/**
 * Was the scan a success?
 *
 * The answer comes from the PROBE LOG on disk, not from the child's stdout.
 * The scan tool prints its whole result object to stdout at the very end,
 * and `status` sits AFTER the huge `captures` array in that object — so a
 * bounded stdout tail cannot be trusted to carry it. The probe log is the
 * authoritative record anyway (CLAUDE.md: the log on disk is what a reader
 * consumes), and it is written BEFORE the tool's final console.log, so it
 * exists even on the run that used to hang.
 */
function readProbeStatus(runTag, dateKey) {
  const logsDir = path.join(OUT_ROOT, runTag, 'ocr_probe', 'logs');
  try {
    const file = fs.readdirSync(logsDir).find((f) => f.startsWith(`${dateKey}_`) && f.endsWith('.json'));
    if (!file) return null;
    const log = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8'));
    return log.status || null;
  } catch (_) {
    return null;
  }
}

async function runScan(videoId, videoPath, dateKey, runTag, options) {
  const cmd = [
    'node', path.join(ROOT, 'tools', 'scanVideoWithOcr.js'),
    '--video', videoPath,
    '--date', dateKey,
    '--basename', 'revere',
    '--output-kind', 'whiteboard',
    '--output-root', OUT_ROOT,
    '--run-tag', runTag,
    '--max-captures', String(options.maxCaptures),
    '--fps', String(options.fps),
    '--prefilter-max-frames', String(options.prefilterMaxFrames),
  ];
  // superviseChild() DRAINS the child's stdout and kills the whole process
  // TREE on timeout. See tools/qmg_scan_daemon_support.js.
  const { status, code, stdoutTail, stderr } = await superviseChild(cmd, process.env, {
    timeoutMs: 600 * 1000,
  });
  const probeStatus = readProbeStatus(runTag, dateKey);
  return {
    videoId,
    dateKey,
    stdout: stdoutTail,
    stderr,
    status: status === 'TIMEOUT' ? -1 : (code === null ? -1 : code),
    timedOut: status === 'TIMEOUT',
    probeStatus,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main(argv) {
  const options = parseArgs(argv);
  console.log('Options:', JSON.stringify(options));

  // Discover videos via Python
  const pyOut = execSync('python tools/_discover_revere.py', {
    encoding: 'utf8', cwd: ROOT
  });
  const videos = JSON.parse(pyOut.trim());
  console.log(`Found ${videos.length} Revere videos`);

  const runTag = `revere-box-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

  // Build video list with actual file paths
  const videoList = [];
  for (const v of videos) {
    const videoFile = path.basename(v.download_path);
    const videoPath = path.join(VIDEO_DIR, videoFile);
    if (!fs.existsSync(videoPath)) {
      console.log(`SKIP ${v.upload_date} ${v.video_id}: not found`);
      continue;
    }
    videoList.push({ videoId: v.video_id, videoPath, dateKey: v.upload_date });
  }
  console.log(`Will scan ${videoList.length} videos`);

  const results = [];
  const queue = [...videoList];
  const running = [];

  while (queue.length > 0 || running.length > 0) {
    // Start new jobs while under parallel limit
    while (running.length < options.parallel && queue.length > 0) {
      const job = queue.shift();
      process.stdout.write(`\n[${results.length + running.length + 1}/${videoList.length}] ${job.dateKey} ${job.videoId}... `);
      const promise = runScan(job.videoId, job.videoPath, job.dateKey, runTag, options);
      running.push(promise);
      promise.then((r) => {
        const idx = running.indexOf(promise);
        if (idx >= 0) running.splice(idx, 1);
        // A scan counts as OK when the tool exited cleanly, or when its probe
        // log says it finished — the log is written before the tool's final
        // console.log, so a run that used to hang after writing its log
        // still counts as what it was: a successful scan.
        const ok = r.status === 0 || r.probeStatus === 'done';
        if (ok) {
          console.log(`OK`);
        } else if (r.timedOut) {
          console.log(`TIMEOUT`);
        } else {
          console.log(`FAIL status=${r.status}`);
        }
        results.push({ videoId: r.videoId, dateKey: r.dateKey, ok, status: r.status });
      });
    }
    if (running.length > 0) {
      await Promise.race(running);
    } else {
      break;
    }
  }

  // Wait for all running to finish
  if (running.length > 0) await Promise.all(running);

  const ok = results.filter(r => r.ok);
  console.log(`\n=== RESULTS: ${ok.length}/${results.length} OK ===`);

  const outFile = path.join(ROOT, 'data/revere_scan_summary.json');
  fs.writeFileSync(outFile, JSON.stringify({ runTag, options, results }, null, 2));
  console.log(`Saved to ${outFile}`);
}

main(process.argv.slice(2));
