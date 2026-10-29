'use strict';

// The undated-rows resolver, tested offline.
//
// The tool exists because some videos cannot be dated by yt-dlp: an
// age-restricted upload is refused before its metadata is read, so `fill-dates`
// leaves the row undated, and an undated row falls out of every date-keyed
// layout the pipeline has. The watch page carries the date anyway, in its
// embedded JSON.
//
// A date read out of a web page is not evidence on its own, so the tool
// cross-checks it against the channel listing's ORDER -- the listing is
// newest-first, so an undated video's date has to fall between its dated
// neighbours. Two independent methods have to agree before anything is
// written.
//
// These tests use a fake fetch: no network, no YouTube.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const {
  applyPlan,
  dateBounds,
  parseUploadDate,
  planResolution,
  readListingIds,
  undatedRows,
  withinBounds,
  writePlanSnapshot,
} = require('../tools/resolveUndatedDates');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'data', 'db', 'schema.sql');

/**
 * A watch page carrying the given upload date.
 *
 * @param {string} date - `YYYY-MM-DD`
 * @returns {string}
 */
function watchPage(date) {
  return `<!DOCTYPE html><html><head><title>watch</title><script>
  var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc"},
  "microformat":{"playerMicroformatRenderer":{"uploadDate":"${date}T06:59:31-08:00"}}};
  </script></head><body></body></html>`;
}

/** A watch page with no date on it -- a removed video, or an interstitial. */
const EMPTY_PAGE = '<!DOCTYPE html><html><body>Sign in to confirm your age</body></html>';

// ---------------------------------------------------------------------------
// Reading the date
// ---------------------------------------------------------------------------

test('the upload date is read out of the watch page', () => {
  assert.equal(parseUploadDate(watchPage('2022-03-03')), '20220303');
});

test('a page with no date yields no date, rather than a wrong one', () => {
  assert.equal(parseUploadDate(EMPTY_PAGE), null);
  assert.equal(parseUploadDate(''), null);
  assert.equal(parseUploadDate(null), null);
});

test('a date in another format is not mistaken for an upload date', () => {
  // The publish date, not the upload date, and a bare date with no time.
  assert.equal(parseUploadDate('{"publishDate":"2022-03-03"}'), null);
  assert.equal(parseUploadDate('{"uploadDate":"2022-03-03"}'), null);
});

// ---------------------------------------------------------------------------
// Reading the listing
// ---------------------------------------------------------------------------

test('the listing is read whether the separator is a tab or a literal backslash-t', () => {
  // A real tab.
  assert.deepEqual(readListingIds('abc\ttitle one\ndef\ttitle two'), ['abc', 'def']);
  // The two characters `\t`, which is what a shell hands yt-dlp.
  const literal = String.fromCharCode(92) + 't';
  assert.deepEqual(readListingIds(`abc${literal}title one\ndef${literal}title two`), ['abc', 'def']);
});

test('a listing with no title still yields the ids', () => {
  assert.deepEqual(readListingIds('abc\ndef\n'), ['abc', 'def']);
});

test('a cp1252 listing is read as latin1, so no byte becomes a replacement character', () => {
  // 0x92 is a curly apostrophe in cp1252 and invalid UTF-8.
  const buffer = Buffer.concat([
    Buffer.from('abc\ttitle with a '),
    Buffer.from([0x92]),
    Buffer.from(' quote'),
  ]);
  const ids = readListingIds(buffer.toString('latin1'));
  assert.deepEqual(ids, ['abc']);
  assert.ok(!ids[0].includes('�'), 'the id is ASCII, so it cannot be mangled');
});

// ---------------------------------------------------------------------------
// The ordering bound
// ---------------------------------------------------------------------------

test('the bound is the nearest dated neighbour on each side', () => {
  // Newest first.
  const listing = ['a', 'b', 'c', 'd', 'e'];
  const dates = new Map([['a', '20220320'], ['c', '20220310'], ['e', '20220301']]);
  assert.deepEqual(dateBounds(listing, dates, 'c'), { newer: '20220320', older: '20220301' });
});

test('a bound is open on the side that has no dated neighbour', () => {
  const listing = ['a', 'b', 'c'];
  const dates = new Map([['b', '20220310']]);
  assert.deepEqual(dateBounds(listing, dates, 'a'), { newer: null, older: '20220310' });
  assert.deepEqual(dateBounds(listing, dates, 'c'), { newer: '20220310', older: null });
});

