'use strict';

/**
 * The Claude vision reader for X screenshots (enabled by the user,
 * 2026-11-20).
 *
 * One Messages API request per image, with STRUCTURED OUTPUT: the answer
 * must match a JSON schema (`output_config.format`), so it parses or the row
 * is an error -- never a half-read string. The reader reports:
 *
 *   image_class   portfolio | positions_list | watchlist | fill_confirmation
 *                 | chart | text_screenshot | other
 *   positions     one row per holding, every number COPIED AS PRINTED
 *   legend        a chart's ticker and timeframe
 *
 * WHY "AS PRINTED"
 *
 * The rows are verified against the image's own OCR words
 * (src/x/images/crossCheck.js). A number the model normalised ("12.40" for
 * a printed "12.4") is harder to find in the OCR; a number copied as printed
 * is a substring test.
 *
 * COST CONTROLS (src/x/images/runImages.js): one reading per (image md5,
 * reader version, model), stored in x_image_readings and never paid for
 * twice; a USD budget that stops before the next image would cross it; the
 * stable instructions are a prompt-cached prefix; images are sent at most
 * 1568 px on the long side.
 *
 * The model is `claude-opus-5-5` unless you choose another (--model).
 * Server-side refusal fallbacks are ON (`fallbacks: "default"`), so a policy
 * decline on one model is retried on another inside the same call; a
 * request that is still refused is recorded as `refused`, not retried.
 */

const PROVIDER = 'anthropic';
const VISION_VERSION = 'x-vision-1';
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_LONG_EDGE = 1568;
const KEY_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
/** The first budget estimate, before a real reading is observed. */
const FIRST_ESTIMATE_TOKENS = { input: 2500, output: 1500 };

/** Prices per million tokens, from the Claude model table (cached 2026-11-03). Configuration-like; re-check before big runs. */
const PRICES = {
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

const TEXT = { type: 'string' };

const POSITION_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['ticker', 'side', 'weight_pct_text', 'market_value_text', 'shares_text', 'avg_cost_text', 'gain_pct_text', 'row_text'],
  properties: {
    ticker: TEXT,
    side: { type: 'string', enum: ['long', 'short', 'unknown'] },
    weight_pct_text: TEXT,
    market_value_text: TEXT,
    shares_text: TEXT,
    avg_cost_text: TEXT,
    gain_pct_text: TEXT,
    row_text: TEXT,
  },
};

const READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['image_class', 'summary', 'account_label', 'is_complete_list', 'legend_ticker', 'legend_timeframe',
    'positions', 'tickers_visible'],
  properties: {
    image_class: {
      type: 'string',
      enum: ['portfolio', 'positions_list', 'watchlist', 'fill_confirmation', 'chart', 'text_screenshot', 'other'],
    },
    summary: TEXT,
    account_label: TEXT,
    is_complete_list: { type: 'boolean' },
    legend_ticker: TEXT,
    legend_timeframe: TEXT,
    positions: { type: 'array', items: POSITION_ROW },
    tickers_visible: { type: 'array', items: TEXT },
  },
};

const SYSTEM_PROMPT = [
  'You read screenshots that traders post on X (Twitter) and report what is VISIBLE in them.',
  '',
  'Classify the image:',
  '- portfolio: a brokerage/portfolio view listing holdings with values, weights or gains',
  '- positions_list: a typed or drawn list of held positions (not a broker screen)',
  '- watchlist: a list of tickers being watched, with prices or % changes, not holdings',
  '- fill_confirmation: an order or trade confirmation',
  '- chart: a price chart (report its ticker and timeframe from the chart legend when shown)',
  '- text_screenshot: mostly prose (an article, a tweet, a note)',
  '- other: anything else',
  '',
  'For portfolio and positions_list images, return one entry in "positions" per holding row, in the order shown.',
  'Copy every number EXACTLY as printed, including $, %, commas and signs ("$12,340.50", "-3.4%").',
  'Use an empty string for any field that is not printed. Never compute or infer a number.',
  'Use side "short" only when the image marks the position as short; otherwise "long", or "unknown" if unclear.',
  'row_text is the row as printed, left to right.',
  'Report a ticker only if it is visibly printed in the image. Do not add tickers from the post text.',
  'is_complete_list is true only when the image appears to show the whole list, not a cropped or "top holdings" excerpt.',
  'account_label is the account or portfolio name if one is printed, else an empty string.',
  'tickers_visible lists every ticker symbol printed anywhere in the image.',
  'For non-portfolio images, return an empty positions array.',
].join('\n');

/**
 * Build the request body.
 *
 * @param {object} input
 * @param {string} input.model
 * @param {string} input.imageBase64
 * @param {string} input.mediaType
 * @param {string} [input.postText] - context only
 * @returns {object}
 */
