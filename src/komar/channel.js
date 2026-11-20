'use strict';

/**
 * The Komar source's identity.
 *
 * WHAT THIS SOURCE IS
 *
 * Julian Komar publishes a paid membership called MARKET UPDATE Premium on
 * members.julian-komar.com. The corpus this source reads is a folder of
 * MP4s -- screen recordings of his sessions -- and a folder of PDFs --
 * browser prints of the membership site's posts, which carry the session
 * metadata, the chapter list and the "Market Update" summary card.
 *
 * WHY THE SOURCE IS A LOCAL FOLDER AND NOT A WEBSITE
 *
 * The membership is paid. The files in the folder are the only copy, and
 * the folder lives outside this repository on the machine that fetched it.
 * So the folder is the source of record: nothing in this project can
 * re-fetch it, and nothing in this project can regenerate the extracted
 * records from a fresh clone. That is why the derived records are
 * committed (see `docs/komar-source-plan.md`) while the media never is.
 *
 * THE THREE RULES A CHANNEL MODULE ENCODES
 *
 * The project has already been bitten by each of them, so they are stated
 * here rather than rediscovered:
 *
 *   1. Never interpolate a slug into a URL. `@revere` and `@revereasset`
 *      return completely disjoint video-id sets, and an early version of
 *      `fill-dates` stamped 1,582 rows with the wrong one.
 *   2. The logical name is not the handle and not the platform id. None
 *      is derivable from either of the others. This source has no handle
 *      at all: the files carry no video id.
 *   3. The catalog id is namespaced, so it can never collide with another
 *      source's ids. Asym uses `asym_<post_id>`; O'Connell uses
 *      `oconnell_<source_date>[_<seq>]`; this one uses `komar_doc_*` and
 *      `komar_vid_*`.
 *
 * A FIFTH RULE, LEARNED FROM THIS CORPUS
 *
 * The FILENAME IS NOT THE DATE. `komar_20260408.pdf` is named 2026-04-08
 * and its own title says "April 8, 2025 -- Mid-Week Update" -- and its
 * URL says `april-8-2025-...` too. Two independent sources inside the
 * document agree on 2025 and only the filename says 2026. So the chrome
 * date is authoritative and the filename date is a hint, and the catalog
 * records both.
 */

/** The logical source name, as stored in the Komar tables' `source` column. */
const KOMAR_SOURCE = 'komar';

/** The human label, for the dashboard and the reports. */
const KOMAR_LABEL = 'Komar (MARKET UPDATE Premium)';

/** The publisher's own product name. Data, never an identifier. */
const KOMAR_PUBLISHER = 'MARKET UPDATE Premium';

/** The membership site the corpus was printed from. */
const KOMAR_HOST = 'members.julian-komar.com';

/** The id prefix, which namespaces this source inside the catalog. */
const KOMAR_ID_PREFIX = 'komar_';

/**
 * The sub-folder that holds the finished archive.
 *
 * It is read as part of the corpus, NOT skipped. The name says what it
 * holds; it does not say the content is finished, and the root folder
 * holds three videos from 2022 next to the newest ones.
 */
const KOMAR_ARCHIVE_DIR = '_finished';

/**
 * The folder the corpus lives in.
 *
 * It is OUTSIDE the repository, and it is configurable, because the path
 * is a property of the machine that holds the corpus and not of the
 * source. `KOMAR_SOURCE_DIR` overrides the default.
 */
const DEFAULT_SOURCE_DIR = 'D:\\courses_nosync\\julian_komar';

/** The kinds of document the corpus holds. */
const DOCUMENT_KINDS = Object.freeze([
  'report',   // a weekly session's page print
  'post',     // a daily or mid-week post
  'rule',     // a trading-rules page
  'lesson',   // a trading-lessons page
  'summary',  // a machine-written summary of a session
  'deck',     // a slide deck
  'unknown',
]);

/** The kinds of video the corpus holds. */
const VIDEO_KINDS = Object.freeze([
  'weekend',  // a weekly session, in parts
  'midweek',  // a mid-week update
  'daily',    // a daily update
  'webinar',  // a member webinar
  'lesson',   // everything else: EPS, audio lessons, screeners, how-tos
  'unknown',
]);

