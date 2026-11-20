'use strict';

// The image layer: photo download, the v1 classifier, the OCR cross-check,
// and the vision reader -- with a FAKE Claude client and a pre-seeded OCR
// cache, so no network and no money.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.removeAllListeners('warning');
process.on('warning', () => {});

const sharp = require('sharp');
const { photoCandidates, downloadPhotos } = require('../src/x/images/media');
const { classifyFromOcr } = require('../src/x/images/classify');
const { parsePrinted, verifyRow } = require('../src/x/images/crossCheck');
const vision = require('../src/x/images/vision');
const { visionAll } = require('../src/x/images/runImages');
const { OCR_VERSION } = require('../src/x/images/ocr');
const { openIndex, upsertPost } = require('../src/x/indexStore');
const { normalizeApiV2Page } = require('../src/x/normalizeApiV2');
const registry = require('../src/x/registry');
const { IDS, USER, apiPage } = require('./fixtures/x/scenario');

const MARKET = new Set(['NVDA', 'AMD', 'PLTR', 'TSLA', 'SMH', 'SPY', 'ARQQ']);

function word(text, left, top, width = 60, height = 20) {
  return { text, left, top, width, height, conf: 90 };
}

test('the photo URL asks for the original rendition first, then the large one', () => {
  assert.deepEqual(photoCandidates('https://pbs.twimg.com/media/AAA111.jpg').map((c) => c.url), [
    'https://pbs.twimg.com/media/AAA111?format=jpg&name=orig',
    'https://pbs.twimg.com/media/AAA111?format=jpg&name=large',
  ]);
  assert.equal(photoCandidates('https://example.com/x.jpg').length, 0);
});

test('the classifier separates a portfolio screen, a chart and prose', () => {
  const portfolio = classifyFromOcr({
    width: 1200, height: 800, market: MARKET,
    words: [word('Portfolio', 10, 10), word('Market', 400, 10), word('Value', 470, 10),
      word('NVDA', 10, 100), word('$12,340.50', 400, 100), word('22.4%', 700, 100),
      word('AMD', 10, 140), word('$8,100.00', 400, 140), word('14.1%', 700, 140),
      word('PLTR', 10, 180), word('$5,020.10', 400, 180), word('9.0%', 700, 180)],
  });
  assert.equal(portfolio.image_class, 'portfolio');
  assert.deepEqual(portfolio.tickers, ['NVDA', 'AMD', 'PLTR']);

  const chart = classifyFromOcr({
    width: 1600, height: 900, market: MARKET,
    words: [word('TSLA', 20, 15), word('1D', 90, 15), word('NASDAQ', 140, 15),
      word('250.00', 1500, 100), word('240.00', 1500, 200), word('230.00', 1500, 300), word('220.00', 1500, 400)],
  });
  assert.equal(chart.image_class, 'chart');
  assert.equal(chart.legend_ticker, 'TSLA');
  assert.equal(chart.legend_timeframe, '1D');

  const prose = classifyFromOcr({
    width: 1000, height: 1000, market: MARKET,
    words: Array.from({ length: 50 }, (_, i) => word('market', (i % 10) * 90, Math.floor(i / 10) * 30)),
  });
  assert.equal(prose.image_class, 'text_screenshot');
});

test('a vision row counts only when the image\'s own OCR corroborates it', () => {
  // AROQ is ONE edit from ARQQ (Q read as O) -- a recorded EasyOCR misread
  // in this project. ("ARO0" would be two: measure edits, don't eyeball them.)
  const ocr = [word('NVDA', 0, 0), word('$12,340.50', 0, 0), word('22.4%', 0, 0), word('AROQ', 0, 0), word('5.0%', 0, 0)];
  assert.deepEqual(verifyRow({ ticker: 'NVDA', weight_pct_text: '22.4%', market_value_text: '$12,340.50' }, ocr, MARKET),
    { verified: true, detail: '' });
  const near = verifyRow({ ticker: 'ARQQ', weight_pct_text: '5.0%' }, ocr, MARKET);
  assert.equal(near.verified, true, 'one edit from an OCR token, and a ticker the market knows');
  assert.match(near.detail, /one edit/);
  const invented = verifyRow({ ticker: 'TSLA', weight_pct_text: '10.0%' }, ocr, MARKET);
  assert.equal(invented.verified, false, 'a ticker the OCR never saw is not verified');
  const badNumber = verifyRow({ ticker: 'NVDA', weight_pct_text: '29.4%' }, ocr, MARKET);
  assert.equal(badNumber.verified, false);
  assert.match(badNumber.detail, /weight_pct_text/);
  assert.equal(parsePrinted('$12,340.50'), 12340.5);
  assert.equal(parsePrinted('-3.4%'), -3.4);
  assert.equal(parsePrinted('(1,200.00)'), -1200);
  assert.equal(parsePrinted(''), null);
});

