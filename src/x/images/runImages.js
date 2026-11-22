'use strict';

/**
 * The image commands of tools/runXPipeline.js: media, ocr, vision.
 *
 *   media   download the account's photos (free, public CDN)
 *   ocr     Tesseract every downloaded photo once (free; cached by md5),
 *           classify it (v1 heuristic) and record the reading
 *   vision  read photos with a vision model -- MiniMax by default, Claude
 *           with --provider anthropic (PAID; needs --yes and --budget-usd),
 *           store the structured reading, and turn portfolio rows into
 *           x_positions -- each row checked against the same image's OCR
 *
 * The vision reading is stored per (md5, reader version, model) in
 * x_image_readings (tracked), so an image is never paid for twice -- not
 * even when the same screenshot was attached to two posts.
 */

const path = require('node:path');

const { attachDerived } = require('../../db/derivedStore');
const { loadMarketTickers } = require('../../normalize/marketTickers');
const { loadEnv } = require('../../transcript/loadEnv');
const { openIndex } = require('../indexStore');
const { easternParts } = require('../marketTime');
const { downloadPhotos } = require('./media');
const { OCR_VERSION, closeWorker, ocrMedia } = require('./ocr');
const { CLASSIFIER_VERSION, classifyFromOcr } = require('./classify');
const { parsePrinted, verifyRow } = require('./crossCheck');
const vision = require('./vision');
const visionMinimax = require('./visionMinimax');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TESSERACT_READER_VERSION = `${OCR_VERSION}+${CLASSIFIER_VERSION}`;
const POSITIONS_PARSER_VERSION = `x-positions-vision-1`;

function downloadedPhotos(indexDb, account, limit) {
  return indexDb.prepare(`SELECT m.post_id, m.media_key, m.local_path, m.md5, p.created_at, p.text AS post_text
      FROM x_post_media m JOIN x_posts p ON p.post_id = m.post_id
     WHERE p.user_id = ? AND m.type = 'photo' AND m.download_status = 'ok' AND m.md5 <> ''
     ORDER BY p.created_at DESC LIMIT ?`).all(account.user_id, limit);
}

function hasReading(db, md5, reader, version, model) {
  return Boolean(db.prepare(`SELECT 1 FROM x_image_readings WHERE md5 = ? AND reader = ? AND reader_version = ?
    AND model = ?`).get(md5, reader, version, model || ''));
}

/**
 * Purge the rows a SUPERSEDED reader version wrote.
 *
 * The repository's rule: one item's rows are always replaced, and the
 * superseded parser versions are purged on a FULL run only -- so a
 * limited run never destroys work it did not redo.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} reader - tesseract | vision
 * @param {string} version - the CURRENT reader version
 * @param {string} [model] - the vision model
 * @returns {number} rows purged
 */
function purgeSupersededReadings(db, reader, version, model = '') {
  const result = reader === 'vision'
    ? db.prepare(`DELETE FROM x_image_readings WHERE reader = 'vision' AND reader_version != ? AND model = ?`).run(version, model)
    : db.prepare(`DELETE FROM x_image_readings WHERE reader = 'tesseract' AND reader_version != ?`).run(version);
  return Number(result.changes || 0);
}

/**
 * Purge the position rows a superseded parser version wrote.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} version
 * @returns {number} rows purged
 */
function purgeSupersededPositions(db, version) {
  const result = db.prepare(`DELETE FROM x_positions WHERE source = 'image_vision' AND parser_version != ?`).run(version);
  return Number(result.changes || 0);
}

/**
 * OCR + classify every downloaded photo that has no reading yet.
 */
async function ocrAll({ catalogDb, indexDb, account, limit, full, log }) {
  attachDerived(catalogDb);
  const market = loadMarketTickers();
  if (full) {
    const purged = purgeSupersededReadings(catalogDb, 'tesseract', TESSERACT_READER_VERSION);
    if (purged) log(`[x-ocr] purged ${purged} reading(s) written by an older reader version`);
  }
  const insert = catalogDb.prepare(`INSERT OR REPLACE INTO x_image_readings (md5, post_id, media_key, account_id, handle,
      reader, reader_version, model, image_class, class_confidence, legend_ticker, legend_timeframe, tickers_json,
      reading_json, status, evidence_text) VALUES (?, ?, ?, ?, ?, 'tesseract', ?, '', ?, ?, ?, ?, ?, ?, 'ok', ?)`);
  let done = 0;
  let skipped = 0;
  const classes = {};
  for (const media of downloadedPhotos(indexDb, account, limit)) {
    if (hasReading(catalogDb, media.md5, 'tesseract', TESSERACT_READER_VERSION, '')) {
      skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const ocr = await ocrMedia(indexDb, media);
    const cls = classifyFromOcr({ words: ocr.words, width: ocr.width, height: ocr.height, market });
    insert.run(media.md5, media.post_id, media.media_key, account.account_id, account.handle, TESSERACT_READER_VERSION,
      cls.image_class, cls.confidence, cls.legend_ticker, cls.legend_timeframe, JSON.stringify(cls.tickers),
      JSON.stringify({ features: cls.features, mean_conf: ocr.meanConf }), (ocr.text || '').slice(0, 600) || '(no text)');
    classes[cls.image_class] = (classes[cls.image_class] || 0) + 1;
    done += 1;
    if (done % 10 === 0) log(`[x-ocr] ${done} images read...`);
  }
  log(`[x-ocr] @${account.handle}: ${done} read, ${skipped} already read. Classes (v1 heuristic): ${JSON.stringify(classes)}`);
  return { done, skipped, classes };
}

/**
 * The vision providers. MiniMax is the default (the user's decision,
 * 2026-11-21: no Anthropic API); Claude stays available with
 * `--provider anthropic`.
 */
const PROVIDERS = { minimax: visionMinimax, anthropic: vision };
const DEFAULT_PROVIDER = 'minimax';

function resolveProvider(name) {
  const key = String(name || DEFAULT_PROVIDER).toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) throw new Error(`unknown vision provider ${name} (${Object.keys(PROVIDERS).join(' | ')})`);
  return provider;
}

