'use strict';

/**
 * Catalog the Komar corpus: inventory both folders, read each document's
 * own chrome, probe each video, and record what every file IS.
 *
 * WHAT THIS STAGE IS FOR
 *
 * Every source here has the same first stage: know what you have. A
 * catalog that does not know its own corpus cannot report coverage
 * honestly, and this project has been bitten by that more than once.
 *
 * So this stage records, per document: the session it covers, its kind,
 * its title, its series, its report number, its page count, its source
 * URL and its checksum. And per video: its series, its part, its report
 * number, its session date, its geometry and its duration.
 *
 * THE FILENAME IS NOT THE DATE
 *
 * `komar_20260408.pdf` is named 2026-04-08; its own title and its own
 * URL both say 2025-04-08. `Trades-August-2025.pdf` is named August; its
 * own first slide says "July 2025 Trades". So the catalog reads the
 * document, prefers what the document says, keeps the filename date
 * beside it, and marks the rows where the two disagree.
 *
 * THE CHANGE DETECTOR
 *
 * The documents are checksummed with md5: they are small and they are
 * the records that matter. The videos are NOT checksummed: 48 GB read
 * on every catalog run is not affordable, and the media is never
 * committed anyway. Size and mtime are what the frame OCR cache
 * already uses, and they are enough to say "this file has changed".
 *
 * Usage:
 *   node tools/catalogKomar.js
 *   node tools/catalogKomar.js --source-dir D:\courses_nosync\julian_komar --json
 *   node tools/catalogKomar.js --dry-run
 *   node tools/catalogKomar.js --no-probe
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { attachDerived } = require('../src/db/derivedStore');

const { KOMAR_SOURCE, komarDocId, komarSourceDir, komarVideoId } = require('../src/komar/channel');
const { ensureKomarSchema } = require('../src/komar/schema');
const { classifyDocument } = require('../src/komar/documentLayout');
const { dateFromReportNumber, listCorpus, parseVideoName } = require('../src/komar/corpusCatalog');
const { checksumFile } = require('../src/newsletter/documentCatalog');
const { readMetaMany } = require('../src/newsletter/pdfReader');
const { resolveFfprobeBin } = require('../src/video/ffmpegBin');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const MANIFEST_PATH = path.join(ROOT, 'data', 'komar_manifest.json');

/**
 * The catalog stage's own version.
 *
 * It goes on the manifest, not on the rows: the rows carry the version
 * of whatever READ them, and this stage writes no extracted data.
 */
const CATALOG_VERSION = 'komar-catalog-1';

const argv = process.argv.slice(2);

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return '';
  return next;
}

const options = {
  dryRun: argv.includes('--dry-run'),
  json: argv.includes('--json'),
  noProbe: argv.includes('--no-probe'),
  sourceDir: komarSourceDir({ sourceDir: readFlag(argv, '--source-dir') }),
};

/**
 * Open the catalog with the derived file attached.
 *
 * @returns {object}
 */
function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(DB_PATH);
  attachDerived(db);
  ensureKomarSchema(db);
  return db;
}

/**
 * The series a video belongs to.
 *
 * It is the same vocabulary the documents use, so a video and the
 * document that describes it can be joined on something better than a
 * filename.
 */
const VIDEO_SERIES = {
  daily: 'Daily Market Update',
  lesson: '',
  midweek: 'Mid-Week Update',
  unknown: '',
  weekend: 'Weekend-Report',
  webinar: 'Member Webinar',
};

/**
 * Probe one video.
 *
 * ffprobe is the authority on resolution and duration: the project's
 * standing rule is that filesize tells you nothing about a video, and
 * the same rule applies to the filesize of a video's AUDIO.
 *
 * @param {string} filePath
 * @returns {object} the probe's result
 */