test('the vision request: structured output, cached instructions, refusal fallback, the default model', () => {
  const request = vision.buildRequest({ imageBase64: 'AAAA', mediaType: 'image/png', postText: 'my portfolio today' });
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(request.output_config.format.schema.required.sort(), [...vision.READING_SCHEMA.required].sort());
  assert.equal(request.system[0].cache_control.type, 'ephemeral', 'the stable instructions are a cached prefix');
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(request.messages[0].content[0].type, 'image');
  assert.match(request.messages[0].content[1].text, /context only/);

  assert.equal(vision.parseResponse({ stop_reason: 'refusal', stop_details: { category: 'other' }, usage: {} }).status, 'refused');
  assert.equal(vision.parseResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} }).status, 'error');
  assert.equal(vision.costOf({ input_tokens: 1000000, output_tokens: 0 }, 'claude-opus-5-5'), 4);
  assert.equal(vision.costOf({ input_tokens: 0, output_tokens: 1000000 }, 'claude-sonnet-5-5'), 10);
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-images-'));
  const handle = {
    dir,
    catalogDb: registry.openCatalog({ path: path.join(dir, 'state.sqlite') }),
    indexDb: openIndex({ path: path.join(dir, 'x_index.sqlite') }),
    close() {
      for (const db of [handle.catalogDb, handle.indexDb]) { try { db.close(); } catch (_) { /* closed */ } }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
  return handle;
}

test('photos download into the account folder with their md5, and a failure is recorded, not fatal', async () => {
  const s = scratch();
  try {
    const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
    const original = normalizeApiV2Page(apiPage()).records.find((r) => r.post_id === IDS.original);
    upsertPost(s.indexDb, original);
    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#123456' } }).png().toBuffer();
    const calls = [];
    const result = await downloadPhotos({
      indexDb: s.indexDb, account, mediaRoot: path.join(s.dir, 'media'), sleep: async () => {},
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes('name=orig')) return { status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        return { status: 200, arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length) };
      },
    });
    assert.deepEqual(result, { ok: 1, failed: 0, skipped: 0 });
    assert.equal(calls.length, 2, 'orig failed, large succeeded');
    const row = s.indexDb.prepare('SELECT * FROM x_post_media WHERE post_id = ?').get(IDS.original);
    assert.equal(row.download_status, 'ok');
    assert.equal(row.md5, crypto.createHash('md5').update(png).digest('hex'));
  } finally {
    s.close();
  }
});

async function seedImage(s) {
  const account = registry.addAccount(s.catalogDb, { handle: 'testtrader', userId: USER.id });
  const original = normalizeApiV2Page(apiPage()).records.find((r) => r.post_id === IDS.original);
  upsertPost(s.indexDb, original);
  const file = path.join(s.dir, 'shot.png');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ffffff' } }).png().toFile(file);
  const md5 = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
  s.indexDb.prepare(`UPDATE x_post_media SET local_path = ?, md5 = ?, download_status = 'ok' WHERE post_id = ?`)
    .run(file, md5, IDS.original);
  // The OCR cache, pre-seeded: the vision rows are checked against these words.
  const words = [word('NVDA', 0, 0), word('22.4%', 0, 0), word('AMD', 0, 0), word('14.1%', 0, 0)];
  s.indexDb.prepare(`INSERT INTO x_image_ocr (md5, engine, parser_version, text, words_json, mean_conf, ocr_at)
    VALUES (?, 'tesseract', ?, ?, ?, 90, ?)`).run(md5, OCR_VERSION, 'NVDA 22.4% AMD 14.1%',
    JSON.stringify({ words, width: 300, height: 200 }), new Date().toISOString());
  return { account, md5 };
}

function fakeClaude(reading, calls) {
  return {
    beta: {
      messages: {
        create: async (params) => {
          calls.push(params);
          return {
            model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 300 },
            content: [{ type: 'text', text: JSON.stringify(reading) }],
          };
        },
      },
    },
  };
}

