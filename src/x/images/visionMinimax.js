'use strict';

/**
 * The MiniMax vision reader for X screenshots -- the DEFAULT provider.
 *
 * WHY MINIMAX (the user's decision, 2026-11-21)
 *
 * The Claude API account could not be topped up without an identity check,
 * and the user chose MiniMax instead. MiniMax-M3 and MiniMax-M3.1-Flash take
 * images through MiniMax's OpenAI-compatible Chat Completions
 * (`image_url` content parts, a base64 data URL is fine), and they cost a
 * small fraction of the Claude default. The older MiniMax-M2.x models are
 * TEXT-ONLY and silently ignore an image -- so they are not offered here.
 *
 * WHAT IS THE SAME AS THE CLAUDE READER (src/x/images/vision.js)
 *
 * The instructions (SYSTEM_PROMPT), the reading's shape (READING_SCHEMA),
 * the image preparation (at most 1568 px) and everything downstream: every
 * position row is checked against the image's own Tesseract OCR
 * (src/x/images/crossCheck.js) before it can count. The model is a second
 * reader, not an oracle -- whichever model it is.
 *
 * WHAT IS DIFFERENT
 *
 * - MiniMax does not document schema-constrained output for this endpoint,
 *   so the schema is GIVEN in the instructions and the answer is VALIDATED
 *   here (`validateReading`): a wrong type or an unknown image class is an
 *   error, never a half-read row. A missing text field reads as '' -- the
 *   instructions themselves say "an empty string for any field that is not
 *   printed" -- and an unknown key is dropped.
 * - The M3 models can think aloud: a `<think>…</think>` block and code
 *   fences are stripped before the JSON is parsed.
 * - MiniMax can answer HTTP 200 with an error in `base_resp`
 *   (1004 authentication, 1008 insufficient balance, 1002 rate limit); that
 *   is turned into an error with the matching HTTP status, so the run stops
 *   on it exactly as it stops on a 401 or a 429.
 *
 * CREDENTIALS
 *
 * `MINIMAX_API_KEY` from .env; `MINIMAX_BASE_URL` only for an account on the
 * China platform (https://api.minimaxi.com/v1) -- a key works only on its
 * own region's host. The key lives in a closure, never on an object that
 * could be logged, and every error text is redacted before it is shown.
 */

const { READING_SCHEMA, SYSTEM_PROMPT, prepareImage } = require('./vision');

const PROVIDER = 'minimax';
const VISION_VERSION = 'x-vision-1+minimax-1';
const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';
const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const KEY_ENV = ['MINIMAX_API_KEY'];

/**
 * Prices per million tokens, standard tier (MiniMax's pricing page as
 * reported 2026-11-17; M3's long-context tier above 512K does not apply to
 * one image). Configuration-like: re-check before a big run.
 */
const PRICES = {
  'MiniMax-M3': { input: 0.30, output: 1.20, cacheRead: 0.06, cacheWrite: 0.30 },
  'MiniMax-M3.1-Flash': { input: 0.15, output: 0.60, cacheRead: 0.015, cacheWrite: 0.15 },
};

/** The first budget estimate, before a real reading is observed: a high-detail image plus thinking. */
const FIRST_ESTIMATE_TOKENS = { input: 15000, output: 3000 };

const REQUEST_TIMEOUT_MS = 120000;

const INSTRUCTIONS = [
  SYSTEM_PROMPT,
  '',
  'Answer with ONE JSON object and nothing else -- no prose, no code fences.',
  'It must match this JSON Schema exactly (every listed key present):',
  JSON.stringify(READING_SCHEMA),
].join('\n');

/** MiniMax's own error codes -> the HTTP status the run already acts on. */
const BASE_RESP_STATUS = {
  1001: 504, // timeout
  1002: 429, // rate limit
  1004: 401, // authentication failed
  1008: 402, // insufficient balance
  1013: 500, // internal error
  1027: 400, // output content flagged
  1039: 429, // token rate limit
  2013: 400, // invalid parameters
};