function probeVideo(filePath) {
  const ffprobe = resolveFfprobeBin();
  if (!ffprobe) return { error: 'ffprobe not found' };
  try {
    const raw = execFileSync(
      ffprobe,
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }
    );
    const parsed = JSON.parse(raw);
    const streams = parsed.streams || [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    return {
      audioChannels: audio ? Number(audio.channels) || 0 : 0,
      audioCodec: audio ? String(audio.codec_name || '') : '',
      duration: Number((parsed.format && parsed.format.duration) || 0),
      error: '',
      hasVideo: Boolean(video),
      height: video ? Number(video.height) || 0 : 0,
      width: video ? Number(video.width) || 0 : 0,
    };
  } catch (error) {
    return { error: String((error && error.message) || error).slice(0, 200) };
  }
}

/**
 * The catalog id for one video.
 *
 * A weekly session is keyed by its REPORT NUMBER and its PART, so the
 * three files of a session get three ids that read in session order.
 * Everything else is keyed by its filename, because there is nothing
 * else about it yet.
 *
 * @param {object} video
 * @returns {string}
 */
function videoIdFor(video) {
  if (video.kind === 'weekend' && video.reportNumber) {
    return komarVideoId('weekend', `${video.reportNumber}_${video.part || 'main'}`);
  }
  return komarVideoId(video.kind, video.slug);
}

/**
 * The document's session date, and where it came from.
 *
 * The document's OWN date wins over the filename's, because the corpus
 * contains files whose names are wrong about their own date.
 *
 * @param {object} document - the filename parse
 * @param {object} classified - the document classification
 * @returns {{date: string, source: string, conflict: boolean}}
 */
function resolveDocumentDate(document, classified) {
  const filenameDate = document.fileDate || '';
  const chromeDate = classified.titleDate || classified.urlDate || '';
  if (chromeDate) {
    return {
      conflict: Boolean(filenameDate) && filenameDate !== chromeDate,
      date: chromeDate,
      precision: classified.titleDate ? classified.titleDatePrecision : classified.urlDatePrecision,
      source: classified.titleDate ? 'chrome_title' : 'chrome_url',
    };
  }
  if (filenameDate) {
    return { conflict: false, date: filenameDate, precision: document.fileDatePrecision || 'day', source: 'filename' };
  }
  if (classified.titleDate) {
    return { conflict: false, date: classified.titleDate, precision: classified.titleDatePrecision, source: 'content' };
  }
  return { conflict: false, date: '', precision: '', source: 'unknown' };
}

/**
 * The catalog id for one document.
 *
 * @param {object} document
 * @param {object} classified
 * @param {object} date
 * @returns {string}
 */
function documentIdFor(document, classified, date) {
  if (classified.kind === 'summary') return komarDocId('summary', date.date || document.slug);
  if (classified.kind === 'report') return komarDocId('report', date.date || document.slug);
  if (classified.kind === 'post') return komarDocId('post', date.date || document.slug);
  if (classified.kind === 'deck') return komarDocId('deck', document.slug);
  return komarDocId(classified.kind, document.slug);
}

/**
 * Build the document rows.
 *
 * @param {object[]} documents
 * @param {object[]} structures
 * @param {string} sourceDir
 * @returns {object[]}
 */
function buildDocumentRows(documents, structures, sourceDir) {
  const rows = [];
  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const structure = structures[index] || {};
    const error = structure.error ? String(structure.error) : '';
    const classified = error
      ? { chapters: [], kind: 'unknown', pageKind: '', printStamp: '', reportNumber: '', series: '', title: '', titleDate: '', url: '', urlDate: '' }
      : classifyDocument(structure);
    const date = resolveDocumentDate(document, classified);
    const absolute = path.join(sourceDir, document.folder, document.fileName);

    rows.push({
      chapters: classified.chapters || [],
      date_conflict: date.conflict ? 1 : 0,
      doc_id: documentIdFor(document, classified, date),
      filename_date: document.fileDate || '',
      folder: document.folder,
      kind: classified.kind,
      page_count: Number(structure.page_count || 0),
      pdf_bytes: fs.existsSync(absolute) ? fs.statSync(absolute).size : 0,
      pdf_checksum: fs.existsSync(absolute) ? checksumFile(absolute) : '',
      pdf_path: path.join(document.folder, document.fileName),
      print_stamp: classified.printStamp || '',
      provenance: classified.kind === 'summary' ? 'machine_written' : 'primary',
      report_number: classified.reportNumber || '',
      series: classified.series || '',
      session_date: date.date,
      session_date_precision: date.precision,
      session_date_source: date.source,
      source_url: classified.url || '',
      title: classified.title || document.slug,
      unreadable: error,
    });
  }
  return rows;
}

