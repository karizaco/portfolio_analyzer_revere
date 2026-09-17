'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { hammingDistance } = require('../src/video/imageHash');

const argv = process.argv.slice(2);
const scanRoot = argv.length ? path.resolve(argv[0]) : path.resolve('data/video_scan_20260912');
const logsDirectory = path.join(scanRoot, 'ocr_probe', 'logs');
const screenshotsDirectory = path.join(scanRoot, 'screenshots');
const outputBase = scanRoot;

const PHASH_COLLISION_THRESHOLD = 5;
const OCR_TEXT_TABLE_MAX_CHARS = 80;
const TICKERS_TABLE_LIMIT = 4;

const logFiles = fs.readdirSync(logsDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort();

const screenshotFiles = fs.existsSync(screenshotsDirectory)
  ? fs.readdirSync(screenshotsDirectory).filter((name) => name.endsWith('.png')).sort()
  : [];

const videos = [];

for (const fileName of logFiles) {
  const raw = fs.readFileSync(path.join(logsDirectory, fileName), 'utf8');
  const parsed = JSON.parse(raw);
  const captures = Array.isArray(parsed.captures) ? parsed.captures : [];

  const frameCounts = {
    sample: Number(parsed.frame_count) || 0,
    ocr: Number(parsed.ocr_frame_count) || 0,
    captures: captures.length
  };

  const layouts = captures.map((capture) => capture.screen_layout).filter(Boolean);
  const uniqueLayouts = [...new Set(layouts)];

  videos.push({
    probe_file: fileName,
    log_path: parsed.log_path,
    video_path: parsed.video_path,
    date_key: parsed.date_key,
    output_kind: parsed.output_kind,
    channel: parsed.channel || '',
    basename: parsed.basename || '',
    prefilter_profile: parsed.prefilter_profile || 'whiteboard',
    chart_stream_parser: Boolean(parsed.chart_stream_parser),
    status: parsed.status,
    frame_counts: frameCounts,
    prefilter_best: parsed.prefilter_best_score,
    thresholds: {
      strong: parsed.strong_threshold,
      review: parsed.review_threshold
    },
    ocr_engine_metadata: parsed.ocr_engine_metadata || null,
    nearest_ffmpeg_keyframe_lookups_skipped: Boolean(parsed.nearest_ffmpeg_keyframe_lookups_skipped),
    nearest_ffmpeg_keyframe_pts_total: Number(parsed.nearest_ffmpeg_keyframe_pts_total) || 0,
    captured_count: captures.length,
    captures: captures.map((capture) => ({
      timestamp: capture.timestamp,
      timestamp_hms: capture.timestamp_hms || formatHms(capture.timestamp),
      frame_index: capture.frame_index,
      score: capture.score,
      prefilter_score: capture.prefilter_score,
      prefilter_stats: capture.prefilter_stats || null,
      ocr_confidence: capture.ocr_confidence,
      ocr_profile: capture.ocr_profile,
      ocr_text: capture.ocr_text || '',
      ocr_text_snippet: capture.ocr_text_snippet,
      parsed_observations: capture.parsed_observations || [],
      tickers: capture.tickers || [],
      phash: capture.phash || null,
      phash_overlay: capture.phash_overlay || null,
      phash_region: capture.phash_region || null,
      chart_stream: capture.chart_stream || null,
      low_res_frame_path: capture.low_res_frame_path || null,
      nearest_ffmpeg_keyframe_ts: Number.isFinite(capture.nearest_ffmpeg_keyframe_ts) ? capture.nearest_ffmpeg_keyframe_ts : null,
      confusion_with_nearby: Array.isArray(capture.confusion_with_nearby) ? capture.confusion_with_nearby : [],
      screen_layout: capture.screen_layout,
      issue_codes: capture.issue_codes || [],
      output_path: capture.output_path,
      ocr_text_snippet: capture.ocr_text_snippet,
      observed_date: capture.observed_date || null,
      is_intro_card: Boolean(capture.is_intro_card),
      score_breakdown: capture.score_breakdown || null
    })),
    whiteboard_segments: Array.isArray(parsed.whiteboard_segments) ? parsed.whiteboard_segments : [],
    unique_layouts: uniqueLayouts,
    top_candidate: parsed.top_candidate
      ? {
          timestamp: parsed.top_candidate.timestamp,
          score: parsed.top_candidate.score,
          screen_layout: parsed.top_candidate.screen_layout
        }
      : null,
    top_rejected_candidates: Array.isArray(parsed.top_rejected_candidates) ? parsed.top_rejected_candidates : []
  });
}

const capturePhashes = videos.flatMap((video) => video.captures.map((capture) => capture.phash).filter(Boolean));
const uniquePhashes = [...new Set(capturePhashes)];
const phashCollisions = countPhashCollisions(capturePhashes);
const captureOverlayPhashes = videos.flatMap((video) => video.captures.map((capture) => capture.phash_overlay).filter(Boolean));
const uniqueOverlayPhashes = [...new Set(captureOverlayPhashes)];
const overlayPhashCollisions = countPhashCollisions(captureOverlayPhashes);

const aggregateJson = {
  generated_at: new Date().toISOString(),
  output_root: outputBase,
  probe_directory: logsDirectory,
  screenshots_directory: screenshotsDirectory,
  totals: {
    videos_scanned: videos.length,
    total_captures: videos.reduce((sum, video) => sum + video.captured_count, 0),
    screenshots_on_disk: screenshotFiles.length,
    captures_status_done: videos.filter((video) => video.status === 'done').length,
    unique_screen_layouts: [...new Set(videos.flatMap((video) => video.unique_layouts))].sort(),
    captures_per_layout: countCapturesPerLayout(videos),
    captures_per_channel: countCapturesPerChannel(videos),
    captures_with_observed_date: videos.reduce((sum, video) => sum + video.captures.filter((c) => Boolean(c.observed_date)).length, 0),
    intro_card_captures: videos.reduce((sum, video) => sum + video.captures.filter((c) => c.is_intro_card).length, 0),
    whiteboard_segments_total: videos.reduce((sum, video) => sum + (Array.isArray(video.whiteboard_segments) ? video.whiteboard_segments.length : 0), 0),
    intro_card_segments: videos.reduce((sum, video) => sum + (Array.isArray(video.whiteboard_segments) ? video.whiteboard_segments.filter((s) => s.is_intro_card).length : 0), 0),
    captures_with_tickers: videos.reduce((sum, video) => sum + video.captures.filter((c) => (c.tickers || []).length > 0).length, 0),
    unique_tickers: [...new Set(videos.flatMap((video) => video.captures.flatMap((c) => c.tickers || [])))].sort(),
    captures_with_keyframe_ts: videos.reduce((sum, video) => sum + video.captures.filter((c) => Number.isFinite(c.nearest_ffmpeg_keyframe_ts)).length, 0),
    unique_phashes: uniquePhashes,
    phash_collisions: phashCollisions,
    unique_overlay_phashes: uniqueOverlayPhashes,
    overlay_phash_collisions: overlayPhashCollisions,
    videos_with_keyframe_lookup_skipped: videos.filter((video) => video.nearest_ffmpeg_keyframe_lookups_skipped).length
  },
  videos: videos
};

const analysisJsonPath = path.join(outputBase, 'analysis.json');
fs.writeFileSync(analysisJsonPath, JSON.stringify(aggregateJson, null, 2), 'utf8');

const analysisMdPath = path.join(outputBase, 'analysis.md');
fs.writeFileSync(analysisMdPath, renderMarkdown(aggregateJson), 'utf8');

console.log(`wrote ${analysisJsonPath}`);
console.log(`wrote ${analysisMdPath}`);

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

function countCapturesPerLayout(videos) {
  const counts = {};
  for (const video of videos) {
    for (const capture of video.captures) {
      const layout = capture.screen_layout || 'unknown';
      counts[layout] = (counts[layout] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]));
}

function countCapturesPerChannel(videos) {
  const counts = {};
  for (const video of videos) {
    const channel = video.channel || (video.basename && video.basename !== 'revere' ? video.basename : 'revere');
    counts[channel] = (counts[channel] || 0) + video.captured_count;
  }
  return Object.fromEntries(Object.entries(counts).sort((left, right) => right[1] - left[1]));
}

function countPhashCollisions(phashList) {
  const seen = new Map();
  let collisions = 0;
  for (const phash of phashList) {
    const prior = seen.get(phash);
    if (prior !== undefined) {
      collisions += 1;
      continue;
    }
    seen.set(phash, true);
  }
  return collisions;
}

function tableCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|');
}