test('a video that is not in the listing has no bound', () => {
  const listing = ['a', 'b'];
  const dates = new Map([['a', '20220320']]);
  assert.deepEqual(dateBounds(listing, dates, 'zzz'), { newer: null, older: null });
});

test('the bound is inclusive at the newer end and exclusive at the older end', () => {
  // The listing is newest-first, so a video can share a day with the video
  // above it -- but not with the one below it, which is strictly older.
  const bounds = { newer: '20220318', older: '20220302' };
  assert.equal(withinBounds('20220318', bounds), true, 'the same day as the newer neighbour');
  assert.equal(withinBounds('20220303', bounds), true);
  assert.equal(withinBounds('20220302', bounds), false, 'the same day as the older neighbour');
  assert.equal(withinBounds('20220319', bounds), false, 'newer than the newer neighbour');
  assert.equal(withinBounds('20220301', bounds), false, 'older than the older neighbour');
});

test('a bound with one side missing constrains only the other side', () => {
  assert.equal(withinBounds('20200101', { newer: null, older: '20220302' }), false);
  assert.equal(withinBounds('20200101', { newer: '20220302', older: null }), true);
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const ROWS = [
  { video_id: 'te9tmNOA38I', channel: 'qullamaggie', title: 'Fuck Putin etc', source_url: 'u' },
  { video_id: 'xNL-i3acbVk', channel: 'qullamaggie', title: 'smart things', source_url: 'u' },
];

test('a date the listing agrees with is accepted', async () => {
  const listing = ['te9tmNOA38I', 'xNL-i3acbVk'];
  const dates = new Map([['xNL-i3acbVk', '20220211']]);
  const plan = await planResolution([ROWS[0]], {
    listingIds: listing,
    knownDates: dates,
    fetchHtml: () => watchPage('2022-03-03'),
  });
  assert.equal(plan[0].date, '20220303');
  assert.equal(plan[0].accepted, true);
  assert.match(plan[0].reason, /agree/);
});

test('a date the listing contradicts is refused, and the reason says why', async () => {
  const listing = ['te9tmNOA38I', 'xNL-i3acbVk'];
  const dates = new Map([['xNL-i3acbVk', '20220211']]);
  const plan = await planResolution([ROWS[0]], {
    listingIds: listing,
    knownDates: dates,
    fetchHtml: () => watchPage('2021-01-01'),
  });
  assert.equal(plan[0].date, '20210101');
  assert.equal(plan[0].accepted, false);
  assert.match(plan[0].reason, /outside the range/);
});

test('a video that is not in the listing is refused rather than trusted', async () => {
  const plan = await planResolution([ROWS[0]], {
    listingIds: ['somethingElse'],
    knownDates: new Map(),
    fetchHtml: () => watchPage('2022-03-03'),
  });
  assert.equal(plan[0].accepted, false);
  assert.match(plan[0].reason, /not in the listing/);
});

test('a watch page with no date is refused', async () => {
  const plan = await planResolution([ROWS[0]], {
    listingIds: ['te9tmNOA38I'],
    knownDates: new Map(),
    fetchHtml: () => EMPTY_PAGE,
  });
  assert.equal(plan[0].date, null);
  assert.equal(plan[0].accepted, false);
  assert.match(plan[0].reason, /no upload date/);
});

test('without a listing there is nothing to cross-check against, so nothing is accepted', async () => {
  // A date read out of a page and nothing else to agree with it is not
  // evidence. The tool refuses rather than writing an unverified date.
  const plan = await planResolution([ROWS[0]], {
    fetchHtml: () => watchPage('2022-03-03'),
  });
  assert.equal(plan[0].date, '20220303');
  assert.equal(plan[0].accepted, false);
});

test('a listing with no dated neighbour refuses the date, rather than accepting it vacuously', async () => {
  // A bound with nothing on either side constrains nothing, so every date
  // would satisfy it -- and accepting one would mean trusting the page
  // alone, which is the thing the cross-check exists to prevent.
  const plan = await planResolution([ROWS[0]], {
    listingIds: ['te9tmNOA38I', 'xNL-i3acbVk'],
    knownDates: new Map(),
    fetchHtml: () => watchPage('2022-03-03'),
  });
  assert.equal(plan[0].accepted, false);
  assert.match(plan[0].reason, /no dated neighbour/);
});

test('a fetch that resolves to a promise is awaited, not stringified', async () => {
  // The bug this pins: the plan was synchronous while the real fetch is
  // asynchronous, so the page arrived as "[object Promise]" and every video
  // was reported as having no date -- a silent, total failure that still
  // produced a clean-looking report.
  const plan = await planResolution([ROWS[0]], {
    listingIds: ['te9tmNOA38I', 'xNL-i3acbVk'],
    knownDates: new Map([['xNL-i3acbVk', '20220211']]),
    fetchHtml: async () => watchPage('2022-03-03'),
  });
  assert.equal(plan[0].date, '20220303');
  assert.equal(plan[0].accepted, true);
});

test('a fetch that throws refuses that row and does not abandon the others', async () => {
  const plan = await planResolution(ROWS, {
    listingIds: ['te9tmNOA38I', 'xNL-i3acbVk', 'anOlderDatedVideo'],
    knownDates: new Map([['anOlderDatedVideo', '20220211']]),
    fetchHtml: async (url) => {
      if (url.includes('te9tmNOA38I')) throw new Error('network is unreachable');
      return watchPage('2022-02-16');
    },
  });
  assert.equal(plan.length, 2, 'both rows are still reported');
  assert.equal(plan[0].accepted, false);
  assert.match(plan[0].reason, /could not be fetched/);
  assert.equal(plan[1].accepted, true);
  assert.equal(plan[1].date, '20220216');
});

// ---------------------------------------------------------------------------
// Applying the plan
// ---------------------------------------------------------------------------

/**
 * A fresh catalog with the shipped schema.
 *
 * @returns {{db: object, dir: string}}
 */
function tempCatalog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return { db, dir, dbPath };
}

function addVideo(db, videoId, options = {}) {
  db.prepare(
    'INSERT INTO videos (video_id, channel, title, upload_date, status, source_url, '
    + 'created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    videoId,
    options.channel || 'qullamaggie',
    options.title || 'a video',
    options.upload_date || '',
    options.status || 'pending',
    options.source_url || 'https://www.youtube.com/@Qullamaggie/videos',
    '2026-01-01T00:00:00+00:00',
    '2026-01-01T00:00:00+00:00',
  );
}

test('applying the plan writes the date and records the run', async () => {
  const { db, dir } = tempCatalog();
  try {
    addVideo(db, 'te9tmNOA38I');
    const rows = undatedRows(db);
    assert.equal(rows.length, 1);

    const plan = await planResolution(rows, {
      listingIds: ['te9tmNOA38I', 'xNL-i3acbVk'],
      knownDates: new Map([['xNL-i3acbVk', '20220211']]),
      fetchHtml: () => watchPage('2022-03-03'),
    });
    assert.equal(plan[0].accepted, true);

    const result = applyPlan(db, plan, {
      sourceUrl: 'https://www.youtube.com/@Qullamaggie/videos',
      command: '["--execute"]',
      notListedCount: 0,
      listingComplete: 1,
      now: '2026-10-29T00:00:00+00:00',
    });

    assert.equal(result.written, 1);
    assert.equal(result.unresolved, 0);

    const row = db.prepare('SELECT upload_date FROM videos WHERE video_id = ?').get('te9tmNOA38I');
    assert.equal(row.upload_date, '20220303');
    assert.equal(undatedRows(db).length, 0, 'the row is no longer undated');

    const run = db.prepare('SELECT * FROM catalog_runs WHERE run_id = ?').get(result.runId);
    assert.ok(run, 'the run is recorded');
    assert.equal(run.channel, 'qullamaggie');
    assert.equal(run.kind, 'live');
    assert.equal(run.updated_count, 1);
    assert.equal(run.missing_upload_dates, 0);
    assert.equal(run.row_count, 1);
    assert.equal(run.row_count_kind, 'work_list_videos');
    assert.equal(run.listing_complete, 1, 'every work-list row was in the listing');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused row is not written, and the run says so', async () => {
  const { db, dir } = tempCatalog();
  try {
    addVideo(db, 'te9tmNOA38I');
    const plan = await planResolution(undatedRows(db), {
      listingIds: ['te9tmNOA38I', 'xNL-i3acbVk'],
      knownDates: new Map([['xNL-i3acbVk', '20220211']]),
      fetchHtml: () => watchPage('2021-01-01'),
    });
    const result = applyPlan(db, plan, { now: '2026-10-29T00:00:00+00:00' });
    assert.equal(result.written, 0);
    assert.equal(result.unresolved, 1);

    const row = db.prepare('SELECT upload_date FROM videos WHERE video_id = ?').get('te9tmNOA38I');
    assert.equal(row.upload_date, '', 'the date was not written');

    const run = db.prepare('SELECT * FROM catalog_runs WHERE run_id = ?').get(result.runId);
    assert.equal(run.updated_count, 0);
    assert.equal(run.missing_upload_dates, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row that already has a date is never overwritten', () => {
  const { db, dir } = tempCatalog();
  try {
    addVideo(db, 'te9tmNOA38I', { upload_date: '20200101' });
    // The row is dated, so it is not in the work list at all.
    assert.equal(undatedRows(db).length, 0);

    // And even if a plan somehow names it, the UPDATE is guarded.
    const plan = [{
      video_id: 'te9tmNOA38I', channel: 'qullamaggie', title: 'a video',
      date: '20220303', bounds: { newer: null, older: null },
      inListing: true, accepted: true, reason: '',
    }];
    const result = applyPlan(db, plan, { now: '2026-10-29T00:00:00+00:00' });
    assert.equal(result.written, 0, 'the guarded UPDATE changed nothing');
    const row = db.prepare('SELECT upload_date FROM videos WHERE video_id = ?').get('te9tmNOA38I');
    assert.equal(row.upload_date, '20200101');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a row whose date is the placeholder 'NA' counts as undated", () => {
  const { db, dir } = tempCatalog();
  try {
    addVideo(db, 'te9tmNOA38I', { upload_date: 'NA' });
    assert.equal(undatedRows(db).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the run makes no claim about the listing being complete unless it can', async () => {
  const { db, dir } = tempCatalog();
  try {
    addVideo(db, 'te9tmNOA38I');
    addVideo(db, 'aVideoNotInTheListing');
    const plan = await planResolution(undatedRows(db), {
      listingIds: ['te9tmNOA38I', 'xNL-i3acbVk'],
      knownDates: new Map([['xNL-i3acbVk', '20220211']]),
      fetchHtml: async () => watchPage('2022-03-03'),
    });
    // No listingComplete given: the run claims nothing.
    const result = applyPlan(db, plan, { now: '2026-10-29T00:00:00+00:00' });
    const run = db.prepare('SELECT * FROM catalog_runs WHERE run_id = ?').get(result.runId);
    assert.equal(run.listing_complete, 0);
    assert.equal(run.not_listed_count, 1, 'the row missing from the listing is counted');
    assert.equal(run.missing_upload_dates, 1, 'only the cross-checked row was dated');
    assert.equal(run.updated_count, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The run snapshot
// ---------------------------------------------------------------------------

test('the run snapshot records why each row was or was not dated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undated-snap-'));
  try {
    const file = writePlanSnapshot([
      {
        video_id: 'te9tmNOA38I', channel: 'qullamaggie', title: 'Fuck Putin etc',
        date: '20220303', bounds: { newer: '20220318', older: '20220302' },
        inListing: true, accepted: true, reason: 'the watch page and the listing order agree',
      },
      {
        video_id: 'xNL-i3acbVk', channel: 'qullamaggie', title: 'said lots of smart things',
        date: null, bounds: { newer: null, older: null },
        inListing: false, accepted: false, reason: 'not\tin the listing',
      },
    ], dir, '20261029T000000Z');

    assert.ok(fs.existsSync(file), 'the snapshot is written');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'a header and one line per row');

    const cells = lines[1].split('\t');
    assert.equal(cells[0], 'te9tmNOA38I');
    assert.equal(cells[2], '20220303');
    assert.equal(cells[3], 'yes');
    assert.equal(cells[4], '20220302');
    assert.equal(cells[5], '20220318');

    // A tab inside a reason would break the TSV, so it is folded away.
    const second = lines[2].split('\t');
    assert.equal(second[6], 'not in the listing');
    assert.equal(second[7], 'said lots of smart things');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
