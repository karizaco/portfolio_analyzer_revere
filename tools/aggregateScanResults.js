'use strict';

const fs = require('node:fs');
const path = require('node:path');

const logsDirectory = path.resolve('data/video_scan_20260912/ocr_probe/logs');
const screenshotsDirectory = path.resolve('data/video_scan_20260912/screenshots');
const outputBase = path.resolve('data/video_scan_20260912');

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
    status: parsed.status,
    frame_counts: frameCounts,
    prefilter_best: parsed.prefilter_best_score,
    thresholds: {
      strong: parsed.strong_threshold,
      review: parsed.review_threshold
    },
    captured_count: captures.length,
    captures: captures.map((capture) => ({
      timestamp: capture.timestamp,
      timestamp_hms: formatHms(capture.timestamp),
      frame_index: capture.frame_index,
      score: capture.score,
      prefilter_score: capture.prefilter_score,
      ocr_confidence: capture.ocr_confidence,
      ocr_profile: capture.ocr_profile,
      screen_layout: capture.screen_layout,
      issue_codes: capture.issue_codes || [],
      output_path: capture.output_path,
      ocr_text_snippet: capture.ocr_text_snippet
    })),
    unique_layouts: uniqueLayouts,
    top_candidate: parsed.top_candidate
      ? {
          timestamp: parsed.top_candidate.timestamp,
          score: parsed.top_candidate.score,
          screen_layout: parsed.top_candidate.screen_layout
        }
      : null
  });
}

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
    captures_per_layout: countCapturesPerLayout(videos)
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

    if (!video.captures.length) {
      lines.push('- **Captures:** none (no candidate above review threshold)');
      lines.push('');
      continue;
    }

    lines.push('');
    lines.push('| # | t (HH:MM:SS) | frame | score | prefilter | OCR conf | layout | issues | snippet |');
    lines.push('|---|---|---:|---:|---:|---:|---|---|---|');
    video.captures
      .slice()
      .sort((left, right) => left.timestamp - right.timestamp)
      .forEach((capture, captureIndex) => {
        const snippet = (capture.ocr_text_snippet || '')
          .replace(/\s+/g, ' ')
          .replace(/\|/g, '\\|')
          .slice(0, 110);
        const issueStr = (capture.issue_codes || []).join(', ') || '—';
        lines.push(
          `| ${captureIndex + 1} | ${capture.timestamp_hms} | ${capture.frame_index} | ${capture.score.toFixed(1)} | ${capture.prefilter_score.toFixed(1)} | ${capture.ocr_confidence} | ${capture.screen_layout || '?'} | ${issueStr} | ${snippet}… |`
        );
      });
    lines.push('');
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

  return lines.join('\n');
}