/**
 * Build the video rows, and link them to the documents that describe
 * their session.
 *
 * THE LINK
 *
 * A weekly session's videos are named after its REPORT NUMBER and only
 * the document carries the date. So a weekend video is linked to the
 * document with the same report number, and takes its session date from
 * that document. A dated video is linked by its own filename date.
 *
 * @param {object[]} videos
 * @param {object[]} documentRows
 * @param {string} sourceDir
 * @returns {object[]}
 */
function buildVideoRows(videos, documentRows, sourceDir) {
  const byReport = new Map();
  const byDate = new Map();
  for (const row of documentRows) {
    if (row.report_number) byReport.set(row.report_number, row);
    // ONLY a day-precision date links. A document that names its month
    // ("Trades-August-2025.pdf", whose content is July 2025) would
    // otherwise link every video that mentions that month to it, and
    // two different videos about July would silently share one
    // document. A link that is a guess is not a link.
    if (row.session_date && row.session_date_precision === 'day') byDate.set(row.session_date, row);
  }

  // THE REPORT NUMBER IS CHRONOLOGICAL, and it dates the sessions whose
  // own name carries no date.
  //
  // The corpus measures it: 43 -> 2022-11-19, 50 -> 2023-01-08 (+50
  // days over 7 reports), 70 -> 2023-05-29 (+500 over 19), 211 ->
  // 2026-01-25 (+972 over 141), 226 -> 2026-05-09 (+14 over 2) -- a
  // weekly report, and the 2025 series agrees independently through its
  // files' own timestamps (188 -> 199 in exact 7-day steps).
  //
  // ONE NAME DISAGREES, and it is the one the corpus calls out:
  // "January 14 2022 Weekend-Report 51" -- 50 is 8 January 2023 and
  // 51 is the weekend after it, so the YEAR in that name is a typo.
  // So an anchor that contradicts its neighbours by more than a
  // fortnight is not trusted, and the rest date what is left.
  const anchors = [];
  for (const row of documentRows) {
    if (row.report_number && row.session_date && row.session_date_precision === 'day') {
      anchors.push({ date: row.session_date, number: Number(row.report_number) });
    }
  }
  for (const video of videos) {
    if (video.reportNumber && video.sessionDate) {
      anchors.push({ date: video.sessionDate, number: Number(video.reportNumber) });
    }
  }
  const trustedAnchors = anchors.filter((anchor) => {
    const others = anchors.filter((other) => other.number !== anchor.number);
    const implied = dateFromReportNumber(anchor.number, others);
    if (!implied) return true; // nothing to check it against
    const own = Date.parse(`${anchor.date.slice(0, 4)}-${anchor.date.slice(4, 6)}-${anchor.date.slice(6, 8)}T00:00:00Z`);
    const said = Date.parse(`${implied.date.slice(0, 4)}-${implied.date.slice(4, 6)}-${implied.date.slice(6, 8)}T00:00:00Z`);
    return Math.abs(own - said) <= 14 * 86400000;
  });

  const rows = [];
  for (const video of videos) {
    const absolute = path.join(sourceDir, video.folder, video.fileName);
    const stat = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
    const probe = options.noProbe
      ? { audioChannels: 0, audioCodec: '', duration: 0, error: '', hasVideo: true, height: 0, width: 0 }
      : probeVideo(absolute);

    let sessionDate = video.sessionDate || '';
    let sessionDatePrecision = sessionDate ? (video.datePrecision || 'day') : '';
    let sessionDateSource = sessionDate ? 'filename' : 'unknown';
    let sessionDocId = '';

    const linked = video.kind === 'weekend' && video.reportNumber
      ? byReport.get(video.reportNumber)
      : (sessionDate ? byDate.get(sessionDate) : null);
    if (linked) {
      sessionDocId = linked.doc_id;
      if (linked.session_date) {
        sessionDate = linked.session_date;
        sessionDatePrecision = linked.session_date_precision || 'day';
        sessionDateSource = 'pdf_chrome';
      }
    }

    // A session whose own name carries no date is dated by the report
    // number -- and a session whose own date CONTRADICTS the sequence
    // is dated by it too, because the sequence is the better record
    // (the corpus's own misdated name is a year typo).
    if (video.reportNumber) {
      const implied = dateFromReportNumber(Number(video.reportNumber), trustedAnchors);
      if (implied) {
        const ownMs = sessionDate
          ? Date.parse(`${sessionDate.slice(0, 4)}-${sessionDate.slice(4, 6)}-${sessionDate.slice(6, 8)}T00:00:00Z`)
          : null;
        const saidMs = Date.parse(`${implied.date.slice(0, 4)}-${implied.date.slice(4, 6)}-${implied.date.slice(6, 8)}T00:00:00Z`);
        const disagrees = ownMs !== null && Math.abs(ownMs - saidMs) > 14 * 86400000;
        if (!sessionDate || disagrees) {
          sessionDate = implied.date;
          sessionDatePrecision = implied.precision;
          // A name that contradicts the sequence is a typo, and the
          // source says how the date was arrived at either way.
          sessionDateSource = disagrees ? 'report_number_over_filename' : 'report_number';
        }
      }
    }

    rows.push({
      audio_channels: probe.audioChannels,
      series: VIDEO_SERIES[video.kind] || '',
      audio_codec: probe.audioCodec,
      content_key: stat ? `${stat.size}:${Math.round(stat.mtimeMs)}` : '',
      duration_sec: probe.duration,
      folder: video.folder,
      has_video: probe.hasVideo ? 1 : 0,
      height: probe.height,
      kind: video.kind,
      media_path: path.join(video.folder, video.fileName),
      part: video.part || '',
      part_index: video.partIndex || 0,
      report_number: video.reportNumber || '',
      session_date: sessionDate,
      session_date_precision: sessionDatePrecision,
      session_date_source: sessionDateSource,
      session_doc_id: sessionDocId,
      size_bytes: stat ? stat.size : 0,
      title: video.title,
      unreadable: probe.error || '',
      video_id: videoIdFor(video),
      width: probe.width,
    });
  }
  return rows;
}

