'use strict';

// The transcript fetcher's channel configuration.
//
// THREE THINGS ARE PINNED HERE, AND EACH ONE COST SOMETHING:
//
//   1. A channel's subtitle languages are a LIST. The channel default is
//      a string ("en", "cs-orig,en"), and assigning it as-is made the
//      caption loop walk its CHARACTERS -- 'e' and 'n' -- so every video
//      came back "no captions" and ten videos were written to the
//      caption-less blacklist on 2026-11-12. A blacklist entry is
//      permanent: the runner never asks for that video again.
//
//   2. An UNKNOWN CHANNEL is an error. The defaults used to fall back to
//      Sevcik's, which means an unknown English channel is transcribed by
//      the CZECH acoustic model -- the failure CLAUDE.md records as
//      "15 useless segments instead of 881".
//
//   3. The caption-less verdict is read from what YouTube SAID. The
//      message is on stdout; reading stderr alone turns every genuinely
//      absent track into a failed fetch, and every failed fetch into a
//      blacklist entry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'tools', 'fetchSevcikTranscripts.js'), 'utf8');

const { classifyMissingCaptions } = require('../tools/fetchSevcikTranscripts');

// ─── The channel defaults ──────────────────────────────────────────────────

test('every channel default names a subtitle language LIST', () => {
  // The defaults are read in one place, and the string has to be split
  // there. If the split moves, this test has to move with it.
  const match = /if \(!options\.subLangs\.length\) \{([\s\S]*?)\n  \}/.exec(SOURCE);
  assert.ok(match, 'the subLangs default assignment was not found');
  assert.match(match[1], /\.split\(','\)/,
    'the channel default is assigned without being split into a list');
});

test('every registered channel has its own caption languages and model', () => {
  // The keys are the channels' CONSTANTS, because the channel names are
  // defined once each, in their own module.
  const defaults = {
    SEVCIK_CHANNEL: { subLangs: 'cs-orig,en', deepgramLanguage: 'cs' },
    T3LIVE_CHANNEL: { subLangs: 'en', deepgramLanguage: 'en' },
    BENZINGA_CHANNEL: { subLangs: 'en', deepgramLanguage: 'en' },
  };
  for (const [channel, expected] of Object.entries(defaults)) {
    const block = new RegExp(`\\[${channel}\\]:\\s*\\{[^}]*\\}`, 'm').exec(SOURCE);
    assert.ok(block, `channel ${channel} is not registered`);
    assert.match(block[0], new RegExp(`subLangs:\\s*'${expected.subLangs}'`));
    assert.match(block[0], new RegExp(`deepgramLanguage:\\s*'${expected.deepgramLanguage}'`));
  }
});

test('an unknown channel is an error, and the known ones are named', () => {
  assert.match(SOURCE, /unknown channel/);
  assert.match(SOURCE, /known channels:/);
  // There must be NO fallback to another channel's settings.
  assert.doesNotMatch(SOURCE, /CHANNEL_DEFAULTS\[channel\]\s*\|\|/,
    'the defaults still fall back to another channel');
});

// ─── The VTT suffix ────────────────────────────────────────────────────────
//
// The raw caption VTT is an intermediate: yt-dlp writes it, the tool reads
// it once, and the normalised JSON is the artifact. Benzinga's corpus is
// large enough that tracking its VTTs would add ~360 MB of dead weight,
// so its VTTs carry the channel in the name and are NOT tracked.
//
// The channel has to be IN THE NAME for that: a rule that matched every
// VTT would have changed T3Live's and Sevcik's policy too, and their VTTs
// ARE tracked.

test('only Benzinga\'s raw VTTs carry a channel suffix', () => {
  const defaults = {
    SEVCIK_CHANNEL: '',
    T3LIVE_CHANNEL: '',
    BENZINGA_CHANNEL: 'benzinga',
  };
  for (const [channel, suffix] of Object.entries(defaults)) {
    const block = new RegExp(`\\[${channel}\\]:\\s*\\{[^}]*\\}`, 'm').exec(SOURCE);
    assert.ok(block, `channel ${channel} is not registered`);
    assert.match(block[0], new RegExp(`vttSuffix:\\s*'${suffix}'`),
      `${channel} should carry the VTT suffix "${suffix}"`);
  }
});

test('the VTT is written with the channel suffix, and the JSON is not', () => {
  assert.ok(SOURCE.includes('${row.video_id}.captions${suffix ? `.${suffix}` : \'\'}'),
    'the VTT name carries the suffix');
  // The JSON's name is the plain one -- every tool looks it up that way.
  assert.ok(SOURCE.includes('path.join(TRANSCRIPTS_DIR, `${videoId}.json`)'),
    'the JSON keeps its plain name');
});

test('the ignore rule names Benzinga, and not the other channels', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const rules = ignore.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data/video_pipeline/transcripts/') && line.endsWith('.vtt'));
  assert.ok(rules.length >= 1, 'no VTT rule in .gitignore');
  for (const rule of rules) {
    assert.ok(rule.includes('benzinga'),
      `the VTT rule must name Benzinga, found: ${rule}`);
    assert.ok(!rule.endsWith('/*.vtt'),
      `a rule that matched every VTT would change the other channels too: ${rule}`);
  }
});

// ─── The caption-less verdict ──────────────────────────────────────────────

test('a genuinely absent caption track is "no captions"', () => {
  const stdout = '[info] There are no subtitles for the requested languages';
  assert.match(classifyMissingCaptions('en', stdout, '', false), /no captions/);
});

test('a failed request is a retry, not a blacklist entry', () => {
  const result = classifyMissingCaptions('en', '', 'ERROR: unable to download webpage', false);
  assert.match(result, /caption fetch failed/);
  assert.doesNotMatch(result, /no captions/);
});

test('a rate-limited endpoint is a wait, not a blacklist entry', () => {
  const result = classifyMissingCaptions('en', '', 'HTTP Error 429: Too Many Requests', false);
  assert.match(result, /rate limited/);
  assert.doesNotMatch(result, /no captions/);
});

test('the hyphen in "rate-limited" is matched', () => {
  const result = classifyMissingCaptions('en', '', 'This content isn\'t available. The current session has been rate-limited by YouTube.', false);
  assert.match(result, /rate limited/);
});

test('a failure whose DETAIL mentions captions is still a failure', () => {
  // The check has to come before the "no captions" test: the detail text
  // can contain the phrase itself.
  const result = classifyMissingCaptions('en', '', 'ERROR: could not fetch no captions manifest', false);
  assert.match(result, /caption fetch failed/);
  assert.doesNotMatch(result, /: no captions$/);
});