function buildRequest(input) {
  const context = String(input.postText || '').slice(0, 500);
  return {
    model: input.model || DEFAULT_MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: input.mediaType, data: input.imageBase64 } },
        {
          type: 'text',
          text: context
            ? `The post this image was attached to said (context only -- report only what the image shows):\n${context}`
            : 'Read this image.',
        },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: READING_SCHEMA } },
  };
}

/**
 * Turn a response into a reading.
 *
 * @param {object} response
 * @returns {{status: 'ok'|'refused'|'error', reading: object|null, detail: string, usage: object, model: string}}
 */
function parseResponse(response) {
  const usage = response && response.usage ? response.usage : {};
  const model = response && response.model ? response.model : '';
  if (!response) return { status: 'error', reading: null, detail: 'no response', usage, model };
  if (response.stop_reason === 'refusal') {
    const details = response.stop_details || {};
    return { status: 'refused', reading: null, detail: `${details.category || ''} ${details.explanation || ''}`.trim(), usage, model };
  }
  if (response.stop_reason === 'max_tokens') return { status: 'error', reading: null, detail: 'max_tokens', usage, model };
  const text = (response.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
  try {
    const reading = JSON.parse(text);
    if (!reading || !Array.isArray(reading.positions)) throw new Error('no positions array');
    return { status: 'ok', reading, detail: '', usage, model };
  } catch (error) {
    return { status: 'error', reading: null, detail: `unparseable output: ${error.message}`, usage, model };
  }
}

/**
 * The USD cost of a response's usage.
 *
 * @param {object} usage
 * @param {string} model
 * @returns {number}
 */
function costOf(usage, model) {
  const price = PRICES[model] || PRICES[DEFAULT_MODEL];
  const m = 1e6;
  const cost = ((usage.input_tokens || 0) * price.input + (usage.output_tokens || 0) * price.output
    + (usage.cache_read_input_tokens || 0) * price.cacheRead + (usage.cache_creation_input_tokens || 0) * price.cacheWrite) / m;
  return Number(cost.toFixed(6));
}

/**
 * Prepare an image: at most MAX_LONG_EDGE px on the long side, as base64.
 *
 * @param {string} file
 * @returns {Promise<{imageBase64: string, mediaType: string, width: number, height: number}>}
 */
async function prepareImage(file) {
  // eslint-disable-next-line global-require
  const sharp = require('sharp');
  const meta = await sharp(file).metadata();
  const long = Math.max(meta.width || 0, meta.height || 0);
  let pipeline = sharp(file);
  if (long > MAX_LONG_EDGE) {
    pipeline = pipeline.resize({ width: meta.width >= meta.height ? MAX_LONG_EDGE : undefined, height: meta.height > meta.width ? MAX_LONG_EDGE : undefined });
  }
  const isPng = meta.format === 'png';
  const { data, info } = await (isPng ? pipeline.png() : pipeline.jpeg({ quality: 92 })).toBuffer({ resolveWithObject: true });
  return { imageBase64: data.toString('base64'), mediaType: isPng ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
}

/**
 * Create the Anthropic client. Credentials resolve from the environment
 * (ANTHROPIC_API_KEY, loaded from .env by the caller) and are never printed.
 */
function createClient() {
  // eslint-disable-next-line global-require
  const mod = require('@anthropic-ai/sdk');
  const Anthropic = mod.default || mod;
  return new Anthropic();
}

/**
 * Read one image.
 *
 * @param {object} input
 * @param {object} input.client - an Anthropic client (or a fake with beta.messages.create)
 * @param {string} input.file
 * @param {string} [input.model]
 * @param {string} [input.postText]
 * @returns {Promise<object>} parseResponse() plus cost
 */
async function readImage(input) {
  const model = input.model || DEFAULT_MODEL;
  const image = await prepareImage(input.file);
  const response = await input.client.beta.messages.create(buildRequest({ ...image, model, postText: input.postText }));
  const parsed = parseResponse(response);
  // A refusal fallback may have served the request on another model; price
  // it at the model that actually ran.
  const servedBy = PRICES[parsed.model] ? parsed.model : model;
  return { ...parsed, cost: costOf(parsed.usage, servedBy) };
}

module.exports = {
  DEFAULT_MODEL,
  FIRST_ESTIMATE_TOKENS,
  KEY_ENV,
  PRICES,
  PROVIDER,
  READING_SCHEMA,
  SYSTEM_PROMPT,
  VISION_VERSION,
  buildRequest,
  costOf,
  createClient,
  parseResponse,
  prepareImage,
  readImage,
};