/**
 * The rows that would share a catalog id.
 *
 * @param {object[]} rows
 * @param {string} field
 * @returns {object[]}
 */
function findIdCollisions(rows, field) {
  const byId = new Map();
  for (const row of rows) {
    const list = byId.get(row[field]) || [];
    list.push(row.pdf_path || row.media_path);
    byId.set(row[field], list);
  }
  const collisions = [];
  for (const [id, files] of byId) {
    if (files.length > 1) collisions.push({ files, id });
  }
  return collisions;
}

/**
 * Compare the fresh inventory with what is already recorded.
 *
 * @param {object} db
 * @param {object[]} documentRows
 * @param {object[]} videoRows
 * @returns {object}
 */
function diffAgainstCatalog(db, documentRows, videoRows) {
  const existingDocuments = new Map();
  for (const row of db.prepare('SELECT doc_id, pdf_checksum FROM komar_documents').all()) {
    existingDocuments.set(row.doc_id, row.pdf_checksum);
  }
  const existingVideos = new Map();
  for (const row of db.prepare('SELECT video_id, content_key FROM komar_videos').all()) {
    existingVideos.set(row.video_id, row.content_key);
  }

  const counts = { documentsInserted: 0, documentsRemoved: 0, documentsUnchanged: 0, documentsUpdated: 0, videosInserted: 0, videosRemoved: 0, videosUnchanged: 0, videosUpdated: 0 };
  const seenDocuments = new Set();
  const seenVideos = new Set();

  for (const row of documentRows) {
    seenDocuments.add(row.doc_id);
    const prior = existingDocuments.get(row.doc_id);
    if (prior === undefined) counts.documentsInserted += 1;
    else if (prior !== row.pdf_checksum) counts.documentsUpdated += 1;
    else counts.documentsUnchanged += 1;
  }
  for (const row of videoRows) {
    seenVideos.add(row.video_id);
    const prior = existingVideos.get(row.video_id);
    if (prior === undefined) counts.videosInserted += 1;
    else if (prior !== row.content_key) counts.videosUpdated += 1;
    else counts.videosUnchanged += 1;
  }
  for (const id of existingDocuments.keys()) {
    if (!seenDocuments.has(id)) counts.documentsRemoved += 1;
  }
  for (const id of existingVideos.keys()) {
    if (!seenVideos.has(id)) counts.videosRemoved += 1;
  }
  return counts;
}