/**
 * Read photos with a vision model, within a budget.
 */
async function visionAll({ catalogDb, indexDb, account, args, full, log }) {
  const provider = resolveProvider(args.provider);
  if (!args.yes) throw new Error(`vision is PAID (${provider.PROVIDER} API). Add --yes and --budget-usd N.`);
  const budgetUsd = Number(args['budget-usd']);
  if (!(budgetUsd > 0)) throw new Error('--budget-usd N is required for vision');
  loadEnv();
  if (!args.client && !provider.KEY_ENV.some((name) => process.env[name])) {
    throw new Error(`${provider.KEY_ENV[0]} is not set. Put it in .env (${provider.KEY_ENV[0]}=...) -- see docs/x-source-plan.md`);
  }
  attachDerived(catalogDb);
  const model = String(args.model || provider.DEFAULT_MODEL);
  if (full) {
    // A full run purges what an older reader version wrote; a limited run
    // never destroys work it did not redo.
    const purgedReadings = purgeSupersededReadings(catalogDb, 'vision', provider.VISION_VERSION, model);
    const purgedPositions = purgeSupersededPositions(catalogDb, POSITIONS_PARSER_VERSION);
    if (purgedReadings || purgedPositions) {
      log(`[x-vision] purged ${purgedReadings} reading(s) and ${purgedPositions} position row(s) from an older version`);
    }
  }
  if (!provider.PRICES[model]) log(`[x-vision] no price on file for ${model}; costs are estimated at ${provider.DEFAULT_MODEL} rates`);
  const onlyClasses = args['only-classes'] ? new Set(String(args['only-classes']).split(',').map((s) => s.trim())) : null;
  const limit = Number(args.limit) || 200;
  const client = args.client || provider.createClient();
  const market = loadMarketTickers();
  const price = provider.PRICES[model] || provider.PRICES[provider.DEFAULT_MODEL];
  // A conservative first estimate (the provider's own token guess), replaced by what is observed.
  const guess = provider.FIRST_ESTIMATE_TOKENS || { input: 2500, output: 1500 };
  let estimate = (guess.input * price.input + guess.output * price.output) / 1e6;
  let spent = 0;
  const totals = { read: 0, refused: 0, errors: 0, positions: 0, verified: 0, skipped: 0 };

  const insertReading = catalogDb.prepare(`INSERT OR REPLACE INTO x_image_readings (md5, post_id, media_key, account_id,
      handle, reader, reader_version, model, image_class, legend_ticker, legend_timeframe, tickers_json, reading_json,
      status, status_detail, input_tokens, output_tokens, cost_usd_est, evidence_text)
      VALUES (?, ?, ?, ?, ?, 'vision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const deletePositions = catalogDb.prepare(`DELETE FROM x_positions WHERE image_md5 = ? AND snapshot_post_id = ?
      AND source = 'image_vision'`);
  const insertPosition = catalogDb.prepare(`INSERT INTO x_positions (parser_version, account_id, handle, snapshot_post_id,
      as_of_date, as_of_basis, source, account_label, side, ticker, weight_pct, shares, avg_cost, market_value, gain_pct,
      snapshot_complete, row_verified, verify_detail, image_md5, evidence_text)
      VALUES (?, ?, ?, ?, ?, 'post_time', 'image_vision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const seenMd5 = new Set();
  for (const media of downloadedPhotos(indexDb, account, limit)) {
    if (seenMd5.has(media.md5) || hasReading(catalogDb, media.md5, 'vision', provider.VISION_VERSION, model)) {
      totals.skipped += 1;
      continue;
    }
    seenMd5.add(media.md5);
    if (onlyClasses) {
      const first = catalogDb.prepare(`SELECT image_class FROM x_image_readings WHERE md5 = ? AND reader = 'tesseract'
        ORDER BY id DESC LIMIT 1`).get(media.md5);
      if (!first || !onlyClasses.has(first.image_class)) {
        totals.skipped += 1;
        continue;
      }
    }
    if (spent + estimate > budgetUsd) {
      log(`[x-vision] budget: $${spent.toFixed(3)} spent of $${budgetUsd}; the next image (~$${estimate.toFixed(3)}) would cross it. Stopping.`);
      break;
    }
    // The OCR evidence comes first: a vision row is only verified against it.
    // eslint-disable-next-line no-await-in-loop
    const ocr = await ocrMedia(indexDb, media);
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await provider.readImage({
        client, file: path.resolve(ROOT, media.local_path), model, postText: media.post_text,
      });
    } catch (error) {
      const status = error && error.status;
      log(`[x-vision] API error${status ? ` ${status}` : ''}: ${String(error.message || error).slice(0, 200)}`);
      // 402 is MiniMax's "insufficient balance": every next image would fail the same way.
      if (status === 401 || status === 402 || status === 403 || status === 429 || status === 400) break;
      totals.errors += 1;
      continue;
    }
    spent += result.cost;
    estimate = Math.max(estimate * 0.5, result.cost * 1.2);
    const reading = result.reading || {};
    const positions = Array.isArray(reading.positions) ? reading.positions : [];
    const evidence = result.status === 'ok'
      ? [reading.summary || '', ...positions.map((row) => row.row_text || row.ticker)].join(' | ').slice(0, 1500)
      : `(${result.status}: ${result.detail})`;
    insertReading.run(media.md5, media.post_id, media.media_key, account.account_id, account.handle, provider.VISION_VERSION, model,
      reading.image_class || 'unknown', reading.legend_ticker || '', reading.legend_timeframe || '',
      JSON.stringify(reading.tickers_visible || []), JSON.stringify(reading), result.status, result.detail || '',
      result.usage.input_tokens ?? null, result.usage.output_tokens ?? null, result.cost, evidence || '(empty)');

    if (result.status === 'ok') totals.read += 1;
    else if (result.status === 'refused') totals.refused += 1;
    else totals.errors += 1;

    if (result.status === 'ok') {
      const asOf = easternParts(media.created_at).date;
      // The rows are ALWAYS replaced, INCLUDING WITH ZERO ROWS. A reading
      // that found no positions is still a reading, and the rows the
      // previous reading left would otherwise survive it -- which is how a
      // holding nobody can see stays in a portfolio report. (The
      // repository's rule: one item's rows are always replaced, including
      // with zero rows.) A REFUSED or FAILED read leaves the rows alone:
      // nothing was read, so nothing is known.
      deletePositions.run(media.md5, media.post_id);
      for (const row of positions) {
        const ticker = String(row.ticker || '').toUpperCase().replace(/^\$/, '').trim();
        if (!ticker) continue;
        const check = verifyRow(row, ocr.words, market);
        insertPosition.run(POSITIONS_PARSER_VERSION, account.account_id, account.handle, media.post_id, asOf,
          reading.account_label || '', row.side === 'short' ? 'short' : 'long', ticker,
          parsePrinted(row.weight_pct_text), parsePrinted(row.shares_text), parsePrinted(row.avg_cost_text),
          parsePrinted(row.market_value_text), parsePrinted(row.gain_pct_text),
          reading.is_complete_list ? 1 : 0, check.verified ? 1 : 0, check.detail, media.md5,
          String(row.row_text || ticker).slice(0, 500));
        totals.positions += 1;
        if (check.verified) totals.verified += 1;
      }
    }
    log(`[x-vision] ${media.post_id}: ${result.status} ${reading.image_class || ''} ${positions.length ? `${positions.length} rows` : ''}`
      + ` $${result.cost.toFixed(4)} (total $${spent.toFixed(3)})`);
  }
  log(`[x-vision] @${account.handle}: ${totals.read} read, ${totals.refused} refused, ${totals.errors} errors,`
    + ` ${totals.positions} position rows (${totals.verified} verified by OCR), ${totals.skipped} skipped; spent ~$${spent.toFixed(3)}`);
  return { ...totals, spent };
}

/**
 * Dispatch.
 */
async function run(command, { catalogDb, account, args, log }) {
  if (!account.user_id) throw new Error(`@${account.handle} has no user id yet; crawl it first`);
  const indexDb = openIndex();
  // A run with no --limit is a FULL run, and only a full run may purge
  // what an older reader version wrote.
  const full = args.limit === undefined;
  try {
    if (command === 'media') return await downloadPhotos({ indexDb, account, limit: Number(args.limit) || 500, log });
    if (command === 'ocr') return await ocrAll({ catalogDb, indexDb, account, limit: Number(args.limit) || 2000, full, log });
    if (command === 'vision') return await visionAll({ catalogDb, indexDb, account, args, full, log });
    throw new Error(`unknown image command ${command}`);
  } finally {
    indexDb.close();
    await closeWorker();
  }
}

module.exports = {
  DEFAULT_PROVIDER,
  POSITIONS_PARSER_VERSION,
  resolveProvider,
  TESSERACT_READER_VERSION,
  ocrAll,
  purgeSupersededPositions,
  purgeSupersededReadings,
  run,
  visionAll,
};
