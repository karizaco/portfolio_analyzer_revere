const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/video_pipeline/state.sqlite', { readOnly: true });
const rows = db.prepare(`SELECT t.video_id, t.provider, t.segment_count FROM video_transcripts t JOIN videos v ON v.video_id=t.video_id WHERE v.channel='t3live' AND t.provider='deepgram'`).all();
console.log('deepgram rows:', rows.length, 'segments:', rows.reduce((a,r)=>a+(r.segment_count||0),0));
const all = db.prepare(`SELECT provider, COUNT(*) c FROM video_transcripts GROUP BY provider`).all(); console.table(all);
