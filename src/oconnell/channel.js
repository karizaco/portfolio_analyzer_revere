'use strict';

/**
 * The O'Connell source's identity.
 *
 * WHAT THIS SOURCE IS
 *
 * Andrew O'Connell, CFA, FRM publishes a paid newsletter ("Market Analysis &
 * Watchlist" on trading days, "Weekend Watchlist" on Saturdays, plus
 * research notes and one-off specials) on Substack. The corpus this source
 * reads is a folder of PDFs -- "Microsoft Print to PDF" renders of those
 * posts -- plus a set of position-log screenshots that sit beside them.
 *
 * WHY THE SOURCE IS A LOCAL FOLDER AND NOT A WEBSITE
 *
 * The posts are PAID. The PDFs in the folder are the only copy of them, and
 * the folder lives outside this repository on the machine that fetched it.
 * So the folder is the source of record: nothing in this project can
 * re-fetch it, and nothing in this project can regenerate the extracted
 * records from a fresh clone. That is why the extracted records are
 * committed (see `docs/oconnell-source-plan.md`) while the PDFs never are.
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
 *      is derivable from either of the others.
 *   3. The catalog id is namespaced, so it can never collide with another
 *      source's ids. Asym uses `asym_<post_id>`; this one uses
 *      `oconnell_<source_date>[_<seq>]`.
 *
 * A FOURTH RULE, LEARNED FROM THIS SOURCE
 *
 * The name "Pristine" is the PUBLISHER's word, and there is an unrelated
 * company called Pristine. So it is not used as an identifier anywhere:
 * the logical name is `oconnell`, and "Pristine" appears only inside the
 * DATA (the position log's own title, the screener's name), where it is
 * what the document actually says.
 */

/** The logical source name, as stored in `oconnell_issues.source`. */
const OCONNELL_SOURCE = 'oconnell';

/** The human label, for the dashboard and the reports. */
const OCONNELL_LABEL = "O'Connell (Pristine Capital)";

/** The publisher's own product name. Data, never an identifier. */
const OCONNELL_PUBLISHER = 'Pristine Capital';

/**
 * The publication's current host, and the host it used before.
 *
 * The corpus spans both: the 2024-2025 issues carry
 * `pristinecapital.substack.com` and the 2026 issues carry
 * `pristinecapital.net`. The URL is read out of each PDF's own chrome,
 * so both are known; this list exists so a document whose chrome is
 * unreadable can still be recognised.
 */
const OCONNELL_HOSTS = ['pristinecapital.net', 'pristinecapital.substack.com'];

/**
 * The id prefix, which namespaces this source inside the catalog.
 */
const OCONNELL_ID_PREFIX = 'oconnell_';

/**
 * The folder the corpus lives in.
 *
 * It is OUTSIDE the repository, and it is configurable, because the path
 * is a property of the machine that holds the corpus and not of the
 * source. `OCONNELL_SOURCE_DIR` overrides the default.
 *
 * The default is a WINDOWS path because that is where the corpus was
 * collected; a machine that holds it elsewhere sets the environment
 * variable, and nothing in the code has to change.
 */
const DEFAULT_SOURCE_DIR = 'D:\\trading_books\\andrew_oconnell_Pristine_capital';

/**
 * Where the corpus is, as configured.
 *
 * @param {object} [options]
 * @param {string} [options.sourceDir]
 * @returns {string}
 */
function oconnellSourceDir(options = {}) {
  const configured = options.sourceDir || process.env.OCONNELL_SOURCE_DIR || DEFAULT_SOURCE_DIR;
  return String(configured).trim();
}

/**
 * The catalog id for one document.
 *
 * The id is the SOURCE DATE the document is about, which is the date in
 * its FILENAME -- not the date it was published. The two are different:
 * the 20261112 issue was published on 2026-11-13 at 10:20, because the
 * newsletter goes out the morning after the session it covers.
 *
 * The date is the key the whole corpus is read by, so the publish date is
 * carried as a separate field rather than folded into the id.
 *
 * A DISCRIMINATOR follows the date when the folder holds more than one
 * document for it. It is whatever follows the date in the FILENAME, and
 * it has to be part of the id: the corpus holds both `20260407.pdf` and
 * `20260407_grand_finale.pdf`, and both of them are about 2026-04-07,
 * so a date-only id would silently overwrite one of them with the
 * other. The corpus has two such pairs and 300 documents in 295 dates.
 *
 * @param {string} sourceDate - YYYYMMDD
 * @param {number|string} [discriminator] - what follows the date in the filename
 * @returns {string} e.g. `oconnell_20261112`, `oconnell_20260407_grand_finale`
 */
function oconnellDocId(sourceDate, discriminator) {
  const date = String(sourceDate == null ? '' : sourceDate).trim();
  if (!/^\d{8}$/.test(date)) {
    throw new Error(`An O'Connell source date must be YYYYMMDD, got "${sourceDate}"`);
  }
  const suffix = String(discriminator == null ? '' : discriminator).trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return suffix ? `${OCONNELL_ID_PREFIX}${date}_${suffix}` : `${OCONNELL_ID_PREFIX}${date}`;
}

/**
 * The source date and the discriminator encoded in a catalog id.
 *
 * @param {string} docId
 * @returns {{sourceDate: string, discriminator: string}|null} null when the id
 *   is not one of ours.
 */
function parseOconnellDocId(docId) {
  const raw = String(docId == null ? '' : docId).trim();
  if (!raw.startsWith(OCONNELL_ID_PREFIX)) return null;
  const rest = raw.slice(OCONNELL_ID_PREFIX.length);
  const match = /^(\d{8})(?:_(.+))?$/.exec(rest);
  if (!match) return null;
  return { discriminator: match[2] || '', sourceDate: match[1] };
}

/**
 * Does this URL name the publication?
 *
 * @param {string} url
 * @returns {boolean}
 */
function isOconnellSourceUrl(url) {
  const lowered = String(url || '').toLowerCase();
  return OCONNELL_HOSTS.some((host) => lowered.includes(host));
}

/**
 * The post URL from a document's own chrome, when it carries one.
 *
 * @param {string} url
 * @returns {string} '' when the URL is not ours
 */
function oconnellPostUrl(url) {
  const raw = String(url || '').trim();
  if (!isOconnellSourceUrl(raw)) return '';
  return raw;
}

module.exports = {
  DEFAULT_SOURCE_DIR,
  OCONNELL_HOSTS,
  OCONNELL_ID_PREFIX,
  OCONNELL_LABEL,
  OCONNELL_PUBLISHER,
  OCONNELL_SOURCE,
  isOconnellSourceUrl,
  oconnellDocId,
  oconnellPostUrl,
  oconnellSourceDir,
  parseOconnellDocId,
};
