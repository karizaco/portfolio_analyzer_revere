#!/usr/bin/env node
'use strict';

// Resolve the upload dates of catalog rows that have none.
//
// WHY THIS EXISTS
//
// Some videos cannot be dated by yt-dlp. An age-restricted upload is refused
// before its metadata is read, so `fill-dates` leaves the row undated -- and
// undated rows fall out of every date-keyed layout the pipeline has. Three
// Qullamaggie rows were in that state on 2026-10-29.
//
// But the WATCH PAGE carries the date anyway. Its embedded JSON holds
//
//   "uploadDate":"2022-03-03T06:59:31-08:00"
//
// and YouTube serves it to a logged-out client even when the video itself is
// age-gated. Measured on 2026-10-29: the watch page agreed with the
// yt-dlp-resolved date for 12 of 12 Qullamaggie videos whose dates were
// already known.
//
// THE CROSS-CHECK
//
// A date read out of a web page is not trusted on its own. The channel listing
// is newest-first, so an undated video's date has to fall BETWEEN its dated
// neighbours -- and that bound comes from a completely different source. Two
// independent methods have to agree before a date is written. A date that
// falls outside the bound is reported, not written.
//
//   older < target <= newer
//
// where `newer` is the nearest dated video ABOVE the target in the listing
// and `older` the nearest dated video BELOW it.
//
// Usage:
//   node tools/resolveUndatedDates.js --listing data/catalog_flat/qullamaggie.tsv
//   node tools/resolveUndatedDates.js --listing ... --execute
//   node tools/resolveUndatedDates.js --json

const fs = require('node:fs');
const path = require('node:path');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');
const { toPortablePath } = require('../src/video/downloadCandidates');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');

/** The YouTube watch URL for a video id. */
function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The upload date out of a watch page's embedded JSON.
 *
 * @param {string} html - the page source
 * @returns {string|null} `YYYYMMDD`, or null if the page has no date
 */
