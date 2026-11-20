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
 * Learn the account's identity from a batch of records.
 *
 * THE FAULT THIS FIXES
 *
 * The user id was learned ONLY from a record whose handle matched the
 * account's registered handle. A renamed account therefore never learned
 * its user id at all: every record was rejected as "another user's", and
 * the account stayed unidentified FOREVER -- a total, silent loss of the
 * first capture of every renamed account.
 *
 * So the identity is learned from the batch, and the rule is:
 *
 *   - a record whose handle matches the account's is the account's;
 *   - otherwise the account has been RENAMED, and the identity is
 *     whatever user id the capture is UNANIMOUS about. A capture with more
 *     than one user id is ambiguous, and an ambiguous capture is REPORTED,
 *     never guessed -- guessing here would merge two people's posts.
 *
 * @param {import('node:sqlite').DatabaseSync} catalogDb
 * @param {object} account - an x_accounts row
 * @param {Array<object>} records - the canonical records of the batch
 * @returns {{account: object, error: string}}
 */
function learnIdentity(catalogDb, account, records) {
  if (account.user_id) return { account, error: '' };
  const matching = records.filter((record) => normalizeHandle(record.handle) === account.handle);
  const candidate = matching.length ? matching[0] : records[0];
  if (!candidate) return { account, error: '' };
  const ids = new Set(records.map((record) => record.user_id));
  if (!matching.length && ids.size > 1) {
    return {
      account,
      error: `the capture carries ${ids.size} different user ids and none of them is the registered handle `
        + `@${account.handle}, so the account's identity cannot be learned from it`,
    };
  }
  try {
    resolveUserId(catalogDb, account.account_id, candidate.user_id, candidate.handle);
  } catch (error) {
    return { account, error: error.message };
  }
  return { account: getAccount(catalogDb, account.account_id), error: '' };
}

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
 *            oldest: string, newest: string, kept: Array<object>, identityError: string}}
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
    identityError: '',
  };

  // The identity is learned ONCE, from the batch as a whole.
  const identity = learnIdentity(catalogDb, account, records);
  account = identity.account;
  out.identityError = identity.error;

  const own = [];
  for (const record of records) {
    // A post whose AUTHOR is missing -- a deleted or suspended author, so
    // the capture carries no handle -- would be invalid, and a post is
    // never lost over a field the capture could not carry. The account's
    // own handle is the right one: the user id is what identifies the
    // author, and it is what the record is checked against.
    const candidate = (!record.handle && record.user_id && record.user_id === account.user_id && account.handle)
      ? { ...record, handle: account.handle }
      : record;
    const check = validatePostRecord(candidate);
    if (!check.ok) {
      out.invalid.push({ post_id: candidate && candidate.post_id, errors: check.errors });
      continue;
    }
    if (candidate.user_id !== account.user_id) {
      out.otherUser += 1;
      continue;
    }
    if (normalizeHandle(candidate.handle) !== account.handle) {
      // Same user id, new handle: a rename. Follow it.
      try {
        resolveUserId(catalogDb, account.account_id, candidate.user_id, candidate.handle);
        account = getAccount(catalogDb, account.account_id);
      } catch (error) {
        // A conflict (the new handle belongs to another account) is a
        // REJECTION of this record, not a fatal error that aborts the page.
        out.invalid.push({ post_id: candidate.post_id, errors: [error.message] });
        continue;
      }
    }
    const verdict = keepByPolicy(candidate, policy);
    if (!verdict.keep) {
      out.filtered[verdict.reason] = (out.filtered[verdict.reason] || 0) + 1;
      continue;
    }
    own.push(candidate);
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

module.exports = { filteredTotal, importRecords, learnIdentity };