test('vision: a portfolio screenshot becomes position rows, each checked against the OCR, and is never paid for twice', async () => {
  const s = scratch();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  try {
    const { account, md5 } = await seedImage(s);
    const reading = {
      image_class: 'portfolio', summary: 'Brokerage positions', account_label: 'Main', is_complete_list: true,
      legend_ticker: '', legend_timeframe: '', tickers_visible: ['NVDA', 'AMD', 'TSLA'],
      positions: [
        { ticker: 'NVDA', side: 'long', weight_pct_text: '22.4%', market_value_text: '', shares_text: '', avg_cost_text: '', gain_pct_text: '', row_text: 'NVDA 22.4%' },
        { ticker: 'AMD', side: 'long', weight_pct_text: '14.1%', market_value_text: '', shares_text: '', avg_cost_text: '', gain_pct_text: '', row_text: 'AMD 14.1%' },
        { ticker: 'TSLA', side: 'long', weight_pct_text: '9.9%', market_value_text: '', shares_text: '', avg_cost_text: '', gain_pct_text: '', row_text: 'TSLA 9.9%' },
      ],
    };
    const calls = [];
    const logs = [];
    const first = await visionAll({
      catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: (l) => logs.push(l),
      args: { yes: true, 'budget-usd': '1', client: fakeClaude(reading, calls) },
    });
    assert.equal(calls.length, 1);
    assert.equal(first.read, 1);
    assert.equal(first.positions, 3);
    assert.equal(first.verified, 2, 'TSLA is not in the OCR, so its row is not verified');
    const rows = s.catalogDb.prepare('SELECT ticker, weight_pct, row_verified, snapshot_complete, as_of_date FROM x_positions ORDER BY ticker').all();
    assert.deepEqual(rows.map((r) => [r.ticker, r.weight_pct, r.row_verified]), [['AMD', 14.1, 1], ['NVDA', 22.4, 1], ['TSLA', 9.9, 0]]);
    assert.equal(rows[0].as_of_date, '2026-11-18');
    const stored = s.catalogDb.prepare("SELECT * FROM x_image_readings WHERE reader = 'vision'").get();
    assert.equal(stored.md5, md5);
    assert.equal(stored.cost_usd_est, vision.costOf({ input_tokens: 1500, output_tokens: 300 }, 'claude-opus-5-5'));

    const again = await visionAll({
      catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: () => {},
      args: { yes: true, 'budget-usd': '1', client: fakeClaude(reading, calls) },
    });
    assert.equal(calls.length, 1, 'the same image is not read (or paid for) twice');
    assert.equal(again.skipped, 1);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    s.close();
  }
});

test('vision: a reading that finds NO rows replaces the rows the last reading left', async () => {
  // The repository's rule: one item's rows are always replaced, INCLUDING
  // WITH ZERO ROWS. A reading that found no positions is still a reading,
  // and the rows the previous reading left would otherwise survive it --
  // which is how a holding nobody can see stays in a portfolio report.
  const s = scratch();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  try {
    const { account } = await seedImage(s);
    const reading = {
      image_class: 'portfolio', summary: 'Brokerage positions', account_label: 'Main', is_complete_list: true,
      legend_ticker: '', legend_timeframe: '', tickers_visible: ['NVDA'],
      positions: [{ ticker: 'NVDA', side: 'long', weight_pct_text: '22.4%', row_text: 'NVDA 22.4%' }],
    };
    const calls = [];
    await visionAll({
      catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: () => {},
      args: { yes: true, 'budget-usd': '1', client: fakeClaude(reading, calls) },
    });
    assert.equal(s.catalogDb.prepare('SELECT COUNT(*) AS n FROM x_positions').get().n, 1);

    // The same image read again -- now finding nothing. The old row must
    // go, or the pipeline would publish a holding the last read did not see.
    s.catalogDb.prepare("DELETE FROM x_image_readings WHERE reader = 'vision'").run();
    const empty = { ...reading, positions: [] };
    await visionAll({
      catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: () => {},
      args: { yes: true, 'budget-usd': '1', client: fakeClaude(empty, calls) },
    });
    assert.equal(s.catalogDb.prepare('SELECT COUNT(*) AS n FROM x_positions').get().n, 0,
      'a reading with no rows replaces the rows the last reading left');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    s.close();
  }
});

test('vision: refuses to run without --yes, and stops before an image that would cross the budget', async () => {
  const s = scratch();
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
  try {
    const { account } = await seedImage(s);
    await assert.rejects(visionAll({ catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: () => {}, args: { 'budget-usd': '1' } }), /PAID/);
    const calls = [];
    const result = await visionAll({
      catalogDb: s.catalogDb, indexDb: s.indexDb, account, log: () => {},
      args: { yes: true, 'budget-usd': '0.001', client: fakeClaude({ positions: [] }, calls) },
    });
    assert.equal(calls.length, 0, 'not one paid call when the budget cannot cover one image');
    assert.equal(result.read, 0);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    s.close();
  }
});