function parseUploadDate(html) {
  if (!html) return null;
  const match = /"uploadDate"\s*:\s*"(\d{4})-(\d{2})-(\d{2})T/.exec(html);
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

/**
 * The video ids of a channel listing, in listing order.
 *
 * The separator may be a real tab or the two characters `\t` -- a shell
 * hands yt-dlp the backslash-t and yt-dlp prints it verbatim. The file may
 * also be cp1252 rather than UTF-8, because the listing passes through the
 * console codepage on Windows; reading it as latin1 maps every byte to
 * exactly one character, and the ids are ASCII, so nothing that matters is
 * lost.
 *
 * @param {string} text
 * @returns {string[]}
 */
function readListingIds(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  const literalTab = String.fromCharCode(92) + 't';
  return lines.map((line) => {
    const tab = line.indexOf('\t');
    const literal = line.indexOf(literalTab);
    let cut;
    if (tab !== -1 && (literal === -1 || tab < literal)) cut = tab;
    else if (literal !== -1) cut = literal;
    else cut = line.search(/\s/);
    return (cut === -1 ? line : line.slice(0, cut)).trim();
  }).filter(Boolean);
}

/**
 * The dates a video's neighbours in the listing allow.
 *
 * @param {string[]} listingIds - the listing's video ids, newest first
 * @param {Map<string,string>} knownDates - video id -> `YYYYMMDD`
 * @param {string} videoId
 * @returns {{newer: string|null, older: string|null}}
 */
function dateBounds(listingIds, knownDates, videoId) {
  const index = listingIds.indexOf(videoId);
  if (index === -1) return { newer: null, older: null };

  let newer = null;
  let older = null;
  for (let i = index - 1; i >= 0; i--) {
    const date = knownDates.get(listingIds[i]);
    if (date) { newer = date; break; }
  }
  for (let i = index + 1; i < listingIds.length; i++) {
    const date = knownDates.get(listingIds[i]);
    if (date) { older = date; break; }
  }
  return { newer, older };
}

/**
 * Does a date fall inside the bounds its neighbours allow?
 *
 * @param {string} date - `YYYYMMDD`
 * @param {{newer: string|null, older: string|null}} bounds
 * @returns {boolean}
 */
function withinBounds(date, bounds) {
  if (!date) return false;
  if (bounds.older && !(date > bounds.older)) return false;
  if (bounds.newer && !(date <= bounds.newer)) return false;
  return true;
}

/**
 * The rows of a catalog that have no upload date.
 *
 * @param {object} db - an open DatabaseSync
 * @returns {object[]}
 */
function undatedRows(db) {
  return db.prepare(
    "SELECT video_id, channel, upload_date, title, source_url FROM videos "
    + "WHERE COALESCE(upload_date, '') = '' OR upload_date = 'NA' "
    + "ORDER BY channel, video_id",
  ).all();
}

/**
 * Work out what to do about each undated row.
 *
 * @param {object[]} rows - the undated catalog rows
 * @param {object} [options]
 * @param {string[]} [options.listingIds] - the channel listing, newest first
 * @param {string} [options.listingChannel] - the channel the listing belongs to
 * @param {Map<string,string>} [options.knownDates] - video id -> `YYYYMMDD`
 * @param {(url: string) => Promise<string>} [options.fetchHtml]
 * @returns {Promise<object[]>} one plan per row
 */
async function planResolution(rows, options = {}) {
  const listingIds = options.listingIds || null;
  const listingChannel = options.listingChannel || null;
  const knownDates = options.knownDates || new Map();
  const fetchHtml = options.fetchHtml || defaultFetchHtml;

  const plans = [];
  for (const row of rows) {
    const plan = {
      video_id: row.video_id,
      channel: row.channel || '',
      title: row.title || '',
      date: null,
      bounds: { newer: null, older: null },
      inListing: false,
      accepted: false,
      reason: '',
    };

    if (listingIds) {
      plan.inListing = listingIds.includes(row.video_id);
      plan.bounds = dateBounds(listingIds, knownDates, row.video_id);
    }

    let html = null;
    try {
      html = await fetchHtml(watchUrl(row.video_id));
    } catch (err) {
      // One unreachable page must not abandon the rest of the run.
      plan.reason = `the watch page could not be fetched (${err && err.message ? err.message : err})`;
      plans.push(plan);
      continue;
    }
    plan.date = parseUploadDate(html);

    if (!plan.date) {
      plan.reason = 'the watch page carried no upload date';
      plans.push(plan);
      continue;
    }
    if (!listingIds) {
      plan.reason = 'no listing was supplied, so the date cannot be cross-checked';
      plans.push(plan);
      continue;
    }
    if (!plan.inListing) {
      // Say WHICH listing, because "not in the listing" is the wrong message
      // for a row that belongs to a different channel's listing -- and the
      // fix for that is to run the tool once per channel.
      plan.reason = (listingChannel && row.channel && row.channel !== listingChannel)
        ? `the supplied listing is for channel '${listingChannel}' and this row belongs to `
          + `'${row.channel}' -- run the tool once per channel`
        : 'the video is not in the listing, so its date cannot be cross-checked';
      plans.push(plan);
      continue;
    }
    if (!plan.bounds.newer && !plan.bounds.older) {
      // The listing offers no dated neighbour, so there is nothing to check
      // the date against. Accepting it would mean trusting the page alone --
      // which is exactly what the cross-check exists to avoid.
      plan.reason = 'the listing offers no dated neighbour to check the date against';
      plans.push(plan);
      continue;
    }
    if (!withinBounds(plan.date, plan.bounds)) {
      plan.reason = `the date ${plan.date} falls outside the range its listing neighbours allow `
        + `(${plan.bounds.older || '?'} < date <= ${plan.bounds.newer || '?'})`;
      plans.push(plan);
      continue;
    }

    plan.accepted = true;
    plan.reason = 'the watch page and the listing order agree';
    plans.push(plan);
  }
  return plans;
}

/**
 * Fetch a page. Kept separate so a test can supply its own.
 *
 * @param {string} url
 * @returns {string}
 */
function defaultFetchHtml(url) {
  // Node's fetch follows redirects and sends no cookies, which is what an
  // age-gated video needs: the date is served to a logged-out client.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  return fetch(url, {
    signal: controller.signal,
    headers: {
      // A browser UA: YouTube serves the metadata block to one, and serves
      // an interstitial to an unidentified client.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  }).then((response) => response.text()).finally(() => clearTimeout(timer));
}

/**
 * Write the plan to a run snapshot.
 *
 * The audit row's `raw_output_path` points at one of these, so that a reader
 * can see WHY each row was or was not dated -- the database records the
 * counts, not the reasons.
 *
 * @param {object[]} plan
 * @param {string} dir - where to write it
 * @param {string} [stamp] - the timestamp to put in the name
 * @returns {string} the path written
 */
function writePlanSnapshot(plan, dir, stamp) {
  fs.mkdirSync(dir, { recursive: true });
  const safeStamp = String(stamp || new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z'));
  const file = path.join(dir, `resolve_undated_${safeStamp}.tsv`);
  const lines = ['video_id\tchannel\tupload_date\taccepted\tolder_bound\tnewer_bound\treason\ttitle'];
  for (const row of plan) {
    lines.push([
      row.video_id,
      row.channel,
      row.date || '',
      row.accepted ? 'yes' : 'no',
      row.bounds.older || '',
      row.bounds.newer || '',
      // A reason can contain a tab or a newline; the file is TSV, so fold
      // them into spaces.
      String(row.reason || '').replace(/[\t\r\n]+/g, ' '),
      String(row.title || '').replace(/[\t\r\n]+/g, ' '),
    ].join('\t'));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/**
 * Write the accepted dates, and record what the run did.
 *
 * @param {object} db - an open DatabaseSync
 * @param {object[]} plan - the plan from planResolution
 * @param {object} [options]
 * @param {string} [options.sourceUrl]
 * @param {string} [options.rawOutputPath]
 * @param {string} [options.command] - the command line, as JSON
 * @param {number} [options.notListedCount] - work-list rows the listing did not hold
 * @param {number} [options.listingComplete] - 1 when the listing covered the channel
 * @param {string} [options.now] - the timestamp to stamp
 * @returns {{written: number, unresolved: number, runId: number|null}}
 */
function applyPlan(db, plan, options = {}) {
  const accepted = plan.filter((p) => p.accepted);
  const now = options.now || new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

  const update = db.prepare(
    'UPDATE videos SET upload_date = ?, updated_at = ? '
    + 'WHERE video_id = ? AND (COALESCE(upload_date, \'\') = \'\' OR upload_date = \'NA\')',
  );
  let written = 0;
  for (const row of accepted) {
    written += update.run(row.date, now, row.video_id).changes;
  }

  // `listing_complete` means "this listing covered the whole channel", so a
  // row missing from it proves nothing. The caller attests to that; this
  // tool makes no such claim of its own.
  const notListed = options.notListedCount !== undefined
    ? options.notListedCount
    : plan.filter((p) => !p.inListing).length;
  const listingComplete = options.listingComplete !== undefined ? options.listingComplete : 0;

  const channel = accepted.length ? accepted[0].channel : (plan[0] ? plan[0].channel : '');
  const sourceUrl = options.sourceUrl
    || (plan[0] && plan[0].source_url)
    || '';

  const insert = db.prepare(
    'INSERT INTO catalog_runs (source_url, channel, command_json, raw_output_path, row_count, '
    + 'inserted_count, updated_count, missing_upload_dates, malformed_rows, created_at, kind, '
    + 'not_listed_count, listing_complete, row_count_kind) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const result = insert.run(
    sourceUrl,
    channel,
    options.command || '[]',
    options.rawOutputPath || '',
    plan.length,
    0,
    written,
    plan.length - written,
    0,
    now,
    'live',
    notListed,
    listingComplete,
    'work_list_videos',
  );

  return {
    written,
    unresolved: plan.length - written,
    runId: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
  };
}

/**
 * The channel's source url, as the catalog knows it.
 *
 * The `source_url` worker setting belongs to the channel named in the `channel`
 * setting -- on the shipped catalog that is Revere, and the undated rows are
 * Qullamaggie. So the setting is only used when it is the setting for THIS
 * channel; otherwise the url comes from the rows themselves.
 *
 * @param {object} db
 * @param {string} channel
 * @returns {string}
 */
function channelSourceUrl(db, channel) {
  const setting = db.prepare(
    'SELECT setting_value FROM worker_settings WHERE setting_key = ?',
  ).get('source_url');
  const settingChannel = db.prepare(
    'SELECT setting_value FROM worker_settings WHERE setting_key = ?',
  ).get('channel');
  if (setting && settingChannel && settingChannel.setting_value === channel) {
    return setting.setting_value;
  }
  const row = db.prepare(
    'SELECT source_url FROM videos WHERE channel = ? AND source_url <> \'\' LIMIT 1',
  ).get(channel);
  return row ? row.source_url : '';
}

function printReport(plan, result, options = {}) {
  console.log('Undated catalog rows');
  console.log('  database: ' + path.relative(ROOT, options.dbPath || DB_PATH));
  console.log('  rows:     ' + plan.length);
  if (options.listingPath) console.log('  listing:  ' + path.relative(ROOT, options.listingPath));
  console.log('');

  for (const row of plan) {
    const mark = row.accepted ? 'AGREE ' : 'SKIP  ';
    const bounds = (row.bounds.newer || row.bounds.older)
      ? ` [${row.bounds.older || '?'} < date <= ${row.bounds.newer || '?'}]`
      : '';
    console.log(`  ${mark} ${row.video_id.padEnd(14)} ${(row.date || '--------').padEnd(10)}${bounds}`);
    console.log(`        ${row.title || '(no title)'}`);
    console.log(`        ${row.reason}`);
  }

  console.log('');
  if (result) {
    console.log(`  ${result.written} date(s) written, ${result.unresolved} still undated.`);
    if (result.runId !== null) console.log(`  recorded as catalog_runs row ${result.runId}.`);
  } else {
    console.log('  Nothing written. Re-run with --execute to apply.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const execute = argv.includes('--execute');
  const asJson = argv.includes('--json');
  const listingIndex = argv.indexOf('--listing');
  const listingPath = listingIndex >= 0 && argv[listingIndex + 1]
    ? path.resolve(argv[listingIndex + 1])
    : null;
  const dbIndex = argv.indexOf('--db');
  const dbPath = dbIndex >= 0 && argv[dbIndex + 1]
    ? path.resolve(argv[dbIndex + 1])
    : DB_PATH;

  if (!fs.existsSync(dbPath)) {
    console.error('No catalog at ' + dbPath);
    return 1;
  }

  const db = new DatabaseSync(dbPath, { readOnly: !execute });
  const rows = undatedRows(db);

  let listingIds = null;
  let listingChannel = null;
  const knownDates = new Map();
  if (listingPath) {
    if (!fs.existsSync(listingPath)) {
      console.error('No listing at ' + listingPath);
      db.close();
      return 1;
    }
    // latin1 so a cp1252 byte never becomes a replacement character.
    listingIds = readListingIds(fs.readFileSync(listingPath, 'latin1'));
    const dated = db.prepare(
      'SELECT video_id, upload_date FROM videos WHERE COALESCE(upload_date, \'\') <> \'\' '
      + 'AND upload_date <> \'NA\'',
    ).all();
    for (const row of dated) knownDates.set(row.video_id, row.upload_date);

    // Which channel does this listing belong to? The one whose catalog rows
    // it holds the most of. The catalog's `channel` is a logical name
    // (`revere`, `qullamaggie`), not the YouTube handle, so this cannot be
    // read off the file name.
    const inListing = new Set(listingIds);
    const byChannel = new Map();
    for (const row of db.prepare('SELECT video_id, channel FROM videos').all()) {
      if (!inListing.has(row.video_id)) continue;
      byChannel.set(row.channel, (byChannel.get(row.channel) || 0) + 1);
    }
    let best = 0;
    for (const [channel, count] of byChannel) {
      if (count > best) { best = count; listingChannel = channel; }
    }
  }

  const plan = await planResolution(rows, { listingIds, listingChannel, knownDates });

  // How complete is the listing we cross-checked against?
  //
  // `listing_complete` means "this listing covered the whole channel", so a
  // row missing from it proves nothing. The test the worker uses is the same
  // one: every catalog row for the channel appears in the listing. A listing
  // that holds every row the catalog knows about is at least as complete as
  // the catalog, so it can attest.
  //
  // Both counts are about the LISTING's channel, not the work list's -- a
  // work list spanning two channels cannot be covered by one listing, and
  // `not_listed_count` means "rows of this channel the listing did not hold".
  let notListedCount = 0;
  let listingComplete = 0;
  if (listingIds && listingChannel) {
    const inListing = new Set(listingIds);
    const channelRows = db.prepare('SELECT video_id FROM videos WHERE channel = ?').all(listingChannel);
    notListedCount = channelRows.filter((r) => !inListing.has(r.video_id)).length;
    listingComplete = notListedCount === 0 ? 1 : 0;
  }

  let result = null;
  if (execute) {
    // The run's own snapshot, so the audit row points at something openable
    // that says WHY each row was or was not dated.
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
    const snapshot = writePlanSnapshot(plan, path.join(ROOT, 'data', 'video_pipeline', 'catalog'), stamp);
    result = applyPlan(db, plan, {
      sourceUrl: channelSourceUrl(db, plan[0] ? plan[0].channel : ''),
      rawOutputPath: toPortablePath(snapshot, ROOT),
      command: JSON.stringify(argv),
      notListedCount,
      listingComplete,
    });
  }

  if (!asJson) {
    printReport(plan, result, { dbPath, listingPath });
  } else {
    console.log(JSON.stringify({
      database: path.relative(ROOT, dbPath),
      rows: plan.length,
      listing: listingPath ? path.relative(ROOT, listingPath) : null,
      written: result ? result.written : 0,
      unresolved: result ? result.unresolved : plan.filter((p) => !p.accepted).length,
      plan: plan.map((p) => ({
        video_id: p.video_id,
        channel: p.channel,
        title: p.title,
        date: p.date,
        bounds: p.bounds,
        inListing: p.inListing,
        accepted: p.accepted,
        reason: p.reason,
      })),
      executed: execute,
    }, null, 2));
  }

  db.close();
  return 0;
}

module.exports = {
  applyPlan,
  dateBounds,
  defaultFetchHtml,
  main,
  parseUploadDate,
  planResolution,
  readListingIds,
  undatedRows,
  withinBounds,
  writePlanSnapshot,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  });
}
