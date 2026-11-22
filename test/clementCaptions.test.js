'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  parseCaption,
  dateFromPostedAt,
  normalizeTicker,
  PARSER_VERSION,
} = require('../src/discord/clement/parseCaption');
const { loadLexicon } = require('../src/discord/symbols');

const FIX = path.join(__dirname, 'fixtures', 'clement');
const KNOWN = loadLexicon();

function loadFix(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function parseFix(name, extra = {}) {
  const f = loadFix(name);
  return parseCaption(f.content, {
    posted_at: f.posted_at,
    image_count: f.attachment_count || 0,
    discord_message_id: f.discord_message_id,
    message_id: 1,
    known: KNOWN,
    ...extra,
  });
}

test('parser_version is clement-captions-1', () => {
  assert.equal(PARSER_VERSION, 'clement-captions-1');
});

test('dateFromPostedAt reads ISO timestamps', () => {
  assert.equal(dateFromPostedAt('2025-06-10T02:35:01.523000+00:00'), '2025-06-10');
});

test('normalizeTicker maps BTCUSD → BTC', () => {
  assert.equal(normalizeTicker('BTCUSD'), 'BTC');
  assert.equal(normalizeTicker('$ethusd'), 'ETH');
});

test('dated daily plan header sets as_of_date and kind', () => {
  const { post, ideas } = parseFix('caption_02_daily_plan.json');
  assert.equal(post.post_kind, 'daily_plan');
  assert.equal(post.as_of_date, '2025-06-10');
  assert.equal(post.as_of_source, 'caption_header');
  assert.equal(post.image_count, 1);
  assert.ok(post.body.toLowerCase().includes('long side is working'));
});

test('bold dated daily plan header parses title', () => {
  const { post } = parseFix('caption_07_daily_plan_bold.json');
  assert.equal(post.post_kind, 'daily_plan');
  assert.equal(post.as_of_date, '2026-01-05');
  assert.equal(post.as_of_source, 'caption_header');
  assert.ok(post.title.length > 0 || post.body.includes('2026'));
});

test('empty caption with images is chart_note and has no ideas', () => {
  const { post, ideas } = parseFix('caption_04_empty.json');
  assert.equal(post.post_kind, 'chart_note');
  assert.equal(post.image_count, 1);
  assert.equal(ideas.length, 0);
});

test('link-only caption is other with no ideas', () => {
  const { post, ideas } = parseFix('caption_05_link.json');
  assert.equal(post.post_kind, 'other');
  assert.equal(ideas.length, 0);
});

test('idea writeup extracts cashtag tickers', () => {
  const { post, ideas } = parseFix('caption_01_idea.json');
  assert.equal(post.post_kind, 'idea_writeup');
  const tickers = ideas.map((i) => i.ticker);
  assert.ok(tickers.includes('SOXX'), `got ${tickers.join(',')}`);
  // bare names from prose that are known
  assert.ok(tickers.includes('PLTR') || tickers.includes('HIMS') || tickers.includes('APP'));
});

test('multi-ticker idea writeup extracts $ETHUSD / theme lists', () => {
  const { post, ideas } = parseFix('caption_06_idea_multi.json');
  assert.equal(post.post_kind, 'idea_writeup');
  assert.equal(post.as_of_date, '2025-08-21');
  const by = Object.fromEntries(ideas.map((i) => [i.ticker, i]));
  assert.ok(by.ETH || by.BTC, 'crypto idea');
  assert.ok(by.IWM || by.TNA, 'small caps');
  assert.ok(by.TEM, 'TEM in healthcare theme');
  if (by.TEM) {
    assert.ok(
      by.TEM.role === 'theme_member' || by.TEM.role === 'watch' || by.TEM.role === 'focus' || by.TEM.role === 'long_idea',
      by.TEM.role,
    );
  }
});

test('QQQ cashtag is kept as a mention', () => {
  const { ideas } = parseFix('caption_03_idea.json');
  const tickers = ideas.map((i) => i.ticker);
  assert.ok(tickers.includes('QQQ'), tickers.join(','));
});
