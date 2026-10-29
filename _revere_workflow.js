import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const meta = {
  name: 'revere-scan',
  description: 'Resume Revere OCR scanning',
  phases: [{ title: 'Find' }, { title: 'Scan' }],
}

// The repository root, so a pointer stored relative to it can be opened.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

log('Phase 1: Finding next video to scan...')

const py = `
import sqlite3, os, glob, json

DB = 'data/video_pipeline/state.sqlite'
LOG = 'data/video_ocr_probe/revere-ocr/ocr_probe/logs/'

conn = sqlite3.connect(DB)
cur = conn.execute("SELECT upload_date, video_id, download_path FROM videos WHERE channel='revere' AND download_path IS NOT NULL AND download_path != '' ORDER BY upload_date DESC")
rows = list(cur)
conn.close()

scanned = set(f[:8] for f in os.listdir(LOG) if f.startswith('202') and f.endswith('.json'))

next_videos = [(d,v,p) for d,v,p in rows if d not in scanned]
print(f'NEXT_COUNT={len(next_videos)}')
for d,v,p in next_videos[:20]:
    # The catalog stores paths relative to the repository root so they survive
    # being checked out on another machine.
    local = p if os.path.isabs(p) else os.path.join(os.getcwd(), p.replace('\\\\', '/'))
    exists = os.path.exists(local)
    print(f'{d}|{v}|{1 if exists else 0}|{local}')
`

const out = execSync(`python -c "${py.replace(/"/g, '\\"').replace(/\\n/g, ' ') \\"`, {encoding: 'utf8', cwd: repoRoot})
console.log(out)

const lines = out.trim().split('\n')
const nextCount = lines.find(l => l.startsWith('NEXT_COUNT='))
const videoLines = lines.filter(l => l.match(/^202\d{6}\|/))
const firstExists = videoLines.find(l => l.split('|')[2] === '1')

if (!firstExists) {
  log('No more videos to scan! All done.')
  return
}

const [date, vid, , ...pathParts] = firstExists.split('|')
const filePath = pathParts.join('|')
const filename = filePath.split('\\').pop()

log(`Phase 2: Scanning ${date} ${vid}...`)

const scanOut = execSync(
  `node tools/scanVideoWithOcr.js --video-dir "data/video_pipeline/downloads_hires/" --file "${filename}" --date "${date}" --prefilter-profile whiteboard --basename revere --output-kind whiteboard --max-captures 3 --fps 0.2 --prefilter-max-frames 10 --run-tag revere-ocr`,
  {encoding: 'utf8', maxBuffer: 50*1024*1024, cwd: repoRoot}
)
console.log(scanOut.slice(-500))

// Check result
const checkPy = `
import json, glob
logs = sorted(glob.glob('data/video_ocr_probe/revere-ocr/ocr_probe/logs/2026*.json'))
d = json.load(open(logs[-1], encoding='utf-8'))
ml = d.get('merged_position_list', [])
print('TICKERS', len(ml))
print('SAMPLE', json.dumps(ml[:10]))
`
const checkOut = execSync(`python -c "${checkPy.replace(/"/g, '\\"').replace(/\\n/g, ' ') \\"`, {encoding: 'utf8', cwd: repoRoot})
console.log(checkOut)

log('Done.')
