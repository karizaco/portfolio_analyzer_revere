'use strict';

// Transcribe audio with Deepgram, for the videos YouTube has no captions for.
//
// WHY THIS EXISTS
//
// The Sevcik channel's newer videos carry YouTube auto-captions and its
// older ones do not. Auto-captions are free and instant, but a video with
// none produces NO transcript at all -- so without a second provider the
// older half of the channel is simply missing from the dataset. That is not
// a gap the report can tolerate: the older videos are where a channel's
// earlier calls live.
//
// THE PROVIDER ORDER
//
//   1. YouTube auto-captions -- free, no key, no upload.
//   2. Deepgram -- needs an API key and an upload, and costs money.
//
// The order matters and is not arbitrary: captions cost nothing and take
// seconds, so they are tried first even when a Deepgram key is configured.
//
// THE API KEY
//
// Read from DEEPGRAM_API_KEY in the environment. It is NEVER written to a
// file, never logged, and never included in an error message -- the error
// text goes into a log that gets committed, and a key in a log is a key in
// git history.
//
// The audio is uploaded to Deepgram, so a stream's audio leaves the
// machine. That is a deliberate consequence of using a hosted transcription
// service and it is worth being explicit about.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveFfmpegBin } = require('../video/ffmpegBin');

const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';

/**
 * The Deepgram request parameters.
 *
 * `utterances=true` is what makes the response usable: it groups the words
 * into utterances, each with its own start, end and confidence. Without it
 * the response carries a flat word list, which is also handled (see
 * `normalizeDeepgram`) but is less convenient to work with.
 *
 * `smart_format=true` gives punctuation and casing, which the signal
 * extractor's sentence boundaries rely on.
 *
 * `punctuate=true` ends sentences, which is what breaks the word list into
 * utterances when `utterances` is on.
 *
 * `model=nova-2` is Deepgram's current general model. It is overridable
 * because the model names change and a hard-coded one will eventually stop
 * working.
 */
const DEFAULT_MODEL = 'nova-2';

const REQUEST_PARAMS = {
  model: process.env.DEEPGRAM_MODEL || DEFAULT_MODEL,
  language: process.env.DEEPGRAM_LANGUAGE || 'en',
  smart_format: 'true',
  punctuate: 'true',
  utterances: 'true',
  paragraphs: 'false',
  diarize: 'false',
};

/**
 * Is a Deepgram key configured?
 *
 * @returns {boolean}
 */
function hasDeepgramKey() {
  return Boolean(String(process.env.DEEPGRAM_API_KEY || '').trim());
}

/**
 * Extract the audio track of a video as a 16 kHz mono MP3.
 *
 * Deepgram accepts several audio formats. MP3 at 16 kHz mono is small and
 * universally supported, and the 16 kHz rate is what Deepgram's
 * documentation recommends for speech.
 *
 * @param {string} videoPath - the source video
 * @param {string} audioPath - where to write the audio
 * @param {object} [options]
 * @param {string} [options.ffmpegBin]
 * @param {number} [options.timeoutMs]
 * @returns {{ok: boolean, path: string, error?: string}}
 */
function extractAudio(videoPath, audioPath, options = {}) {
  const ffmpegBin = options.ffmpegBin || resolveFfmpegBin();
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });

  const result = spawnSync(ffmpegBin, [
    '-y',
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-b:a', '48k',
    audioPath,
  ], { encoding: 'utf8', timeout: options.timeoutMs || 30 * 60 * 1000 });

  if (result.error) {
    return { ok: false, path: audioPath, error: result.error.message };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, path: audioPath, error: stderr || `ffmpeg exited ${result.status}` };
  }
  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    return { ok: false, path: audioPath, error: 'ffmpeg produced no audio' };
  }
  return { ok: true, path: audioPath };
}

/**
 * Transcribe an audio file with Deepgram.
 *
 * @param {string} audioPath
 * @param {object} [options]
 * @param {string} [options.apiKey] - defaults to DEEPGRAM_API_KEY
 * @param {number} [options.timeoutMs]
 * @param {(progress: string) => void} [options.onProgress]
 * @returns {Promise<{ok: boolean, payload?: object, error?: string}>}
 */
async function transcribeAudio(audioPath, options = {}) {
  const apiKey = String(options.apiKey || process.env.DEEPGRAM_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'DEEPGRAM_API_KEY is not set' };
  }
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `audio file not found: ${audioPath}` };
  }

  const url = new URL(DEEPGRAM_API_URL);
  for (const [key, value] of Object.entries(REQUEST_PARAMS)) {
    url.searchParams.set(key, value);
  }

  const audio = fs.readFileSync(audioPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 30 * 60 * 1000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mpeg',
      },
      body: audio,
      signal: controller.signal,
    });

    if (!response.ok) {
      // The body can carry the key back in an error, so it is NOT included
      // verbatim in the message. The status is enough to act on.
      const body = await response.text().catch(() => '');
      const detail = sanitizeErrorBody(body);
      return { ok: false, error: `Deepgram HTTP ${response.status}: ${detail}` };
    }

    const payload = await response.json();
    return { ok: true, payload };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, error: 'Deepgram request timed out' };
    }
    return { ok: false, error: `Deepgram request failed: ${error && error.message ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Make an error body safe to put in a log.
 *
 * The body of a failed request can contain the authorization header's
 * value if a proxy echoed it back. Only the status-ish text is kept, and
 * anything that looks like a token is removed.
 *
 * @param {string} body
 * @returns {string}
 */
function sanitizeErrorBody(body) {
  return String(body || '')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .slice(0, 300);
}

module.exports = {
  DEFAULT_MODEL,
  DEEPGRAM_API_URL,
  REQUEST_PARAMS,
  extractAudio,
  hasDeepgramKey,
  sanitizeErrorBody,
  transcribeAudio,
};
