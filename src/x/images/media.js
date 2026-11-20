'use strict';

/**
 * Download the photos attached to archived posts.
 *
 *   data/x_pipeline/media/<user_id>/<post_id>_<n>.<ext>   (untracked)
 *
 * The images are evidence for position snapshots and chart setups, and they
 * are too large for git. What IS tracked is what was read off them
 * (x_image_readings / x_positions in derived.sqlite) plus each image's md5
 * in the index, so a reading always names the exact file it came from.
 *
 * pbs.twimg.com is X's public image CDN: no login, no API cost. The largest
 * rendition is `name=orig`; `name=large` is the fallback. Only photos are
 * downloaded -- a video's preview frame is metadata, not a screenshot.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_MEDIA_ROOT = path.join(ROOT, 'data', 'x_pipeline', 'media');
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The full-size URLs to try for a photo, best first.
 *
 * @param {string} url - https://pbs.twimg.com/media/<id>.<ext>
 * @returns {Array<{url: string, ext: string}>}
 */
function photoCandidates(url) {
  const match = /https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|webp))?/.exec(String(url || ''));
  if (!match) return [];
  const ext = (match[2] || 'jpg').replace('jpeg', 'jpg');
  return ['orig', 'large'].map((name) => ({ url: `https://pbs.twimg.com/media/${match[1]}?format=${ext}&name=${name}`, ext }));
}

function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return Infinity;
  }
}

/**
 * Download the account's pending photos.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.indexDb
 * @param {object} options.account
 * @param {number} [options.limit]
 * @param {string} [options.mediaRoot]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.sleep]
 * @param {Function} [options.log]
 * @returns {Promise<{ok: number, failed: number, skipped: number}>}
 */
async function downloadPhotos(options) {
  const {
    indexDb, account, limit = 500, log = () => {},
  } = options;
  const mediaRoot = options.mediaRoot || DEFAULT_MEDIA_ROOT;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!account.user_id) throw new Error(`@${account.handle} has no user id yet; crawl first`);

  const rows = indexDb.prepare(`SELECT m.post_id, m.media_key, m.idx, m.url FROM x_post_media m
      JOIN x_posts p ON p.post_id = m.post_id
     WHERE p.user_id = ? AND m.type = 'photo' AND m.download_status IN ('pending', 'failed')
     ORDER BY p.created_at DESC LIMIT ?`).all(account.user_id, limit);
  const update = indexDb.prepare(`UPDATE x_post_media SET local_path = ?, md5 = ?, bytes = ?, download_status = ?,
      download_detail = ?, downloaded_at = ? WHERE post_id = ? AND media_key = ?`);
  const result = { ok: 0, failed: 0, skipped: 0 };
  const dir = path.join(mediaRoot, String(account.user_id));

  for (const row of rows) {
    if (freeBytes(dir) < MIN_FREE_BYTES) {
      log('[x-media] less than 2 GB free; stopping before the disk fills');
      break;
    }
    const candidates = photoCandidates(row.url);
    if (!candidates.length) {
      update.run('', '', null, 'skipped', 'not a pbs.twimg.com photo url', new Date().toISOString(), row.post_id, row.media_key);
      result.skipped += 1;
      continue;
    }
    let saved = false;
    let detail = '';
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(candidate.url, { headers: { 'User-Agent': 'portfolio-analyzer-x/1' } });
        if (res.status !== 200) {
          detail = `HTTP ${res.status}`;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 100) {
          detail = `only ${buffer.length} bytes`;
          continue;
        }
        const md5 = crypto.createHash('md5').update(buffer).digest('hex');
        const file = path.join(dir, `${row.post_id}_${row.idx}.${candidate.ext}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, buffer);
        update.run(path.relative(ROOT, file).replace(/\\/g, '/'), md5, buffer.length, 'ok', candidate.url.split('&name=')[1] || '',
          new Date().toISOString(), row.post_id, row.media_key);
        saved = true;
        break;
      } catch (error) {
        detail = error.message;
      }
    }
    if (saved) result.ok += 1;
    else {
      result.failed += 1;
      update.run('', '', null, 'failed', detail.slice(0, 200), new Date().toISOString(), row.post_id, row.media_key);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(300 + Math.round(Math.random() * 600));
  }
  log(`[x-media] @${account.handle}: ${result.ok} downloaded, ${result.failed} failed, ${result.skipped} skipped`
    + ` (${rows.length} were pending)`);
  return result;
}

module.exports = { DEFAULT_MEDIA_ROOT, downloadPhotos, photoCandidates };
