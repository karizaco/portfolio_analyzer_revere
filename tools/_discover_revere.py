import sqlite3, os, json, sys

db_path = sys.argv[1] if len(sys.argv) > 1 else 'data/video_pipeline/state.sqlite'
limit = int(sys.argv[2]) if len(sys.argv) > 2 else None

db = sqlite3.connect(db_path)
cur = db.execute('''
  SELECT video_id, upload_date, title, download_path
  FROM videos
  WHERE channel = 'revere' AND download_path IS NOT NULL AND download_path != ''
  ORDER BY upload_date DESC
''')
rows = [
  dict(zip(['video_id', 'upload_date', 'title', 'download_path'], r))
  for r in cur.fetchall()
  if r[3] and os.path.exists(r[3])
]
db.close()
if limit:
  rows = rows[:limit]
print(json.dumps(rows))
