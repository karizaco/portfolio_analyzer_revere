'use strict';

/**
 * Extract PREFILTER LABELS from the recorded probe logs.
 *
 * The prefilter decides WHICH FRAMES GET OCR'd. `tools/measurePrefilterRegion.js`
 * measures its ranking without OCR, but it needs a LABEL for each frame it
 * scores: the number of holdings that frame ACTUALLY READ. The probe logs
 * carry exactly that, per OCR'd candidate:
 *
 *   candidate.timestamp                 the timestamp in seconds
 *   candidate.chart_stream.position_list the tickers that frame read
 *
 * Selected captures are only one part of the candidate pool. The scan log also
 * keeps `top_candidates` and `top_rejected_candidates`; those frames were OCR'd
 * too, and are essential labels because a selected-captures-only set is biased
 * toward frames that already read holdings. The default source set is all three
 * (`captures,candidates,rejected`), and `--sources` can restrict it.
 *
 * so the label is `position_list.length`, and the measurement is
 * `--labels "ts:count,..."`.
 *
 * WHY THIS IS A SEPARATE TOOL
 *
 * The label set is the input to the wide measurement CLAUDE.md says is
 * required before shipping a higher prefilter resolution, and it is the input
 * to the re-tune of the scale-bound constants (`rowDensityTarget`,
 * `multiColStripeCountTarget`). Building it by hand from the logs would be
 * error-prone, and the set CHANGES as new production scans land — so it has to
 * be derivable, not transcribed.
 *
 * WHY THE TIMESTAMPS MATTER
 *
 * `measurePrefilterRegion.js` maps a label's timestamp back to a frame index
 * with `Math.round(ts * fps)`, where `fps` is the extraction rate (0.25). A
 * timestamp that is not on the extraction grid would silently point at the
 * WRONG frame, so this tool reports the grid alignment of every label it
 * finds and refuses to emit a misaligned one by default.
 *
 * Usage:
 *   node tools/extractPrefilterLabels.js                 # report only
 *   node tools/extractPrefilterLabels.js --json          # machine-readable
 *   node tools/extractPrefilterLabels.js --era 2022     # one era only
 *   node tools/extractPrefilterLabels.js --emit 20220418 --video <path>
 *
 * Options:
 *   --roots "<dir,dir>"  where to look for probe logs
 *   --era <2022|2023>    restrict to one layout era
 *   --date <YYYYMMDD>    restrict to one date
 *   --emit <YYYYMMDD>    print the --labels string for one date, and the
 *                        --video path if the log names one that exists
 *   --sources <list>     comma-separated captures,candidates,rejected sources
 *                        (default: all three)
 *   --allow-misaligned   emit labels whose timestamp is off the extraction grid
 *   --json               print JSON instead of a report
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_ROOTS = [
  path.join(ROOT, 'data', 'video_ocr_probe'),
  path.join(ROOT, 'data', 'video_scan_test', '_rerun')
];

// The extraction rate the scan tool samples at. A label's timestamp is on the
// grid when `ts * fps` is (close to) an integer.
const SAMPLE_FPS = 0.25;

// The era boundary. Before this the position list was a floating panel in the
// bottom-right corner; from this date it was docked to the right edge. The two
// layouts do not share a column, so they must be measured separately.
// See src/video/chartStreamCrop.js.
const RIGHT_SIDEBAR_FROM = '20230518';

const DOWNLOAD_DIRS = [
  path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p'),
  path.join(ROOT, 'data', 'video_pipeline', 'downloads_hires')
];

// The three places a chart-stream scan log records an OCR reading. `captures`
// are the selected captures; `candidates` is the top of the prefilter's OCR'd
// candidate pool; `rejected` is the near-miss tail the scan retained for
// diagnostics. The latter two are what make zero-holding labels available.
const LABEL_SOURCES = ['captures', 'candidates', 'rejected'];
const DEFAULT_SOURCES = LABEL_SOURCES.slice();

function normalizeSources(value) {
  if (value === undefined || value === null) return DEFAULT_SOURCES.slice();
  const requested = Array.isArray(value) ? value : String(value).split(',');
  const wanted = new Set(requested.map((source) => String(source).trim().toLowerCase()));
  // Keep a canonical order so merged source names and JSON are deterministic,
  // even when the command-line list uses a different order.
  return LABEL_SOURCES.filter((source) => wanted.has(source));
}

function parseArgs(argv) {
  const args = {
    roots: DEFAULT_ROOTS.slice(),
    era: null,
    date: null,
    emit: null,
    sources: DEFAULT_SOURCES.slice(),
    allowMisaligned: false,
    json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--roots') {
      args.roots = String(argv[++i] || '').split(',').map((s) => path.resolve(ROOT, s.trim())).filter(Boolean);
    } else if (a === '--era') args.era = String(argv[++i] || '').trim();
    else if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--emit') args.emit = String(argv[++i] || '').trim();
    else if (a === '--sources') args.sources = normalizeSources(argv[++i]);
    else if (a === '--allow-misaligned') args.allowMisaligned = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(require('node:fs').readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    }
  }
  return args;
}

function eraFor(dateKey) {
  return dateKey >= RIGHT_SIDEBAR_FROM ? '2023' : '2022';
}

// Every probe log under the roots. The file name ends in `_snapshot.json`;
// the run tag is the directory two levels up from the logs directory, so the
// same date scanned by two run tags is TWO logs of the SAME date — the date is
// the unit, not the log.
function collectLogs(roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('_snapshot.json')) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

function dateOf(file, log) {
  if (log && typeof log.date_key === 'string' && /^\d{8}$/.test(log.date_key)) return log.date_key;
  if (log && typeof log.date === 'string' && /^\d{8}$/.test(log.date)) return log.date;
  const match = path.basename(file).match(/(\d{8})/);
  return match ? match[1] : null;
}

// The number of holdings a capture ACTUALLY READ.
//
// A chart_stream capture's holdings live in `chart_stream.position_list` —
// that is the field the aggregator reads (src/video/captureTickers.js). A
// capture with no chart_stream block read nothing.
function holdingsOf(capture) {
  const chart = capture && capture.chart_stream;
  if (!chart) return 0;
  const list = chart.position_list;
  return Array.isArray(list) ? list.length : 0;
}

function timestampOf(record) {
  if (record && Number.isFinite(record.timestamp)) return record.timestamp;
  const stats = record && record.prefilter_stats;
  return stats && Number.isFinite(stats.timestamp) ? stats.timestamp : null;
}

// Return the log fields belonging to one source. `top_candidate` is included
// because some older logs expose only that singular summary; newer logs also
// put it in `top_candidates`, and the later (timestamp, holdings) collapse
// removes that duplicate without losing its provenance.
function recordsForSource(log, source) {
  if (source === 'captures') return Array.isArray(log.captures) ? log.captures : [];
  if (source === 'candidates') {
    return [
      ...(log.top_candidate ? [log.top_candidate] : []),
      ...(Array.isArray(log.top_candidates) ? log.top_candidates : [])
    ];
  }
  if (source === 'rejected') {
    return Array.isArray(log.top_rejected_candidates) ? log.top_rejected_candidates : [];
  }
  return [];
}

// Is this timestamp on the extraction grid the measurement will use?
//
// The measurement addresses a frame by `Math.round(ts * fps)`. The frame that
// actually CONTAINS ts is at `Math.floor(ts * fps)`. The two agree exactly
// when the fractional part of `ts * fps` is below one half — and then the
// label describes the frame the tool will score.
//
// When they disagree the label is ONE FRAME OUT. That is not a rounding
// quibble: at 0.25 fps a frame spans four seconds, so a label that lands in
// the wrong frame attributes a reading to the wrong picture.
//
// The disagreement comes from the scan tool's BATCH-SNAPSHOT mode, which
// picks frames around the prefilter's best frame by a clock that is not the
// extraction grid. Those logs' timestamps are off-grid and their labels
// cannot be used — which is exactly what this check is for.
function gridAlignment(timestamp) {
  const exact = timestamp * SAMPLE_FPS;
  const index = Math.round(exact);
  const containing = Math.floor(exact);
  return {
    index,
    containing_index: containing,
    fractional: exact - containing,
    aligned: containing === index
  };
}

// The media a log scanned, resolved against what is on disk. A log records an
// ABSOLUTE path from the machine that ran it; the file may have moved, or the
// machine may not be this one. So the log's own name is matched against the
// download directories, which is the same "two questions" rule the rest of
// the project uses (src/video/downloadCandidates.js).
// Resolve the media a log actually names before falling back to an own-name
// search. A date prefix alone is NOT enough when one date has several videos
// (20220606 does): returning the first alphabetical file would attach labels
// from one upload to another upload's frames.
function resolveMediaOnDisk(log, dateKey) {
  const recorded = log && typeof log.video_path === 'string' ? log.video_path : '';
  const recordedName = recorded ? path.basename(recorded) : '';
  const entries = [];
  for (const dir of DOWNLOAD_DIRS) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name.endsWith('.mp4')) entries.push({ dir, name });
    }
  }

  if (recordedName) {
    const exact = entries.find((entry) => entry.name.toLowerCase() === recordedName.toLowerCase());
    if (exact) return path.join(exact.dir, exact.name);

    // A catalog/download migration may have changed only the date prefix or
    // directory. Match the recorded id against today's own-name convention,
    // but still refuse an ambiguous result.
    const recordedStem = path.parse(recordedName).name.toLowerCase();
    const datePrefix = dateKey ? `${dateKey.toLowerCase()}_` : '';
    const recordedId = datePrefix && recordedStem.startsWith(datePrefix)
      ? recordedStem.slice(datePrefix.length)
      : recordedStem;
    const idMatches = entries.filter((entry) => {
      const stem = path.parse(entry.name).name.toLowerCase();
      return stem === recordedId
        || stem.endsWith(`_${recordedId}`)
        || stem.endsWith(`-${recordedId}`);
    });
    if (idMatches.length === 1) {
      return path.join(idMatches[0].dir, idMatches[0].name);
    }
  }

  // With no usable video id, a date-only fallback is honest only when it
  // identifies exactly one completed media file.
  if (dateKey) {
    const dateMatches = entries.filter((entry) => entry.name.startsWith(`${dateKey}_`));
    if (dateMatches.length === 1) {
      return path.join(dateMatches[0].dir, dateMatches[0].name);
    }
  }
  return null;
}

function collect(args = {}) {
  args = {
    ...args,
    roots: args.roots || DEFAULT_ROOTS,
    sources: normalizeSources(args.sources)
  };
  const files = collectLogs(args.roots);
  // date -> { era, labels: [{ts, holdings, source, aligned, index, runTag}], videos: Set }
  const byDate = new Map();

  for (const file of files) {
    let log;
    try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const dateKey = dateOf(file, log);
    if (!dateKey) continue;
    if (args.date && dateKey !== args.date) continue;
    const era = eraFor(dateKey);
    if (args.era && era !== args.era) continue;

    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, { date: dateKey, era, labels: [], videos: new Set(), logs: [] });
    }
    const entry = byDate.get(dateKey);

    // The run tag is the directory above `ocr_probe/logs`.
    const parts = path.dirname(path.dirname(path.dirname(file))).split(path.sep);
    const runTag = parts[parts.length - 1] || '(unknown)';
    entry.logs.push({ runTag, file: path.relative(ROOT, file) });

    const media = resolveMediaOnDisk(log, dateKey);
    if (media) entry.videos.add(media);

    for (const source of normalizeSources(args.sources)) {
      for (const record of recordsForSource(log, source)) {
        const timestamp = timestampOf(record);
        if (!Number.isFinite(timestamp)) continue;
        const holdings = holdingsOf(record);
        const align = gridAlignment(timestamp);
        entry.labels.push({
          ts: timestamp,
          holdings,
          source,
          aligned: align.aligned,
          index: align.index,
          runTag,
          video: media,
          // A frame that read nothing is still a LABEL — it is the frame the
          // prefilter must NOT pick, and it is the harder half of the
          // comparison. The 2026-11-02 measurement's inversion was exactly
          // this: the zero-holding frame ranked FIRST.
          empty: holdings === 0
        });
      }
    }
  }

  // Collapse to one label per (video, timestamp, holdings) tuple per date:
  // the same frame can be present in several source fields and run tags, but
  // two uploads on one date may legitimately use the same timestamp.
  const dates = [];
  for (const entry of byDate.values()) {
    const seen = new Map();
    for (const label of entry.labels) {
      const key = `${label.video || ''}|${label.ts}|${label.holdings}`;
      const prior = seen.get(key);
      if (prior) {
        if (!prior.runTags.includes(label.runTag)) prior.runTags.push(label.runTag);
        if (!prior.sources.includes(label.source)) prior.sources.push(label.source);
        prior.sources = LABEL_SOURCES.filter((source) => prior.sources.includes(source));
        prior.source = prior.sources.join('+');
        continue;
      }
      seen.set(key, { ...label, source: label.source, sources: [label.source], runTags: [label.runTag] });
    }
    const labels = [...seen.values()].sort((a, b) => a.ts - b.ts);
    dates.push({
      date: entry.date,
      era: entry.era,
      labels,
      alignedLabels: labels.filter((l) => l.aligned),
      videos: [...entry.videos].sort(),
      logs: entry.logs
    });
  }
  dates.sort((a, b) => a.date.localeCompare(b.date));
  return dates;
}

function labelsString(date, { allowMisaligned }) {
  const usable = allowMisaligned ? date.labels : date.alignedLabels;
  return usable
    .map((l) => `${Math.round(l.ts)}:${l.holdings}`)
    .join(',');
}

function report(dates, args) {
  const byEra = { 2022: { dates: 0, labels: 0, aligned: 0, withMedia: 0 }, 2023: { dates: 0, labels: 0, aligned: 0, withMedia: 0 } };
  for (const date of dates) {
    const bucket = byEra[date.era];
    bucket.dates += 1;
    bucket.labels += date.labels.length;
    bucket.aligned += date.alignedLabels.length;
    if (date.videos.length) bucket.withMedia += 1;
  }

  console.log('=== the label set ===\n');
  console.log(`sources: ${args.sources.join(',') || '(none)'}`);
  console.log('date       era  labels  aligned  empty  media on disk   labels string');
  console.log('-'.repeat(96));
  for (const date of dates) {
    const empty = date.labels.filter((l) => l.empty).length;
    console.log(
      date.date.padEnd(11)
      + date.era.padEnd(4)
      + String(date.labels.length).padStart(6)
      + String(date.alignedLabels.length).padStart(9)
      + String(empty).padStart(7)
      + `  ${date.videos.length ? path.basename(date.videos[0]) : 'NONE'}`.padEnd(38)
      + labelsString(date, { allowMisaligned: args.allowMisaligned }).slice(0, 40)
    );
  }

  console.log('\n=== per era ===\n');
  for (const era of ['2022', '2023']) {
    const b = byEra[era];
    console.log(
      `  ${era}-era: ${b.dates} date(s), ${b.labels} label(s), ${b.aligned} on the ` +
      `${SAMPLE_FPS} fps extraction grid, ${b.withMedia} with media on disk`
    );
  }

  // The measurement is only meaningful on grid-aligned labels, so this is the
  // number that decides whether the wide measurement can run at all.
  const usable = dates.filter((d) => d.alignedLabels.length > 0);
  console.log(`\n  dates with at least one grid-aligned label: ${usable.length}/${dates.length}`);
  console.log(`  dates with media on disk:                   ${dates.filter((d) => d.videos.length).length}/${dates.length}`);
  console.log(`  dates with BOTH (immediately measurable):    ${dates.filter((d) => d.alignedLabels.length && d.videos.length).length}`);

  if (args.emit) {
    const date = dates.find((d) => d.date === args.emit);
    if (!date) {
      console.log(`\nno log found for ${args.emit}`);
      process.exit(1);
    }
    console.log(`\n=== ${args.emit} ===`);
    console.log(`labels : ${labelsString(date, { allowMisaligned: args.allowMisaligned })}`);
    if (date.videos.length) console.log(`video  : ${date.videos[0]}`);
    else console.log('video  : NONE on disk');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dates = collect(args);
  if (args.json) {
    console.log(JSON.stringify({
      sample_fps: SAMPLE_FPS,
      right_sidebar_from: RIGHT_SIDEBAR_FROM,
      sources: args.sources,
      dates: dates.map((d) => ({
        date: d.date,
        era: d.era,
        labels: d.labels.map((l) => ({
          ts: l.ts,
          holdings: l.holdings,
          source: l.source,
          sources: l.sources,
          video: l.video,
          aligned: l.aligned
        })),
        videos: d.videos
      }))
    }, null, 2));
    return;
  }
  report(dates, args);
}

// The module is required by `tools/sweepPrefilterResolution.js`, so the CLI
// only runs when this file IS the entry point.
if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_ROOTS,
  DOWNLOAD_DIRS,
  DEFAULT_SOURCES,
  LABEL_SOURCES,
  RIGHT_SIDEBAR_FROM,
  SAMPLE_FPS,
  collect,
  collectLogs,
  dateOf,
  eraFor,
  gridAlignment,
  holdingsOf,
  labelsString,
  normalizeSources,
  parseArgs,
  recordsForSource,
  resolveMediaOnDisk,
  timestampOf
};