/**
 * Write the document rows.
 *
 * @param {object} db
 * @param {object[]} rows
 */
function writeDocumentRows(db, rows) {
  const statement = db.prepare(`
    INSERT INTO komar_documents (
      doc_id, kind, title, series, session_date, session_date_precision,
      session_date_source, filename_date, date_conflict, report_number,
      page_count, source_url, print_stamp, chapters_json, pdf_path, pdf_bytes,
      pdf_checksum, provenance, folder, catalog_version, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(doc_id) DO UPDATE SET
      kind = excluded.kind,
      title = excluded.title,
      series = excluded.series,
      session_date = excluded.session_date,
      session_date_precision = excluded.session_date_precision,
      session_date_source = excluded.session_date_source,
      filename_date = excluded.filename_date,
      date_conflict = excluded.date_conflict,
      report_number = excluded.report_number,
      page_count = excluded.page_count,
      source_url = excluded.source_url,
      print_stamp = excluded.print_stamp,
      chapters_json = excluded.chapters_json,
      pdf_path = excluded.pdf_path,
      pdf_bytes = excluded.pdf_bytes,
      pdf_checksum = excluded.pdf_checksum,
      provenance = excluded.provenance,
      folder = excluded.folder,
      catalog_version = excluded.catalog_version,
      updated_at = datetime('now')
  `);
  for (const row of rows) {
    statement.run(
      row.doc_id,
      row.kind,
      row.title,
      row.series,
      row.session_date,
      row.session_date_precision,
      row.session_date_source,
      row.filename_date,
      row.date_conflict,
      row.report_number,
      row.page_count,
      row.source_url,
      row.print_stamp,
      JSON.stringify(row.chapters || []),
      row.pdf_path,
      row.pdf_bytes,
      row.pdf_checksum,
      row.provenance,
      row.folder,
      CATALOG_VERSION
    );
  }
}

/**
 * Write the video rows.
 *
 * @param {object} db
 * @param {object[]} rows
 */
function writeVideoRows(db, rows) {
  const statement = db.prepare(`
    INSERT INTO komar_videos (
      video_id, kind, series, title, part, part_index, report_number,
      session_date, session_date_precision, session_date_source,
      session_doc_id, has_video, width, height, duration_sec, audio_codec,
      audio_channels, size_bytes, content_key, media_path, folder,
      catalog_version, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(video_id) DO UPDATE SET
      kind = excluded.kind,
      series = excluded.series,
      title = excluded.title,
      part = excluded.part,
      part_index = excluded.part_index,
      report_number = excluded.report_number,
      session_date = excluded.session_date,
      session_date_precision = excluded.session_date_precision,
      session_date_source = excluded.session_date_source,
      session_doc_id = excluded.session_doc_id,
      has_video = excluded.has_video,
      width = excluded.width,
      height = excluded.height,
      duration_sec = excluded.duration_sec,
      audio_codec = excluded.audio_codec,
      audio_channels = excluded.audio_channels,
      size_bytes = excluded.size_bytes,
      content_key = excluded.content_key,
      media_path = excluded.media_path,
      folder = excluded.folder,
      catalog_version = excluded.catalog_version,
      updated_at = datetime('now')
  `);
  for (const row of rows) {
    statement.run(
      row.video_id,
      row.kind,
      row.series,
      row.title,
      row.part,
      row.part_index,
      row.report_number,
      row.session_date,
      row.session_date_precision,
      row.session_date_source,
      row.session_doc_id,
      row.has_video,
      row.width,
      row.height,
      row.duration_sec,
      row.audio_codec,
      row.audio_channels,
      row.size_bytes,
      row.content_key,
      row.media_path,
      row.folder,
      CATALOG_VERSION
    );
  }
}

