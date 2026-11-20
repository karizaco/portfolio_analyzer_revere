'use strict';

/**
 * The ONE place where fetched posts enter the corpus.
 *
 * The API route, the scripted browser, the agent and a manual import of a
 * raw directory all end here, so merging, de-duplication, the reply policy
 * and storage are decided once. In order:
 *
 *   1. validate every canonical record (a malformed one is reported, never
 *      stored);
 *   2. keep only the account's OWN posts -- a timeline or a thread view also
 *      carries other people's posts -- and pin the account's user id
 *      (src/x/registry.js rule 1);
 *   3. apply the reply policy: own posts, own quotes, own thread replies;
 *      never a reply to somebody else, never a repost (the user's decision,
 *      2026-11-20);
 *   4. merge into the tracked archive (src/x/archive.js);
 *   5. mirror into the untracked index, with this capture's engagement
 *      numbers as one more observation.
 *
 * NOTHING IS EVER DELETED here. A post missing from a later crawl is not a
 * deleted post -- an incomplete window proves nothing.
 */

const { keepByPolicy, normalizeHandle, validatePostRecord } = require('./postRecord');
const { writeToArchive } = require('./archive');
const { addMetrics, upsertPost } = require('./indexStore');
const { getAccount, resolveUserId } = require('./registry');

/**
 * Import canonical records for one account.
 *
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.catalogDb
 * @param {import('node:sqlite').DatabaseSync} options.indexDb
 * @param {object} options.account - an x_accounts row
 * @param {Array<object>} options.records
 * @param {string} [options.archiveRoot]
 * @param {boolean} [options.dryRun]
 * @returns {{seen: number, invalid: Array<object>, otherUser: number, filtered: object,
 *            new: number, updated: number, unchanged: number, filesWritten: number,
 *            oldest: string, newest: string, kept: Array<object>}}
 */
function importRecords(options) {
  const { catalogDb, indexDb, records } = options;
  let account = getAccount(catalogDb, options.account.account_id);
  const policy = account.include_replies || 'self';
  const out = {
    seen: records.length,
    invalid: [],
    otherUser: 0,
    filtered: {},
    new: 0,
    updated: 0,
    unchanged: 0,
    filesWritten: 0,
    oldest: '',
    newest: '',
    kept: [],
  };

  const own = [];
  for (const record of records) {
    const check = validatePostRecord(record);
    if (!check.ok) {
      out.invalid.push({ post_id: record && record.post_id, errors: check.errors });
      continue;
    }
    if (!account.user_id && normalizeHandle(record.handle) === account.handle) {
      resolveUserId(catalogDb, account.account_id, record.user_id, record.handle);
      account = getAccount(catalogDb, account.account_id);
    }
    if (record.user_id !== account.user_id) {
      out.otherUser += 1;
      continue;
    }
    if (normalizeHandle(record.handle) !== account.handle) {
      // Same user id, new handle: a rename. Follow it.
      resolveUserId(catalogDb, account.account_id, record.user_id, record.handle);
      account = getAccount(catalogDb, account.account_id);
    }
    const verdict = keepByPolicy(record, policy);
    if (!verdict.keep) {
      out.filtered[verdict.reason] = (out.filtered[verdict.reason] || 0) + 1;
      continue;
    }
    own.push(record);
  }

  for (const record of own) {
    if (!out.oldest || record.created_at < out.oldest) out.oldest = record.created_at;
    if (!out.newest || record.created_at > out.newest) out.newest = record.created_at;
  }
  if (options.dryRun || !own.length) {
    out.kept = own;
    return out;
  }

  const stats = writeToArchive(own, { archiveRoot: options.archiveRoot });
  out.new = stats.postsNew;
  out.updated = stats.postsUpdated;
  out.unchanged = stats.postsUnchanged;
  out.filesWritten = stats.filesWritten;

  const incomingById = new Map(own.map((record) => [record.post_id, record]));
  indexDb.exec('BEGIN');
  try {
    for (const result of stats.results) {
      upsertPost(indexDb, result.record, { archivePath: result.archive_path });
      const incoming = incomingById.get(result.post_id);
      if (incoming && incoming.metrics_first_seen) {
        addMetrics(indexDb, result.post_id, incoming.metrics_first_seen, incoming.fetched_via);
      }
      out.kept.push(result.record);
    }
    indexDb.exec('COMMIT');
  } catch (error) {
    try { indexDb.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw error;
  }
  return out;
}

/**
 * The filtered counts as one number.
 *
 * @param {object} filtered
 * @returns {number}
 */
function filteredTotal(filtered) {
  return Object.values(filtered || {}).reduce((sum, n) => sum + n, 0);
}

module.exports = { filteredTotal, importRecords };
