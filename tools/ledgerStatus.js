'use strict';

/**
 * Tally the re-download progress against `data/_lost_videos_ledger.json`.
 *
 * The ledger is the authoritative list of the 718 videos destroyed on
 * 2026-10-21. This script reports, per scope, how many are recovered (their
 * SQLite `download_path` now points inside the out-of-tree media root) and
 * which are still lost.
 *
 * Usage:
 *   node tools/ledgerStatus.js
 *   node tools/ledgerStatus.js --next-ids 30     # also print the next N lost ids
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT = path.resolve(__dirname, '..');
const MEDIA_ROOT = readFlag('--media-root')
  || 'C:/Users/Admin/Projects/portfolio_analyzer_revere_media';
const LEDGER = path.join(PROJECT, 'data', '_lost_videos_ledger.json');
const DB = path.join(PROJECT, 'data', 'video_pipeline', 'state.sqlite');
const PY = process.platform === 'win32' ? 'py' : 'python3';

// The hardcoded 39 IDs that genuinely have no 1080p upload on YouTube.
const KNOWN_720P_ONLY = new Set(
  ('0Ew3DImAZlw,1QtMVbPrKUw,1X0J9XbF7I4,3328puCDrks,3w5BmkbsJpo,' +
   '4UWLcS4-lbI,6XgAT5LW9Ks,8uyENUhiW1c,AAs9-ZO33eA,A_0Sj3Hi9Jw,' +
   'Ab6bXsSfweo,Ax5a_ouJMKU,B1TCCDizExQ,BqGwSzbGS10,D4pnSkaFVb8,' +
   'FN20YOH_XRM,FcXJZ3Y98YU,MFew0xR3iv0,MSVE_HaH0qo,NDCSRLjr1-g,' +
   'Nlc2r-uz6Gg,O333thFuU40,PvL5_kwE0fI,R7nACKgTydc,SZ0QELUoCJ4,' +
   'SrIGW4fvzFE,UG1vfP9hCH0,UmAdr1cM3RY,V5ETDZgbnOs,gqzntxo4DdI,' +
   'jtyYLDlgdbE,l2olCkDuHGo,n8SWEpUNylE,o3IoaGLCxz4,oRX7YeTLdRg,' +
   'pomzmadhQV0,sUU3mKLgok,ttKgeB-cZbY,u84s3-ehrw4').split(',')
);

function readFlag(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1];
}

function catalog() {
  const script = `
import sqlite3, json, sys
c = sqlite3.connect(r"${DB.replace(/\\/g, '/')}")
c.row_factory = sqlite3.Row
rows = c.execute("SELECT video_id, channel, upload_date, download_path FROM videos").fetchall()
json.dump([dict(r) for r in rows], sys.stdout)
`;
  const r = spawnSync(PY, ['-3', '-c', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

const norm = (p) => String(p || '').split('\\').join('/').toLowerCase();
const rootNorm = norm(MEDIA_ROOT);

const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const rows = catalog();
const byId = new Map(rows.map((r) => [r.video_id, r]));

const scopes = {
  'qmg-1080p': { channel: 'qullamaggie', lost: [], recovered: 0 },
  'qmg-720p-scope': { channel: 'qullamaggie', lost: [], recovered: 0 },
  'qmg-known-720p-only': { channel: 'qullamaggie', lost: [], recovered: 0 },
  'revere-720p-scope': { channel: 'revere', lost: [], recovered: 0 },
};

for (const entry of ledger) {
  const row = byId.get(entry.video_id);
  if (!row) {
    console.error('WARNING: ledger id not in the live catalog: ' + entry.video_id);
    continue;
  }
  let key;
  if (KNOWN_720P_ONLY.has(entry.video_id)) key = 'qmg-known-720p-only';
  else if (entry.scope === '720p' && row.channel === 'revere') key = 'revere-720p-scope';
  else if (entry.scope === '720p') key = 'qmg-720p-scope';
  else key = 'qmg-1080p';

  const p = norm(row.download_path);
  if (p.startsWith(rootNorm)) scopes[key].recovered += 1;
  else scopes[key].lost.push(entry.video_id);
}

let totalLost = 0;
let totalRecovered = 0;
console.log('scope                  recovered   lost');
console.log('------------------------------------------------');
for (const [key, s] of Object.entries(scopes)) {
  totalLost += s.lost.length;
  totalRecovered += s.recovered;
  console.log(key.padEnd(22) + String(s.recovered).padStart(6) + String(s.lost.length).padStart(8));
}
console.log('------------------------------------------------');
console.log('TOTAL'.padEnd(22) + String(totalRecovered).padStart(6) + String(totalLost).padStart(8));
console.log('ledger size: ' + ledger.length + '   recovered: ' + totalRecovered +
  '   still lost: ' + totalLost);

const next = Number(readFlag('--next-ids')) || 0;
if (next) {
  for (const key of ['qmg-1080p', 'qmg-720p-scope', 'revere-720p-scope']) {
    console.log('\nnext ' + next + ' from ' + key + ':');
    console.log(scopes[key].lost.slice(0, next).join(','));
  }
}