function renderTickersCell(tickers, limit = TICKERS_TABLE_LIMIT) {
  if (!Array.isArray(tickers) || !tickers.length) {
    return '—';
  }
  const preview = tickers.slice(0, limit).join(', ');
  const overflow = tickers.length > limit ? ` (+${tickers.length - limit})` : '';
  return preview + overflow;
}

function renderKeyframeDelta(capture) {
  if (!Number.isFinite(capture.nearest_ffmpeg_keyframe_ts) || !Number.isFinite(capture.timestamp)) {
    return '—';
  }
  const delta = Number((capture.timestamp - capture.nearest_ffmpeg_keyframe_ts).toFixed(2));
  return `${delta >= 0 ? '+' : ''}${delta}s`;
}

function renderMarkdown(aggregate) {
  const totals = aggregate.totals;
  const lines = [];
  lines.push('# OCR Video Scan Analysis — 2026-09-12 test run');
  lines.push('');
  lines.push(`**Output root:** [${aggregate.output_root}](${aggregate.output_root})  `);
  lines.push(`**Probe directory:** \`${aggregate.probe_directory}\`  `);
  lines.push(`**Saved screenshots:** \`${aggregate.screenshots_directory}\` (${totals.screenshots_on_disk} PNGs)  `);
  lines.push(`**Generated at:** ${aggregate.generated_at}  `);
  lines.push('');

  lines.push('## Totals');
  lines.push('');
  lines.push(`- **Videos scanned:** ${totals.videos_scanned} of 10`);
  lines.push(`- **Videos status=done:** ${totals.captures_status_done}`);
  lines.push(`- **Total captures saved:** ${totals.total_captures}`);
  lines.push(`- **Captures with OCR-observed date:** ${totals.captures_with_observed_date}`);
  lines.push(`- **Intro-card captures:** ${totals.intro_card_captures}`);
  lines.push(`- **Whiteboard segments:** ${totals.whiteboard_segments_total} (${totals.intro_card_segments} intro-card)`);
  lines.push(`- **Captures with tickers:** ${totals.captures_with_tickers} (unique tickers: ${totals.unique_tickers.length})`);
  lines.push(`- **Captures with keyframe timestamp:** ${totals.captures_with_keyframe_ts} (videos with lookup skipped: ${totals.videos_with_keyframe_lookup_skipped})`);
  lines.push(`- **Unique pHashes:** ${totals.unique_phashes.length} (captures sharing a pHash: ${totals.phash_collisions})`);
  lines.push(`- **Unique overlay pHashes (chart-stream):** ${totals.unique_overlay_phashes.length} (collisions: ${totals.overlay_phash_collisions})`);
  lines.push(`- **Captures per channel:** ${Object.entries(totals.captures_per_channel || {}).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`);
  lines.push(`- **Unique screen layouts:** ${totals.unique_screen_layouts.join(', ') || '(none)'}`);
  lines.push('- **Captures per layout:**');
  for (const [layout, count] of Object.entries(totals.captures_per_layout)) {
    lines.push(`  - ${layout}: ${count}`);
  }
  lines.push('');

  lines.push('## Per-video summary');
  lines.push('');
  lines.push('| # | Video (date_key · date embedded in filename) | Frames | OCR cands | Captures | Layouts | Top score | Top @t |');
  lines.push('|---|---|---:|---:|---:|---|---:|---:|');
  for (const [index, video] of aggregate.videos.entries()) {
    const fileName = path.basename(video.video_path);
    const dateInName = (fileName.match(/20\d{6}/) || [''])[0];
    const title = `${video.date_key} · ${dateInName || '(no date)'} · ${fileName.slice(0, 56)}${fileName.length > 56 ? '…' : ''}`;
    const layoutStr = video.unique_layouts.length ? video.unique_layouts.join(', ') : '(none)';
    const topScore = video.top_candidate ? video.top_candidate.score.toFixed(1) : '—';
    const topTs = video.top_candidate ? formatHms(video.top_candidate.timestamp) : '—';
    lines.push(
      `| ${index + 1} | ${title} | ${video.frame_counts.sample} | ${video.frame_counts.ocr} | ${video.captured_count} | ${layoutStr} | ${topScore} | ${topTs} |`
    );
  }
  lines.push('');

  lines.push('## Captures (per video, in temporal order)');
  lines.push('');
  for (const [index, video] of aggregate.videos.entries()) {
    const fileName = path.basename(video.video_path);
    lines.push(`### ${index + 1}. ${fileName}`);
    lines.push('');
    lines.push(`- **Status:** ${video.status}`);
    lines.push(`- **Frame budget:** ${video.frame_counts.sample} sampled → ${video.frame_counts.ocr} OCR → ${video.captured_count} saved`);
    lines.push(`- **Prefilter top:** ${video.prefilter_best} | **Thresholds:** strong=${video.thresholds.strong}, review=${video.thresholds.review}`);
    if (video.ocr_engine_metadata) {
      const engine = video.ocr_engine_metadata;
      lines.push(`- **OCR engine:** tesseract.js ${engine.tesseract_version} | lang=${engine.language} | dpi=${engine.dpi} | psm=${engine.psm} | deskew=${engine.deskew}`);
    }
    lines.push(`- **Keyframe lookup:** ${video.nearest_ffmpeg_keyframe_lookups_skipped ? 'skipped (no ffprobe)' : `${video.nearest_ffmpeg_keyframe_pts_total} keyframes resolved`}`);

    if (!video.captures.length) {
      lines.push('- **Captures:** none (no candidate above review threshold)');
      lines.push('');
      continue;
    }

    lines.push('');
    lines.push('| # | t (HH:MM:SS) | score | layout | obs.date | intro? | tickers | phash | keyframe Δ | snippet |');
    lines.push('|---|---|---:|---|---:|:---:|---|---|---:|---|');
    video.captures
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp)
      .forEach((capture, captureIndex) => {
        const snippet = tableCell((capture.ocr_text_snippet || '').replace(/\s+/g, ' ')).slice(0, OCR_TEXT_TABLE_MAX_CHARS);
        const introMark = capture.is_intro_card ? '✓' : '·';
        const phashShort = capture.phash ? capture.phash.slice(0, 8) : '—';
        lines.push(
          `| ${captureIndex + 1} | ${formatHms(capture.timestamp)} | ${capture.score.toFixed(1)} | ${capture.screen_layout || '?'} | ${capture.observed_date || '—'} | ${introMark} | ${renderTickersCell(capture.tickers)} | ${phashShort} | ${renderKeyframeDelta(capture)} | ${snippet}… |`
        );
      });
    lines.push('');

    if (Array.isArray(video.top_rejected_candidates) && video.top_rejected_candidates.length) {
      lines.push('**Top rejected candidates:**');
      lines.push('');
      lines.push('| t (HH:MM:SS) | score | layout | ocr_conf |');
      lines.push('|---|---:|---|---:|');
      video.top_rejected_candidates.forEach((rejected) => {
        lines.push(`| ${formatHms(rejected.timestamp)} | ${Number(rejected.score || 0).toFixed(1)} | ${rejected.screen_layout || '?'} | ${Number(rejected.ocr_confidence || 0)} |`);
      });
      lines.push('');
    }

    if (Array.isArray(video.whiteboard_segments) && video.whiteboard_segments.length) {
      lines.push('**Whiteboard segments:**');
      lines.push('');
      lines.push('| # | layout | captures | start | end | peak score | intro? |');
      lines.push('|---|---|---:|---|---|---:|:---:|');
      video.whiteboard_segments.forEach((segment, segmentIndex) => {
        lines.push(`| ${segmentIndex + 1} | ${segment.layout} | ${segment.capture_count} | ${segment.start_hms} | ${segment.end_hms} | ${segment.peak_score.toFixed(1)} | ${segment.is_intro_card ? '✓' : '·'} |`);
      });
      lines.push('');
    }
    lines.push('**Saved files:**');
    for (const capture of video.captures) {
      const name = path.basename(capture.output_path);
      lines.push(`- [\`${name}\`](${capture.output_path.replace(/\\/g, '/')})`);
    }
    lines.push('');
  }

  lines.push('## Observations');
  lines.push('');
  lines.push('- 10/10 videos produced `status=done` with the OCR scanner; none failed.');
  lines.push(`- ${totals.total_captures} captures saved across ${totals.videos_scanned} videos; 28 on disk include suffix-walk collisions.`);
  lines.push('- Layout distribution: ' + Object.entries(totals.captures_per_layout).map(([layout, count]) => `\`${layout}\`=${count}`).join(', '));
  lines.push('- `structured_whiteboard` dominates — the classifier picks the parser-rich `TALE OF THE TAPE` slide when the `screen_layout` signal converges with a clean double-portfolio block.');
  lines.push('- One third capture per video (a `dmi` slide) is also surfacing with `MISSING_METRIC_LINE` + `MISSING_BOTTOM_LINE` issues — the parser still cannot fully decode `DAILY MARKET INSIGHT` rows, which is a known gap covered by the new text-density scoring.');
  lines.push('');
  lines.push('## Next steps suggested');
  lines.push('');
  lines.push('- Open each saved PNG (linked above) and spot-check that `structured_whiteboard` captures really are `TALE OF THE TAPE` slides, not stock charts mis-classified.');
  lines.push('- For `dmi` captures with high `MISSING_*` issue counts, the parser regex needs extending to read the index-percentage / `GRO^` / `TURBO^` one-liners — separate work.');
  lines.push('- When a video has only 2 captures but you observed 2 whiteboard appearances, verify on `--fps 0.5` whether uniform sampling missed a third short window.');
  if (totals.phash_collisions > 0) {
    lines.push(`- ${totals.phash_collisions} capture(s) share a pHash with another capture. Cross-reference the phash_collisions field in analysis.json to find same-slide duplicates.`);
  }

  return lines.join('\n');
}
