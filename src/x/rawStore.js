'use strict';

/**
 * Raw captures, verbatim: data/x_pipeline/raw/<run_tag>/... (untracked).
 *
 * Every route saves what it received BEFORE normalizing it, wrapped in one
 * envelope, so the normalizers can be improved and re-run over old captures
 * without fetching (or paying) again:
 *
 *   { "x_capture": 1, "route": "api_v2" | "web_graphql" | "web_dom" | "agent_jsonl",
 *     "operation": "search_all" | "SearchTimeline" | ..., "url": "...",
 *     "status": 200, "fetched_at": "...", "body": <the response> }
 *
 * The URL is stored WITHOUT credentials -- the API's bearer token travels in
 * a header, never in the URL, and the envelope never holds a header.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { normalizeApiV2Page } = require('./normalizeApiV2');
const { normalizeGraphqlResponse } = require('./normalizeGraphql');
const { normalizeAgentRecord, normalizeDomPost } = require('./normalizeDom');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_RAW_ROOT = path.join(ROOT, 'data', 'x_pipeline', 'raw');

const ROUTES = ['api_v2', 'web_graphql', 'web_dom', 'agent_jsonl'];

/**
 * A run tag: sortable, unique enough, filesystem-safe.
 *
 * @param {string} route
 * @param {string} handle
 * @returns {string}
 */
function makeRunTag(route, handle) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}_${route}_${String(handle || 'x').replace(/[^a-z0-9_]/gi, '')}`;
}

/**
 * Save one envelope (gzipped).
 *
 * @param {string} dir
 * @param {string} name - file stem
 * @param {object} envelope
 * @returns {string} the file written
 */
function saveRaw(dir, name, envelope) {
  if (!ROUTES.includes(envelope.route)) throw new Error(`unknown route ${envelope.route}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json.gz`);
  const body = JSON.stringify({ x_capture: 1, ...envelope });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(body, 'utf8')));
  return file;
}

/**
 * Read a raw file: an envelope (.json / .json.gz) or agent JSONL (.jsonl).
 *
 * @param {string} file
 * @returns {Array<object>} envelopes
 */
function readRaw(file) {
  const buffer = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  if (file.endsWith('.jsonl')) {
    return text.split('\n').filter((line) => line.trim()).map((line, index) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1} is not JSON: ${error.message}`);
      }
      return parsed && parsed.x_capture ? parsed : { x_capture: 1, route: 'agent_jsonl', body: parsed, fetched_at: '' };
    });
  }
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item) => {
    if (item && item.x_capture) return item;
    return { x_capture: 1, route: detectRoute(item), body: item, fetched_at: '' };
  });
}

/**
 * Guess the route of an unwrapped payload.
 *
 * @param {object} body
 * @returns {string}
 */
function detectRoute(body) {
  if (body && Array.isArray(body.data) && (body.includes || body.meta)) return 'api_v2';
  if (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return 'web_graphql';
  return 'agent_jsonl';
}

/**
 * Every raw file under a directory, oldest first.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listRawFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|json\.gz|jsonl)$/.test(entry.name)) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * Normalize one envelope.
 *
 * @param {object} envelope
 * @param {object} [options]
 * @param {Map<string, string>} [options.knownUsers] - handle -> user id (DOM / agent records)
 * @returns {{records: object[], rejected: Array<{reason: string}>}}
 */
function normalizeEnvelope(envelope, options = {}) {
  const fetchedAt = envelope.fetched_at || new Date().toISOString();
  const knownUsers = options.knownUsers || new Map();
  if (envelope.route === 'api_v2') {
    const { records, errors } = normalizeApiV2Page(envelope.body, { fetchedAt });
    return { records, rejected: errors.map((error) => ({ reason: `api_error: ${error.title}`, post_id: error.post_id })) };
  }
  if (envelope.route === 'web_graphql') {
    const { records, unavailable } = normalizeGraphqlResponse(envelope.body, { fetchedAt });
    return { records, rejected: unavailable.map((item) => ({ reason: `unavailable: ${item.reason}` })) };
  }
  if (envelope.route === 'web_dom') {
    const posts = Array.isArray(envelope.body) ? envelope.body : [envelope.body];
    const records = [];
    const rejected = [];
    for (const raw of posts) {
      const { record, reason } = normalizeDomPost(raw, { knownUsers, fetchedAt });
      if (record) records.push(record);
      else rejected.push({ reason });
    }
    return { records, rejected };
  }
  const items = Array.isArray(envelope.body) ? envelope.body : [envelope.body];
  const records = [];
  const rejected = [];
  for (const raw of items) {
    const { record, reason } = normalizeAgentRecord(raw, { knownUsers, fetchedAt });
    if (record) records.push(record);
    else rejected.push({ reason });
  }
  return { records, rejected };
}

module.exports = {
  DEFAULT_RAW_ROOT,
  ROUTES,
  detectRoute,
  listRawFiles,
  makeRunTag,
  normalizeEnvelope,
  readRaw,
  saveRaw,
};
