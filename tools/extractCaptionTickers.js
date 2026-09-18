'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadSeedLexiconSync } = require('../src/normalize/tickerScan');
const { extractTickers } = require('../src/normalize/tickerExtraction');

const { tickers } = loadSeedLexiconSync();
const lexicon = new Set(tickers);
const transcriptsDir = path.resolve('data/video_pipeline/transcripts');
const dbPath = path.resolve('data/video_pipeline/state.sqlite');

const py = process.platform === 'win32' ? 'py' : 'python3';
const script = `
import json, sqlite3
conn = sqlite3.connect(r"${dbPath.replace(/\\/g, '/')}")
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT video_id, title FROM videos WHERE channel = 'qullamaggie' AND transcript_path != ''"
).fetchall()
print(json.dumps([dict(r) for r in rows]))
`;
const out = spawnSync(py, ['-3', '-c', script], { encoding: 'utf8' });
const videos = JSON.parse(out.stdout.trim());
const videoMap = Object.fromEntries(videos.map(v => [v.video_id, v.title]));

const allTickers = new Set();
const results = [];

for (const vid of Object.keys(videoMap)) {
  const jsonPath = path.join(transcriptsDir, vid + '.json');
  if (!fs.existsSync(jsonPath)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const segs = d.segments || [];
    const tickerCounts = {};
    for (const seg of segs) {
      for (const t of extractTickers(seg.text || '', lexicon)) {
        tickerCounts[t] = (tickerCounts[t] || 0) + 1;
        allTickers.add(t);
      }
    }
    const sorted = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1]);
    results.push({
      video_id: vid,
      title: videoMap[vid],
      transcript_segments: segs.length,
      ticker_counts: Object.fromEntries(sorted),
      unique_tickers: sorted.length
    });
  } catch (e) {
    console.error('Error:', vid, e.message);
  }
}

const output = {
  generated_at: new Date().toISOString(),
  source: 'qullamaggie_captions',
  videos_processed: results.length,
  total_unique_tickers: allTickers.size,
  all_tickers: [...allTickers].sort(),
  videos: results.sort((a, b) => b.unique_tickers - a.unique_tickers)
};

const outPath = path.resolve('data/video_pipeline/qmg_caption_tickers.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log('Written:', outPath);
console.log('Videos:', output.videos_processed, '| Tickers:', output.total_unique_tickers);
console.log('All tickers:', output.all_tickers.join(', '));