/**
 * Where the corpus is, as configured.
 *
 * @param {object} [options]
 * @param {string} [options.sourceDir]
 * @returns {string}
 */
function komarSourceDir(options = {}) {
  const configured = options.sourceDir || process.env.KOMAR_SOURCE_DIR || DEFAULT_SOURCE_DIR;
  return String(configured).trim();
}

/**
 * Slugify a fragment of a name into something safe for an id.
 *
 * The id is a database key and a filename stem, so it may not carry a
 * path separator, a space or a character that differs only by case on
 * some filesystems.
 *
 * @param {string} value
 * @returns {string}
 */
function komarSlug(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The catalog id for one document.
 *
 * The id carries the KIND, because the kind decides what the document is
 * read as, and the corpus holds two documents whose names differ only by
 * a suffix. It is namespaced twice over -- `komar_doc_<kind>_<key>` -- so
 * a document id can never collide with a video id.
 *
 * @param {string} kind - one of DOCUMENT_KINDS
 * @param {string} key - the date, the slug, or both
 * @returns {string} e.g. `komar_doc_report_20260509`
 * @throws when the kind is not one of ours
 */
function komarDocId(kind, key) {
  const type = String(kind == null ? '' : kind).trim().toLowerCase();
  if (!DOCUMENT_KINDS.includes(type)) {
    throw new Error(`Unknown Komar document kind: "${kind}"`);
  }
  const rest = komarSlug(key);
  if (!rest) {
    throw new Error('A Komar document id needs a key');
  }
  return `${KOMAR_ID_PREFIX}doc_${type}_${rest}`;
}

/**
 * The catalog id for one video.
 *
 * @param {string} kind - one of VIDEO_KINDS
 * @param {string} key - the report number, the date, or the slug
 * @returns {string} e.g. `komar_vid_weekend_226_stocks_analysis`
 * @throws when the kind is not one of ours
 */
function komarVideoId(kind, key) {
  const type = String(kind == null ? '' : kind).trim().toLowerCase();
  if (!VIDEO_KINDS.includes(type)) {
    throw new Error(`Unknown Komar video kind: "${kind}"`);
  }
  const rest = komarSlug(key);
  if (!rest) {
    throw new Error('A Komar video id needs a key');
  }
  return `${KOMAR_ID_PREFIX}vid_${type}_${rest}`;
}

/**
 * The kind and key encoded in a catalog id.
 *
 * @param {string} id
 * @returns {{entity: 'doc'|'vid', kind: string, key: string}|null} null when
 *   the id is not one of ours.
 */
function parseKomarId(id) {
  const raw = String(id == null ? '' : id).trim();
  if (!raw.startsWith(KOMAR_ID_PREFIX)) return null;
  const rest = raw.slice(KOMAR_ID_PREFIX.length);
  const match = /^(doc|vid)_([a-z]+)_(.+)$/.exec(rest);
  if (!match) return null;
  return { entity: match[1], key: match[3], kind: match[2] };
}

/**
 * Does this URL name the membership site?
 *
 * The host is compared as a HOST, not as a substring. A substring test
 * accepts "https://members.julian-komar.com.evil.example/x", which is
 * not the membership site -- and a source module whose whole job is to
 * recognise its own site is the last place that should be sloppy about
 * it.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isKomarSourceUrl(url) {
  const value = String(url || '').trim().toLowerCase();
  if (!value) return false;
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    // Not a URL. Fall back to the host-ish part of the string, so a
    // truncated print still matches -- the corpus's URLs are cut short
    // by the browser print, but not in the middle of the host.
    const match = /^(?:[a-z]+:\/\/)?([^/?#]+)/.exec(value);
    host = match ? match[1] : '';
  }
  if (!host) return false;
  return host === KOMAR_HOST || host.endsWith(`.${KOMAR_HOST}`);
}

module.exports = {
  DEFAULT_SOURCE_DIR,
  DOCUMENT_KINDS,
  KOMAR_ARCHIVE_DIR,
  KOMAR_HOST,
  KOMAR_ID_PREFIX,
  KOMAR_LABEL,
  KOMAR_PUBLISHER,
  KOMAR_SOURCE,
  VIDEO_KINDS,
  isKomarSourceUrl,
  komarDocId,
  komarSlug,
  komarSourceDir,
  komarVideoId,
  parseKomarId,
};


