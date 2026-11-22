'use strict';

/**
 * The X session, taken from a browser where the user is ALREADY logged in.
 *
 * WHY NOT A LOGIN
 *
 * The first live attempt (2026-11-21) opened the crawler's own browser,
 * the user typed their credentials, and X answered "We've temporarily
 * limited your login. Please try again later." -- a login from a browser
 * X sees as new and automated. The user was at the same moment logged in
 * to X in their own Firefox window. So the crawler does not log in at all:
 * it carries over that window's SESSION COOKIES.
 *
 * Two cookies are the session:
 *
 *   auth_token   who you are (HttpOnly; full access to the account)
 *   ct0          the CSRF token the web app echoes in every request
 *
 * They come from `.env` (`X_AUTH_TOKEN`, `X_CT0`), pasted there by the user,
 * or from a Cookie-Editor JSON export. Either way:
 *
 *   - a value is NEVER printed, logged or put in an error message -- only
 *     the cookie NAMES are;
 *   - an export file inside the repository is refused, exactly as the
 *     browser profile is (src/x/browser/capture.js): it holds the session.
 */

const fs = require('node:fs');
const path = require('node:path');

const { isInsideRepo } = require('./capture');

/** The cookies without which there is no session. */
const REQUIRED_COOKIES = ['auth_token', 'ct0'];

/** The .env keys the two cookies are read from. */
const ENV_KEYS = { auth_token: 'X_AUTH_TOKEN', ct0: 'X_CT0' };

/** The domains whose cookies belong to the X session. */
const X_DOMAINS = ['x.com', 'twitter.com'];

const ONE_YEAR_S = 365 * 24 * 3600;

/**
 * Clean a pasted cookie value: trim, drop matched quotes, and drop a
 * leading "name=" (a value copied together with its name).
 *
 * @param {string} name
 * @param {*} raw
 * @returns {string}
 */
function cleanValue(name, raw) {
  let value = String(raw == null ? '' : raw).trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
  if (quoted) value = quoted[2].trim();
  if (value.toLowerCase().startsWith(`${name.toLowerCase()}=`)) value = value.slice(name.length + 1).trim();
  return value;
}

/**
 * Is this a plausible cookie value? Cookie values are a token alphabet;
 * a space, a semicolon or a quote means something else was pasted (a
 * whole cookie header, a note), and sending it would only fail later.
 *
 * @param {string} value
 * @returns {boolean}
 */
function plausibleValue(value) {
  return /^[A-Za-z0-9%._~+/=-]{8,}$/.test(value);
}

function isXDomain(domain) {
  const host = String(domain || '').replace(/^\./, '').toLowerCase();
  return X_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Cookie-Editor's sameSite names -> Playwright's.
 *
 * @param {*} value
 * @returns {'None'|'Lax'|'Strict'}
 */
function mapSameSite(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'no_restriction' || v === 'none') return 'None';
  if (v === 'strict') return 'Strict';
  return 'Lax';
}

/**
 * The session cookies from the environment (.env).
 *
 * @param {object} [env]
 * @param {object} [options]
 * @param {number} [options.nowS] - for tests
 * @returns {{cookies: object[], missing: string[], malformed: string[]}}
 */
function sessionCookiesFromEnv(env = process.env, options = {}) {
  const nowS = options.nowS || Math.floor(Date.now() / 1000);
  const cookies = [];
  const missing = [];
  const malformed = [];
  for (const name of REQUIRED_COOKIES) {
    const value = cleanValue(name, env[ENV_KEYS[name]]);
    if (!value) {
      missing.push(name);
      continue;
    }
    if (!plausibleValue(value)) {
      malformed.push(name);
      continue;
    }
    cookies.push({
      name,
      value,
      domain: '.x.com',
      path: '/',
      // A persistent profile keeps a cookie only if it expires; X's own
      // auth_token lasts years, so a year is the conservative choice.
      expires: nowS + ONE_YEAR_S,
      httpOnly: name === 'auth_token',
      secure: true,
      sameSite: name === 'auth_token' ? 'None' : 'Lax',
    });
  }
  return { cookies, missing, malformed };
}