/**
 * Remove the rows that are no longer in the corpus.
 *
 * @param {object} db
 * @param {object[]} documentRows
 * @param {object[]} videoRows
 * @returns {number}
 */
function removeStaleRows(db, documentRows, videoRows) {
  const documents = new Set(documentRows.map((row) => row.doc_id));
  const videos = new Set(videoRows.map((row) => row.video_id));
  let removed = 0;
  for (const row of db.prepare('SELECT doc_id FROM komar_documents').all()) {
    if (!documents.has(row.doc_id)) {
      db.prepare('DELETE FROM komar_documents WHERE doc_id = ?').run(row.doc_id);
      removed += 1;
    }
  }
  for (const row of db.prepare('SELECT video_id FROM komar_videos').all()) {
    if (!videos.has(row.video_id)) {
      db.prepare('DELETE FROM komar_videos WHERE video_id = ?').run(row.video_id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * The manifest: what the corpus IS, in a form a reader can diff.
 *
 * It is committed, because the corpus itself is not: the media and the
 * PDFs are paid and live outside the repository, so the manifest is the
 * record of what was read.
 *
 * @param {object[]} documentRows
 * @param {object[]} videoRows
 * @param {object} corpus
 * @returns {object}
 */
function buildManifest(documentRows, videoRows, corpus) {
  const documentsByKind = {};
  const videosByKind = {};
  let totalDuration = 0;
  let withDate = 0;
  let withDocument = 0;
  for (const row of documentRows) {
    documentsByKind[row.kind] = (documentsByKind[row.kind] || 0) + 1;
  }
  for (const row of videoRows) {
    videosByKind[row.kind] = (videosByKind[row.kind] || 0) + 1;
    totalDuration += row.duration_sec;
    if (row.session_date) withDate += 1;
    if (row.session_doc_id) withDocument += 1;
  }
  return {
    catalog_version: CATALOG_VERSION,
    generated_at: new Date().toISOString(),
    source: KOMAR_SOURCE,
    source_dir_name: path.basename(options.sourceDir),
    documents: documentRows.map((row) => ({
      chapters: row.chapters,
      date_conflict: row.date_conflict,
      doc_id: row.doc_id,
      filename_date: row.filename_date,
      kind: row.kind,
      page_count: row.page_count,
      pdf_bytes: row.pdf_bytes,
      pdf_checksum: row.pdf_checksum,
      pdf_path: row.pdf_path,
      print_stamp: row.print_stamp,
      provenance: row.provenance,
      report_number: row.report_number,
      series: row.series,
      session_date: row.session_date,
      session_date_precision: row.session_date_precision,
      session_date_source: row.session_date_source,
      source_url: row.source_url,
      title: row.title,
    })),
    summary: {
      date_conflicts: documentRows.filter((row) => row.date_conflict).length,
      documents: documentRows.length,
      documents_by_kind: documentsByKind,
      skipped_entries: corpus.skipped.length,
      total_duration_hours: Math.round((totalDuration / 3600) * 10) / 10,
      videos: videoRows.length,
      videos_by_kind: videosByKind,
      videos_with_a_document: withDocument,
      videos_with_a_session_date: withDate,
    },
    videos: videoRows.map((row) => ({
      audio_channels: row.audio_channels,
      audio_codec: row.audio_codec,
      content_key: row.content_key,
      duration_sec: row.duration_sec,
      folder: row.folder,
      has_video: row.has_video,
      height: row.height,
      kind: row.kind,
      media_path: row.media_path,
      part: row.part,
      part_index: row.part_index,
      report_number: row.report_number,
      session_date: row.session_date,
      session_date_precision: row.session_date_precision,
      session_date_source: row.session_date_source,
      session_doc_id: row.session_doc_id,
      size_bytes: row.size_bytes,
      title: row.title,
      video_id: row.video_id,
      width: row.width,
    })),
  };
}

function main() {
  if (!fs.existsSync(options.sourceDir)) {
    console.error(`No corpus folder at ${options.sourceDir}`);
    console.error('Set KOMAR_SOURCE_DIR or pass --source-dir.');
    process.exit(1);
  }

  const corpus = listCorpus(options.sourceDir);
  console.log(`corpus: ${corpus.documents.length} document(s), ${corpus.videos.length} video(s)`);

  const documentPaths = corpus.documents.map((document) => path.join(options.sourceDir, document.folder, document.fileName));
  const structures = readMetaMany(documentPaths);
  const documentRows = buildDocumentRows(corpus.documents, structures, options.sourceDir);
  const videoRows = buildVideoRows(corpus.videos, documentRows, options.sourceDir);

  const collisions = [
    ...findIdCollisions(documentRows, 'doc_id'),
    ...findIdCollisions(videoRows, 'video_id'),
  ];
  if (collisions.length) {
    console.error('Two files would share a catalog id:');
    for (const collision of collisions) {
      console.error(`  ${collision.id}: ${collision.files.join(' , ')}`);
    }
    process.exit(1);
  }

  const db = openDatabase();
  const counts = diffAgainstCatalog(db, documentRows, videoRows);

  if (!options.dryRun) {
    writeDocumentRows(db, documentRows);
    writeVideoRows(db, videoRows);
    const removed = removeStaleRows(db, documentRows, videoRows);
    if (removed) console.log(`removed ${removed} row(s) that are no longer in the corpus`);
    db.prepare(`
      INSERT INTO catalog_runs (
        source_url, channel, command_json, raw_output_path, row_count,
        inserted_count, updated_count, missing_upload_dates, malformed_rows,
        created_at, kind, not_listed_count, listing_complete, row_count_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), 'live', 0, 1, 'listing_rows')
    `).run(
      'file://' + options.sourceDir,
      KOMAR_SOURCE,
      JSON.stringify(process.argv.slice(1)),
      path.relative(ROOT, MANIFEST_PATH),
      documentRows.length + videoRows.length,
      counts.documentsInserted + counts.videosInserted,
      counts.documentsUpdated + counts.videosUpdated,
      documentRows.filter((row) => row.unreadable).length
    );
  }

  const manifest = buildManifest(documentRows, videoRows, corpus);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify({ counts, manifest: manifest.summary }, null, 2));
  } else {
    console.log(`documents: ${counts.documentsInserted} inserted, ${counts.documentsUpdated} updated, ${counts.documentsUnchanged} unchanged, ${counts.documentsRemoved} removed`);
    console.log(`videos:    ${counts.videosInserted} inserted, ${counts.videosUpdated} updated, ${counts.videosUnchanged} unchanged, ${counts.videosRemoved} removed`);
    console.log('documents by kind:', JSON.stringify(manifest.summary.documents_by_kind));
    console.log('videos by kind:   ', JSON.stringify(manifest.summary.videos_by_kind));
    console.log(`videos with a session date: ${manifest.summary.videos_with_a_session_date} / ${manifest.summary.videos}`);
    console.log(`documents whose filename disagrees with their own date: ${manifest.summary.date_conflicts}`);
    console.log(`total video hours: ${manifest.summary.total_duration_hours}`);
    if (!options.dryRun) console.log(`manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  }

  db.close();
}

if (require.main === module) {
  main();
}

module.exports = {
  CATALOG_VERSION,
  buildDocumentRows,
  buildManifest,
  buildVideoRows,
  diffAgainstCatalog,
  documentIdFor,
  findIdCollisions,
  probeVideo,
  removeStaleRows,
  resolveDocumentDate,
  videoIdFor,
  writeDocumentRows,
  writeVideoRows,
};








