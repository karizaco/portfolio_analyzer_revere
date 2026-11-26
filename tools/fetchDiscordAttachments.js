'use strict';

/**
 * Download the attachments of a Discord source's messages.
 *
 * WHY THIS EXISTS
 *
 * The position ANNOUNCEMENTS of plechac are broker screenshots: the XTB
 * "POZICE" table and the portfolio treemaps, posted in the portfolio
 * channel. The message is the record of WHERE they were posted; the image
 * is the record of WHAT they said. Both are needed, and the image has to
 * be kept, because an interpretation of it can be rebuilt and an image
 * cannot.
 *
 * The images go under `data/discord_pipeline/media/<source>/<message_id>/`
 * with the attachment's own file name, and the row that ties an image to
 * the message it came from is in `discord_attachments` -- a table of its
 * own, because no other table in this project holds one.
 *
 *   node tools/fetchDiscordAttachments.js --source plechac-portfolia
 *   node tools/fetchDiscordAttachments.js --source plechac-portfolia --dry-run
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

const dryRun = process.argv.includes('--dry-run');
const sourceFlag = process.argv.indexOf('--source');
const sourceName = sourceFlag >= 0 ? process.argv[sourceFlag + 1] : '';

/**
 * Download one URL to a file.
 *
 * @param {string} url
 * @param {string} target
 * @returns {Promise<number>} the bytes written
 */
function download(url, target) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        resolve(buffer.length);
      });
    });
    request.on('error', reject);
  });
}

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  if (!sourceName) {
    console.error('Usage: node tools/fetchDiscordAttachments.js --source <name> [--dry-run]');
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 60000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      discord_message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT '',
      width INTEGER,
      height INTEGER,
      byte_size INTEGER,
      url TEXT NOT NULL,
      local_path TEXT NOT NULL,
      sha256 TEXT NOT NULL DEFAULT '',
      downloaded_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_name, attachment_id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_discord_attachments_message ON discord_attachments(message_id)');

  const source = db.prepare('SELECT id, name FROM discord_sources WHERE name = ?').get(sourceName);
  if (!source) {
    console.error(`source ${sourceName} is not registered`);
    process.exit(1);
  }

  const messages = db.prepare(
    'SELECT id, discord_message_id, raw_json, posted_at FROM discord_messages WHERE source_id = ? ORDER BY posted_at',
  ).all(source.id);

  const rows = [];
  for (const message of messages) {
    let attachments = [];
    try {
      attachments = JSON.parse(message.raw_json || '{}').attachments || [];
    } catch {
      attachments = [];
    }
    for (const attachment of attachments) {
      if (!attachment || !attachment.id || !attachment.url) continue;
      const ext = path.extname(attachment.filename || '') || '.png';
      const relative = path.join(
        'data', 'discord_pipeline', 'media', sourceName, String(message.id), `${attachment.id}${ext}`,
      );
      rows.push({
        source_name: sourceName,
        message_id: message.id,
        discord_message_id: message.discord_message_id,
        attachment_id: attachment.id,
        file_name: attachment.filename || `${attachment.id}${ext}`,
        content_type: attachment.content_type || '',
        width: attachment.width || null,
        height: attachment.height || null,
        byte_size: attachment.size || null,
        url: attachment.url,
        local_path: relative.replace(/\\/g, '/'),
      });
    }
  }

  console.error(`${sourceName}: ${rows.length} attachment(s) in ${messages.length} message(s)`);
  const insert = db.prepare(`
    INSERT INTO discord_attachments
      (source_name, message_id, discord_message_id, attachment_id, file_name, content_type,
       width, height, byte_size, url, local_path, sha256, downloaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_name, attachment_id) DO UPDATE SET
      local_path = excluded.local_path, url = excluded.url, sha256 = excluded.sha256,
      downloaded_at = excluded.downloaded_at
  `);

  let downloaded = 0;
  let failed = 0;
  for (const row of rows) {
    const target = path.join(ROOT, row.local_path);
    let sha256 = '';
    if (!dryRun) {
      if (!fs.existsSync(target)) {
        try {
          await download(row.url, target);
          downloaded += 1;
        } catch (error) {
          failed += 1;
          console.error(`  download failed ${row.attachment_id}: ${error.message}`);
          continue;
        }
      }
      sha256 = sha256Of(target);
    }
    insert.run(
      row.source_name, row.message_id, row.discord_message_id, row.attachment_id,
      row.file_name, row.content_type, row.width, row.height, row.byte_size,
      row.url, row.local_path, sha256, new Date().toISOString(),
    );
  }
  db.close();
  console.error(`rows written: ${rows.length}, downloaded: ${downloaded}, failed: ${failed} (dry run: ${dryRun})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
