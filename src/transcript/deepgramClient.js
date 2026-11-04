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
 *
 * THE LANGUAGE IS NOT A HINT -- IT IS A HARD FILTER
 *
 * The default is `cs` (Czech), because the Sevcik channel is Czech. That
 * is not a formality: the language selects the ACOUSTIC MODEL, and
 * pointing the wrong one at Czech audio does not produce a worse
 * transcript, it produces NO transcript.
 *
 * Measured on one real 50-minute stream (2026-11-04, UX1IRkmxIUo):
 *
 *   language=en   ->  15 segments, isolated words ("Earnings", "Netflix")
 *   language=cs   -> 881 segments, full sentences
 *
 * The English run was not "less accurate Czech" -- it was the English
 * acoustic model failing to find any speech in the audio, so it emitted
 * the handful of words it could recognise as English. Every downstream
 * measurement would have been made on that.
 */
const DEFAULT_MODEL = 'nova-2';
const DEFAULT_LANGUAGE = 'cs';

/**
 * How many times a failed request is retried, and how long to wait.
 *
 * "fetch failed" is Node's message for a transport failure, and it is the
 * commonest failure by far: the connection dropped, DNS failed, or the
 * socket was reset. It is ALWAYS worth retrying, and it is not a sign of
 * a bad key -- a bad key comes back as HTTP 401, which is not retried.
 *
 * Measured on the first corpus fetch (2026-11-04): 4 of 12 videos failed
 * with "fetch failed" on the first attempt.
 */
const DEFAULT_RETRIES = 3;
const RETRY_WAIT_MS = 5000;

const REQUEST_PARAMS = {
  model: process.env.DEEPGRAM_MODEL || DEFAULT_MODEL,
  language: process.env.DEEPGRAM_LANGUAGE || DEFAULT_LANGUAGE,
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
 * @param {number} [options.retries] - how many times to retry a transport failure
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
  const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;

  let lastError = '';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
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
        // The body can carry the key back in an error, so it is NOT
        // included verbatim in the message. The status is enough to act
        // on.
        const body = await response.text().catch(() => '');
        const detail = sanitizeErrorBody(body);

        // A 5xx or a 429 is the SERVICE's problem, and the same request
        // will usually succeed a moment later. A 4xx is the request's
        // problem -- a bad key, a bad model -- and retrying it just
        // wastes the audio upload.
        const retriable = response.status === 429 || response.status >= 500;
        if (retriable && attempt < retries) {
          lastError = `Deepgram HTTP ${response.status}: ${detail}`;
          await sleep(RETRY_WAIT_MS * (attempt + 1));
          continue;
        }
        return { ok: false, error: `Deepgram HTTP ${response.status}: ${detail}` };
      }

      const payload = await response.json();
      return { ok: true, payload };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        lastError = 'Deepgram request timed out';
      } else {
        // "fetch failed" is Node's message for a transport failure: the
        // connection dropped, DNS failed, or the socket was reset. It is
        // the commonest failure by far and it is ALWAYS worth retrying.
        lastError = `Deepgram request failed: ${error && error.message ? error.message : String(error)}`;
      }
      if (attempt < retries) {
        await sleep(RETRY_WAIT_MS * (attempt + 1));
        continue;
      }
      return { ok: false, error: lastError };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { ok: false, error: lastError || 'Deepgram request failed' };
}

/**
 * Wait, asynchronously.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
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
  DEFAULT_LANGUAGE,
  DEFAULT_MODEL,
  DEFAULT_RETRIES,
  DEEPGRAM_API_URL,
  REQUEST_PARAMS,
  RETRY_WAIT_MS,
  extractAudio,
  hasDeepgramKey,
  sanitizeErrorBody,
  transcribeAudio,
};