/**
 * Remove a credential from a text that is about to be shown.
 *
 * @param {string} text
 * @param {string} [key]
 * @returns {string}
 */
function redact(text, key) {
  let out = String(text || '').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
  if (key && key.length >= 8) out = out.split(key).join('[redacted]');
  return out;
}

/**
 * Build the Chat Completions body.
 *
 * @param {object} input
 * @param {string} [input.model]
 * @param {string} input.imageBase64
 * @param {string} input.mediaType
 * @param {string} [input.postText] - context only
 * @returns {object}
 */
function buildRequest(input) {
  const context = String(input.postText || '').slice(0, 500);
  return {
    model: input.model || DEFAULT_MODEL,
    // MiniMax's temperature range is (0, 1]; a low value keeps the copy literal.
    temperature: 0.1,
    max_tokens: 16000,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${input.mediaType};base64,${input.imageBase64}`, detail: 'high' } },
          {
            type: 'text',
            text: context
              ? `The post this image was attached to said (context only -- report only what the image shows):\n${context}`
              : 'Read this image.',
          },
        ],
      },
    ],
  };
}

/**
 * The JSON object in a model's answer: thinking and fences removed.
 *
 * @param {string} text
 * @returns {object}
 */
function extractJson(text) {
  let body = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fenced) body = fenced[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(body.slice(start, end + 1));
}

function asText(value, field, errors) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') {
    errors.push(`${field} is not a string`);
    return '';
  }
  return value;
}

/**
 * Check a reading against READING_SCHEMA. Unknown keys are dropped; a
 * missing text field is '' (the instructions' own rule); a wrong type or
 * an unknown enum value is an error.
 *
 * @param {*} raw
 * @returns {{ok: boolean, reading: object|null, errors: string[]}}
 */
function validateReading(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reading: null, errors: ['not an object'] };
  const classes = READING_SCHEMA.properties.image_class.enum;
  const sides = READING_SCHEMA.properties.positions.items.properties.side.enum;
  const rowFields = READING_SCHEMA.properties.positions.items.required.filter((f) => f !== 'side');
  if (!classes.includes(raw.image_class)) errors.push(`image_class ${JSON.stringify(raw.image_class)} is not one of the classes`);
  if (raw.positions !== undefined && !Array.isArray(raw.positions)) errors.push('positions is not an array');
  if (raw.tickers_visible !== undefined && !Array.isArray(raw.tickers_visible)) errors.push('tickers_visible is not an array');
  if (raw.is_complete_list !== undefined && typeof raw.is_complete_list !== 'boolean') errors.push('is_complete_list is not a boolean');

  const positions = [];
  for (const [i, row] of (Array.isArray(raw.positions) ? raw.positions : []).entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`positions[${i}] is not an object`);
      continue;
    }
    const clean = {};
    for (const field of rowFields) clean[field] = asText(row[field], `positions[${i}].${field}`, errors);
    const side = row.side === undefined || row.side === '' ? 'unknown' : row.side;
    if (!sides.includes(side)) errors.push(`positions[${i}].side ${JSON.stringify(row.side)} is not long, short or unknown`);
    clean.side = sides.includes(side) ? side : 'unknown';
    positions.push(clean);
  }
  const reading = {
    image_class: raw.image_class,
    summary: asText(raw.summary, 'summary', errors),
    account_label: asText(raw.account_label, 'account_label', errors),
    is_complete_list: raw.is_complete_list === true,
    legend_ticker: asText(raw.legend_ticker, 'legend_ticker', errors),
    legend_timeframe: asText(raw.legend_timeframe, 'legend_timeframe', errors),
    positions,
    tickers_visible: (Array.isArray(raw.tickers_visible) ? raw.tickers_visible : [])
      .filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
  };
  return errors.length ? { ok: false, reading: null, errors } : { ok: true, reading, errors: [] };
}

/**
 * The usage, in the shape the run stores (the Claude field names).
 *
 * @param {object} usage
 * @returns {object}
 */
function normalizeUsage(usage) {
  const u = usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
    output_tokens: u.completion_tokens || 0,
    cache_read_input_tokens: cached,
  };
}

/**
 * Turn a Chat Completions response into a reading.
 *
 * @param {object} response
 * @returns {{status: 'ok'|'refused'|'error', reading: object|null, detail: string, usage: object, model: string}}
 */
function parseResponse(response) {
  const usage = normalizeUsage(response && response.usage);
  const model = (response && response.model) || '';
  if (!response) return { status: 'error', reading: null, detail: 'no response', usage, model };
  const choice = Array.isArray(response.choices) ? response.choices[0] : null;
  if (!choice) return { status: 'error', reading: null, detail: 'no choices in the response', usage, model };
  if (choice.finish_reason === 'content_filter') return { status: 'refused', reading: null, detail: 'content_filter', usage, model };
  if (choice.finish_reason === 'length') return { status: 'error', reading: null, detail: 'max_tokens', usage, model };
  const content = choice.message && choice.message.content;
  const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : String(content || '');
  let raw;
  try {
    raw = extractJson(text);
  } catch (error) {
    return { status: 'error', reading: null, detail: `unparseable output: ${error.message}`, usage, model };
  }
  const checked = validateReading(raw);
  if (!checked.ok) return { status: 'error', reading: null, detail: `schema: ${checked.errors.slice(0, 3).join('; ')}`, usage, model };
  return { status: 'ok', reading: checked.reading, detail: '', usage, model };
}

/**
 * The USD cost of a usage (normalized shape).
 *
 * @param {object} usage
 * @param {string} model
 * @returns {number}
 */
function costOf(usage, model) {
  const price = PRICES[model] || PRICES[DEFAULT_MODEL];
  const cost = ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output
    + (usage.cache_read_input_tokens || 0) * price.cacheRead) / 1e6;
  return Number(cost.toFixed(6));
}

/**
 * Create the client. The key stays in this closure.
 *
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.fetchImpl]
 * @returns {{baseUrl: string, post: Function}}
 */
function createClient(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const key = String(env.MINIMAX_API_KEY || '').trim();
  if (!key) throw new Error('MINIMAX_API_KEY is not set. Put it in .env (MINIMAX_API_KEY=...)');
  const baseUrl = String(env.MINIMAX_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new Error('MINIMAX_BASE_URL must be an https:// URL');

  async function post(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const failure = new Error(redact(`MiniMax request failed: ${error.message}`, key));
      failure.status = 0;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      const failure = new Error(redact(`MiniMax HTTP ${res.status}: ${text.slice(0, 300)}`, key));
      failure.status = res.status;
      throw failure;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      const failure = new Error('MiniMax returned a body that is not JSON');
      failure.status = 502;
      throw failure;
    }
    const base = json.base_resp;
    if (base && Number(base.status_code) !== 0 && base.status_code !== undefined) {
      const code = Number(base.status_code);
      const failure = new Error(redact(`MiniMax error ${code}: ${String(base.status_msg || '').slice(0, 200)}`, key));
      failure.status = BASE_RESP_STATUS[code] || 400;
      failure.minimaxCode = code;
      throw failure;
    }
    return json;
  }

  return { baseUrl, post };
}

/**
 * Read one image.
 *
 * @param {object} input
 * @param {{post: Function}} input.client
 * @param {string} input.file
 * @param {string} [input.model]
 * @param {string} [input.postText]
 * @returns {Promise<object>} parseResponse() plus cost
 */
async function readImage(input) {
  const model = input.model || DEFAULT_MODEL;
  const image = await prepareImage(input.file);
  const response = await input.client.post(buildRequest({ ...image, model, postText: input.postText }));
  const parsed = parseResponse(response);
  const servedBy = PRICES[parsed.model] ? parsed.model : model;
  return { ...parsed, cost: costOf(parsed.usage, servedBy) };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  FIRST_ESTIMATE_TOKENS,
  KEY_ENV,
  PRICES,
  PROVIDER,
  VISION_VERSION,
  buildRequest,
  costOf,
  createClient,
  extractJson,
  parseResponse,
  readImage,
  redact,
  validateReading,
};