/**
 * The X cookies of a Cookie-Editor JSON export, in Playwright's shape.
 *
 * @param {Array<object>} exported
 * @returns {{cookies: object[], missing: string[], malformed: string[]}}
 */
function cookiesFromEditorExport(exported) {
  if (!Array.isArray(exported)) throw new Error('the cookie export is not a JSON array (export as JSON from Cookie-Editor)');
  const cookies = [];
  const malformed = [];
  for (const item of exported) {
    if (!item || !item.name || !isXDomain(item.domain)) continue;
    const value = cleanValue(item.name, item.value);
    if (REQUIRED_COOKIES.includes(item.name) && !plausibleValue(value)) {
      malformed.push(item.name);
      continue;
    }
    const sameSite = mapSameSite(item.sameSite);
    cookies.push({
      name: String(item.name),
      value,
      domain: item.hostOnly ? String(item.domain).replace(/^\./, '') : `.${String(item.domain).replace(/^\./, '')}`,
      path: item.path || '/',
      expires: Number.isFinite(item.expirationDate) && !item.session ? Math.floor(item.expirationDate) : -1,
      httpOnly: Boolean(item.httpOnly),
      // Chromium refuses SameSite=None without Secure.
      secure: sameSite === 'None' ? true : Boolean(item.secure),
      sameSite,
    });
  }
  const names = new Set(cookies.map((c) => c.name));
  const missing = REQUIRED_COOKIES.filter((name) => !names.has(name) && !malformed.includes(name));
  return { cookies, missing, malformed };
}

/**
 * Read a Cookie-Editor export file (outside the repository only).
 *
 * @param {string} file
 */
function readCookieExport(file) {
  const resolved = path.resolve(file);
  if (isInsideRepo(resolved)) {
    throw new Error(`the cookie file ${resolved} is inside the repository; it holds your X session. `
      + 'Move it outside the repository (and delete it after the import).');
  }
  return cookiesFromEditorExport(JSON.parse(fs.readFileSync(resolved, 'utf8')));
}

/**
 * The human message for a cookie set that cannot be used. Names only.
 *
 * @param {{missing: string[], malformed: string[]}} result
 * @returns {string} '' when the set is usable
 */
function describeProblem(result) {
  const parts = [];
  if (result.missing.length) {
    parts.push(`missing: ${result.missing.map((n) => `${n} (${ENV_KEYS[n]} in .env)`).join(', ')}`);
  }
  if (result.malformed.length) {
    parts.push(`not a cookie value: ${result.malformed.map((n) => `${n} (${ENV_KEYS[n]})`).join(', ')}`
      + ' -- paste only the Value column, without the name, spaces or quotes');
  }
  return parts.join('; ');
}

/**
 * Put the session cookies into a browser context when they are not there
 * yet, or when the ones there differ (the .env is the explicit answer).
 *
 * @param {object} context - a Playwright BrowserContext
 * @param {object[]} cookies - from sessionCookiesFromEnv / readCookieExport
 * @returns {Promise<{injected: boolean, reason: string}>}
 */
async function ensureSessionCookies(context, cookies) {
  if (!cookies || !cookies.length) return { injected: false, reason: 'no cookies supplied' };
  const present = await context.cookies('https://x.com');
  const byName = new Map(present.map((c) => [c.name, c.value]));
  const differs = REQUIRED_COOKIES.some((name) => {
    const wanted = cookies.find((c) => c.name === name);
    return wanted && byName.get(name) !== wanted.value;
  });
  if (!differs) return { injected: false, reason: 'the profile already holds this session' };
  await context.addCookies(cookies);
  return { injected: true, reason: 'session cookies added to the profile' };
}

module.exports = {
  ENV_KEYS,
  REQUIRED_COOKIES,
  cleanValue,
  cookiesFromEditorExport,
  describeProblem,
  ensureSessionCookies,
  mapSameSite,
  plausibleValue,
  readCookieExport,
  sessionCookiesFromEnv,
};
