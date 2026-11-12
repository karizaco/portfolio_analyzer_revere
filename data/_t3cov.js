const { DatabaseSync } = require('node:sqlite');
const { classifyT3liveVideo } = require('../src/t3live/contentFilter');
const db = new DatabaseSync('data/video_pipeline/state.sqlite', { readOnly: true });
const rows = db.prepare(`SELECT v.video_id, v.title, v.upload_date, t.provider FROM videos v LEFT JOIN video_transcripts t ON t.video_id=v.video_id WHERE v.channel='t3live'`).all();
const by = {};
for (const r of rows) { const s = classifyT3liveVideo(r.title).show; const b = by[s] ||= {n:0,dated:0,tr:0,dg:0}; b.n++; if (r.upload_date) b.dated++; if (r.provider) b.tr++; if (r.provider==='deepgram') b.dg++; }
console.table(by);
