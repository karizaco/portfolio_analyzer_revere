'use strict';

// Fetch a transcript for every Sevcik video that does not have one yet.
//
// THE PROVIDER ORDER
//
//   1. YouTube auto-captions. Free, no key, no upload, and the video's own
//      audio never leaves the machine.
//   2. Deepgram. Needs DEEPGRAM_API_KEY and an audio upload, and costs
//      money -- but it is the only way to reach the older videos, which
//      carry no captions at all.
//
// Captions are tried FIRST even when a Deepgram key is configured, because
// they are free and instant. Deepgram is the fallback, not the default.
//
// WHAT IT WRITES
//
//   data/video_pipeline/transcripts/<video_id>.json   the transcript
//   video_transcripts                                one row per video
//   transcript_segments                               the normalized segments
//   videos.transcript_path                            the existing pointer
//
// The transcript file has the SAME shape `tools/fetchCaptions.js` writes, so
// the two tools cannot fight over the same video: whichever ran first
// leaves the file, and the other sees it and skips.
//
// The provider is recorded in `video_transcripts.provider`, because the two
// providers are not equally trustworthy and a later reader has to know
// which one a signal came from.
//
// Usage:
//   node tools/fetchSevcikTranscripts.js
//   node tools/fetchSevcikTranscripts.js --limit 6
//   node tools/fetchSevcikTranscripts.js --video-id abc123
//   node tools/fetchSevcikTranscripts.js --provider deepgram --limit 2
//   node tools/fetchSevcikTranscripts.js --no-deepgram-fallback
//   node tools/fetchSevcikTranscripts.js --json

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// node:sqlite is still flagged experimental; its warning is noise here.
process.removeAllListeners('warning');
process.on('warning', () => {});

const { DatabaseSync } = require('node:sqlite');

const { loadEnv } = require('../src/transcript/loadEnv');
const { normalizeTranscript, transcriptChecksum } = require('../src/transcript/transcriptNormalize');
const { extractAudio, hasDeepgramKey, transcribeAudio, deepgramLanguage } = require('../src/transcript/deepgramClient');
const { SEVCIK_CHANNEL, SEVCIK_SOURCE_URL } = require('../src/sevcik/channel');
const { sevcikVideoQuarantine } = require('../src/sevcik/contentFilter');
const { T3LIVE_CHANNEL } = require('../src/t3live/channel');
const { t3liveVideoQuarantine } = require('../src/t3live/contentFilter');
const { BENZINGA_CHANNEL } = require('../src/benzinga/channel');
const { benzingaVideoQuarantine } = require('../src/benzinga/contentFilter');

// What differs per channel. Sevcik is Czech (`cs-orig` first) and has its
// own non-market title filter; T3Live and Benzinga are English and have
// their own.
//
// The Deepgram LANGUAGE is a MODEL choice, not a hint: it selects the
// acoustic model. Pointing the Czech model at English audio does not
// produce a worse transcript -- it produces no transcript. So a channel
// that is not registered here MUST NOT fall back to Sevcik's settings: it
// would be transcribed by the wrong model, and the result would be kept.
//
// THE VTT SUFFIX
//
// The raw caption VTT is an INTERMEDIATE: yt-dlp writes it, the tool
// reads it once, the normaliser turns it into the JSON, and nothing
// downstream ever opens it. The JSON is the artifact.
//
// Benzinga's corpus is large enough that tracking its VTTs would add
// ~360 MB of dead weight, so its VTTs carry the channel in the name and
// are NOT tracked (the user's decision, 2026-11-11: "track json only").
// The other channels keep their VTTs tracked, exactly as before -- which
// is why the name has to carry the channel at all: a rule that matched
// every VTT would have changed their policy too.
const CHANNEL_DEFAULTS = {
  [SEVCIK_CHANNEL]: { subLangs: 'cs-orig,en', deepgramLanguage: 'cs', quarantine: sevcikVideoQuarantine, vttSuffix: '' },
  [T3LIVE_CHANNEL]: { subLangs: 'en', deepgramLanguage: 'en', quarantine: t3liveVideoQuarantine, vttSuffix: '' },
  [BENZINGA_CHANNEL]: { subLangs: 'en', deepgramLanguage: 'en', quarantine: benzingaVideoQuarantine, vttSuffix: 'benzinga' },
};
const { attachSegments } = require('../src/transcript/segmentStore');

// The credentials live in .env, which is gitignored. An environment
// variable that is already set wins over the file.
loadEnv();

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'video_pipeline', 'state.sqlite');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data', 'video_pipeline', 'transcripts');
const AUDIO_DIR = path.join(ROOT, 'data', 'video_pipeline', 'audio_sevcik');
const DEFAULT_COOKIES = path.join(ROOT, 'data', 'video_pipeline', 'downloads_1080p', 'youtubeCookies.txt');

// yt-dlp is installed as a Python module; use 'py -3 -m yt_dlp' so the tool
// is found on every install method.
const PY = process.platform === 'win32' ? 'py' : 'python3';

// Same anti-bot path the QMG/Revere downloaders use. Caption fetch used to
// omit this and hit the blocked default client; audio already had visios.
const YT_EXTRACTOR_ARGS = 'youtube:player_client=visios';

const argv = process.argv.slice(2);

/**
 * Cookie file for yt-dlp, if one exists.
 *
 * Order: --cookies flag, YOUTUBE_COOKIES env, then the project's known
 * cookie export path. Missing file => no cookies flag (anonymous still works
 * with visios on many streams).
 *
 * @returns {string}
 */
function resolveCookiesPath() {
  const fromFlag = readFlag(argv, '--cookies') || '';
  const fromEnv = String(process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIE || '').trim();
  for (const candidate of [fromFlag, fromEnv, DEFAULT_COOKIES]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * Shared yt-dlp flags for YouTube player extraction.
 *
 * @returns {string[]}
 */
function youtubeClientArgs() {
  const args = [
    '--js-runtimes', 'node',
    '--extractor-args', YT_EXTRACTOR_ARGS,
    '--no-warnings',
  ];
  const cookies = resolveCookiesPath();
  if (cookies) args.push('--cookies', cookies);
  return args;
}

// The subtitle endpoint throttles the IP, and the project's own rule is
// that a rate-limited YouTube session needs 30-60 minutes of quiet --
// hammering it makes the throttle worse, not better.
//
// These are the DEFAULTS; `--rate-limit-attempts` and
// `--rate-limit-wait` override them, so a quick run can be asked not to
// wait at all.
const RATE_LIMIT_ATTEMPTS = Number(readFlag(argv, '--rate-limit-attempts')) || 3;
const RATE_LIMIT_WAIT_SECONDS = Number(readFlag(argv, '--rate-limit-wait')) || 90;

/**
 * Did YouTube refuse us, or did the video simply have no captions?
 *
 * THE HYPHEN IS THE WHOLE DEFECT. yt-dlp's own wording is
 *
 *   "This content isn't available, try again later. The current session has
 *    been rate-limited by YouTube for up to an hour."
 *
 * -- "rate-LIMITED", with a hyphen. A pattern for "rate limited", with a
 * space, does not match it, and the tool then reads a throttled endpoint as
 * a video with no captions: it does not wait, it does not stop, and it
 * blacklists the video. On 2026-11-11 that burned 76 fetches against an
 * already-throttled IP before the run gave up.
 *
 * Both spellings are accepted, and so are the HTTP forms, because different
 * yt-dlp versions and different endpoints word it differently.
 */
const RATE_LIMITED_PATTERN = /rate[-\s]?limited|HTTP Error 429|Too Many Requests/i;

const options = {
  limit: Number(readFlag(argv, '--limit')) || 0,
  videoId: readFlag(argv, '--video-id') || '',
  channel: readFlag(argv, '--channel') || SEVCIK_CHANNEL,
  provider: readFlag(argv, '--provider') || 'auto',
  deepgramFallback: !argv.includes('--no-deepgram-fallback'),
  includeQuarantine: argv.includes('--include-quarantine'),
  force: argv.includes('--force'),
  json: argv.includes('--json'),
  keepAudio: argv.includes('--keep-audio'),
  // The subtitle languages to try, in order.
  //
  // The Sevcik channel is CZECH, so this is not a formality. YouTube
  // publishes two tracks for it: `cs-orig` (the original Czech) and `en`
  // (YouTube's machine translation).
  //
  // `cs-orig` is tried FIRST. It used to be the other way round, on the
  // reasoning that the signal extractor read English trading vocabulary
  // -- "bullish", "target", "stop loss" -- and a machine translation
  // would put the speech into words the extractor understood. That
  // reasoning expired when the extractor was taught Czech, and the
  // measured effect of the Czech vocabulary is what settled it: over
  // the same 12 videos the English patterns matched NOTHING (0 bias
  // segments, 0 horizon segments) and the Czech patterns matched 160
  // and 147.
  //
  // The machine translation is also the worse record of what was said.
  // It preserves the tickers and the numbers -- which are the signal --
  // but it re-writes the certainty words, which are the other half of
  // the signal: his hedging and his conviction live in the wording.
  //
  // `en` stays in the list as a fallback for a video whose Czech track
  // is missing. Other channels take their own default (T3Live and
  // Benzinga: `en`).
  //
  // The channel's default is read when the run starts, not when this
  // module loads, so an unknown channel is reported as an error with the
  // list of known channels rather than as a crash at load time.
  subLangs: (readFlag(argv, '--sub-lang') || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Restrict the run to the ids in this file (one per line; anything after
  // a tab is ignored). This is how a run is limited to one T3Live show.
  idsFile: readFlag(argv, '--ids-file') || '',
  // Stop the run after this many videos IN A ROW were refused with a 429.
  // Carrying on only hammers a throttled IP; the project rule is 30-60
  // minutes of quiet.
  maxRateLimited: Number(readFlag(argv, '--max-rate-limited')) || 3,
};

function channelDefaults(channel) {
  const defaults = CHANNEL_DEFAULTS[channel];
  if (!defaults) {
    // Falling back to another channel's settings would use the wrong
    // Deepgram model and the wrong caption languages, and the wrong
    // quarantine. Every one of those is a silent wrong answer, so an
    // unknown channel is an error.
    throw new Error(
      `unknown channel "${channel}"; known channels: ${Object.keys(CHANNEL_DEFAULTS).join(', ')}`,
    );
  }
  return defaults;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No SQLite at ${DB_PATH}. Run 'npm run video:init' first.`);
    process.exit(1);
  }
  // The channel's defaults are read here, so an unknown channel is an error
  // the operator sees, with the known channels named.
  const defaults = channelDefaults(options.channel);
  // The default is a STRING ("en", "cs-orig,en"). It has to become a LIST
  // here: assigning the string directly made the caption loop walk its
  // characters -- 'e' and 'n' -- and every video came back "no captions".
  if (!options.subLangs.length) {
    options.subLangs = String(defaults.subLangs).split(',').map((s) => s.trim()).filter(Boolean);
  }
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const cookiesPath = resolveCookiesPath();
  const rows = selectCandidates();
  console.log(`[sevcik-transcripts] candidates=${rows.length} channel=${options.channel}`
    + ` provider=${options.provider} deepgram-fallback=${options.deepgramFallback}`
    + ` client=visios cookies=${cookiesPath || 'none'}`);

  const results = [];
  let rateLimitedInARow = 0;
  for (const row of rows) {
    const result = await processVideo(row);
    results.push(result);
    const detail = result.provider
      ? `${result.provider} (${result.segments} segments)`
      : `FAILED: ${result.error}`;
    console.log(`[sevcik-transcripts] ${row.video_id} ${row.upload_date} ${detail}`);

    rateLimitedInARow = result.error && RATE_LIMITED_PATTERN.test(result.error) ? rateLimitedInARow + 1 : 0;
    if (rateLimitedInARow >= options.maxRateLimited) {
      console.error(`[sevcik-transcripts] stopping: ${rateLimitedInARow} videos in a row were rate limited (HTTP 429).`);
      break;
    }
  }

  const summary = {
    candidates: rows.length,
    fetched: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    providers: countBy(results.filter((r) => r.provider).map((r) => r.provider)),
    results,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[sevcik-transcripts] done: fetched=${summary.fetched} skipped=${summary.skipped}`
      + ` failed=${summary.failed} providers=${JSON.stringify(summary.providers)}`);
  }

  // The two blockers are SEPARATE and each needs a different response, so
  // they are named separately rather than left inside a stack of provider
  // errors.
  if (summary.failed) {
    const rateLimited = results.some((r) => r.error && RATE_LIMITED_PATTERN.test(r.error));
    const noKey = results.some((r) => r.error && /DEEPGRAM_API_KEY is not set/.test(r.error));
    console.error('');
    if (rateLimited) {
      console.error('[sevcik-transcripts] The YouTube SUBTITLE endpoint is rate limiting this IP (HTTP 429).');
      console.error('[sevcik-transcripts] The video endpoint still works -- only the caption download is refused.');
      console.error('[sevcik-transcripts] The project rule is 30-60 minutes of quiet before retrying.');
    }
    if (noKey) {
      console.error('[sevcik-transcripts] DEEPGRAM_API_KEY is not set, so the caption-less videos cannot be transcribed.');
      console.error('[sevcik-transcripts] The audio download itself WORKS -- only the Deepgram call needs the key.');
    }
  }

  process.exit(summary.failed ? 1 : 0);
}

/**
 * The catalog rows that need a transcript.
 *
 * A row is a candidate when it has a video URL and no transcript file on
 * disk. The FILE is the test, not the database column: a column that says
 * a transcript exists while the file is gone would silently skip the video
 * forever, and this pipeline's whole point is that every stream gets read.
 *
 * @returns {Array<{video_id: string, upload_date: string, title: string, video_url: string, channel: string}>}
 */
function selectCandidates() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const filters = ["video_url != ''", "channel = ?"];
  const params = [options.channel];

  let sql = `SELECT video_id, upload_date, title, video_url, channel FROM videos
             WHERE ${filters.join(' AND ')}`;
  if (options.videoId) {
    // The filter has to go BEFORE the ORDER BY. Appending it after the
    // ORDER BY produced "near AND: syntax error" -- which is how the
    // --video-id flag was broken for every run that used it.
    sql += ' AND video_id = ?';
    params.push(options.videoId);
  }
  sql += ' ORDER BY upload_date DESC, video_id ASC';
  const rows = db.prepare(sql).all(...params);
  db.close();

  // The listing facts -- the length and the live status -- decide whether a
  // video is a call worth transcribing, so the quarantine needs them. They
  // live in `video_listing_entries`, and a channel with no listing entries
  // (Sevcik, T3Live) simply has none to add.
  const facts = listingFacts(rows.map((row) => row.video_id));
  for (const row of rows) Object.assign(row, facts.get(row.video_id) || {});

  let candidates = rows.filter((row) => {
    if (options.force) return true;
    return !fs.existsSync(transcriptPathFor(row.video_id));
  });

  if (options.idsFile) {
    const wanted = new Set(fs.readFileSync(options.idsFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.split('\t')[0].trim())
      .filter(Boolean));
    candidates = candidates.filter((row) => wanted.has(row.video_id));
  }

  if (!options.includeQuarantine) {
    const before = candidates.length;
    const quarantine = channelDefaults(options.channel).quarantine;
    const kept = candidates.filter((row) => !quarantine(row).quarantined);
    if (before !== kept.length) {
      const dropped = candidates.filter((row) => quarantine(row).quarantined).map((row) => row.video_id);
      // The COUNT alone was not enough for a caller to act on: a chunk of
      // ids that are ALL quarantined leaves the fetch tool with no
      // candidates, which a chunked runner reads as "nothing landed" and
      // reports as a possible throttle. The ids are named so the runner can
      // set them aside instead of asking for them again.
      console.log(`[sevcik-transcripts] quarantined_non_market=${before - kept.length} ids=${dropped.join(',')}`);
    }
    candidates = kept;
  }
  return options.limit ? candidates.slice(0, options.limit) : candidates;
}

/**
 * The listing facts of the given videos, by video id.
 *
 * A video can be in several listings, so the facts are merged: the LONGEST
 * duration wins (the live episode, not the clip), and the live status is
 * the one that says the video has been streamed.
 *
 * @param {string[]} videoIds
 * @returns {Map<string, {duration_sec: number|null, live_status: string, listing_kind: string}>}
 */
function listingFacts(videoIds) {
  const facts = new Map();
  if (!videoIds.length) return facts;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='video_listing_entries'",
  ).get();
  if (!table) {
    db.close();
    return facts;
  }
  const rows = db.prepare(
    `SELECT video_id, duration_sec, live_status, listing_kind FROM video_listing_entries
     WHERE video_id IN (${videoIds.map(() => '?').join(',')})`,
  ).all(...videoIds);
  db.close();

  for (const row of rows) {
    // yt-dlp prints "NA" for a video that is not a stream at all. It is not
    // a live status, and it must not read as one.
    const liveStatus = !row.live_status || row.live_status === 'NA' ? '' : row.live_status;
    const existing = facts.get(row.video_id);
    const duration = row.duration_sec === null ? null : Number(row.duration_sec);
    if (!existing) {
      facts.set(row.video_id, {
        duration_sec: duration,
        live_status: liveStatus,
        listing_kind: row.listing_kind || '',
      });
      continue;
    }
    existing.live_status = existing.live_status === 'was_live' ? 'was_live' : (liveStatus || existing.live_status);
    existing.listing_kind = existing.listing_kind || row.listing_kind;
    if (duration !== null && (existing.duration_sec === null || duration > existing.duration_sec)) {
      existing.duration_sec = duration;
    }
  }
  return facts;
}

/**
 * Where a video's transcript file lives.
 *
 * @param {string} videoId
 * @returns {string}
 */
function transcriptPathFor(videoId) {
  return path.join(TRANSCRIPTS_DIR, `${videoId}.json`);
}

/**
 * Get a transcript for one video, from whichever provider can supply it.
 *
 * @param {object} row - a catalog row
 * @returns {Promise<object>} a result record
 */
async function processVideo(row) {
  const transcriptPath = transcriptPathFor(row.video_id);

  if (fs.existsSync(transcriptPath) && !options.force) {
    return { video_id: row.video_id, ok: false, skipped: true, reason: 'transcript already on disk' };
  }

  const providers = options.provider === 'auto'
    ? ['youtube_auto', 'deepgram']
    : [options.provider];

  const errors = [];

  for (const provider of providers) {
    if (provider === 'deepgram' && !options.deepgramFallback && options.provider === 'auto') {
      errors.push('deepgram: fallback disabled');
      continue;
    }

    let outcome;
    if (provider === 'youtube_auto') {
      outcome = fetchYoutubeCaptions(row);
    } else if (provider === 'deepgram') {
      outcome = await fetchDeepgramTranscript(row, transcriptPath);
    } else {
      errors.push(`${provider}: unknown provider`);
      continue;
    }

    if (!outcome.ok) {
      errors.push(`${provider}: ${outcome.error}`);
      continue;
    }

    persistTranscript(row, provider, transcriptPath, outcome.segments, outcome.language);
    return {
      video_id: row.video_id,
      ok: true,
      provider,
      language: outcome.language || '',
      segments: outcome.segments.length,
      transcript_path: transcriptPath,
    };
  }

  return {
    video_id: row.video_id,
    ok: false,
    error: errors.join(' | ') || 'no provider produced a transcript',
  };
}

/**
 * Fetch the video's own auto-captions.
 *
 * Each requested language is tried in turn, and the first one that
 * produces a usable transcript wins.
 *
 * Two things this has to handle that the Revere/QMG path does not:
 *
 *   RATE LIMITING. The subtitle endpoint answers "HTTP Error 429: Too
 *   Many Requests" far more readily than the video endpoint does, because
 *   it is a different, lighter endpoint and yt-dlp hits it once per
 *   language. A 429 is transient, so it is retried with a wait -- but only
 *   a few times, because a persistent 429 means the IP is throttled and
 *   hammering it makes it worse.
 *
 *   THE JS RUNTIME. `--js-runtimes node` is required. Without it yt-dlp
 *   cannot extract the player and falls back to storyboard-only, which has
 *   no subtitles at all.
 *
 * @param {object} row
 * @returns {{ok: boolean, segments?: Array, error?: string, language?: string}}
 */
/**
 * Say WHY no caption file appeared -- and do not guess.
 *
 * A video that HAS no caption track is a fact about the video. A fetch that
 * FAILED -- a bot check, a cookie error, a network blip, a client that could
 * not extract the player -- is a fact about the RUN, and it says nothing
 * about the video.
 *
 * Reporting every failure as "no captions" put 119 wrong entries in the
 * channel's caption-less list: videos that do have captions, were fetched
 * once during a bad window, and were then never asked for again. That list
 * is a BLACKLIST -- the runner skips everything in it -- so a wrong entry is
 * permanent, and it sends a video with free captions to a PAID
 * transcription API instead.
 *
 * yt-dlp says which one it was. "There are no subtitles for the requested
 * languages" is the video's own answer; anything else is a failed request.
 * THE MESSAGE IS ON STDOUT -- yt-dlp puts its [info] lines there and only
 * its warnings on stderr, so reading stderr alone classifies every genuinely
 * absent caption track as a failed fetch.
 *
 * The three verdicts need three different responses: "no captions" is a
 * blacklist entry, "rate limited" is a wait, and "caption fetch failed" is
 * a retry. Only the first one is permanent.
 *
 * @param {string} lang
 * @param {string} stdout
 * @param {string} stderr
 * @param {boolean} rateLimited
 * @returns {string} the error to report
 */
function classifyMissingCaptions(lang, stdout, stderr, rateLimited) {
  const both = `${stdout || ''}\n${stderr || ''}`;

  // The rate limit is detected from the OUTPUT, not only from the flag the
  // caller passes. The flag is set by a check that runs before this call,
  // and a caller that forgets it -- or a second code path that never sets
  // it -- would report a throttled endpoint as a plain failure. The output
  // says it plainly, so the output is what is read.
  if (rateLimited || RATE_LIMITED_PATTERN.test(both)) {
    return `${lang}: rate limited (HTTP 429) -- the subtitle endpoint is throttling this IP`;
  }

  const genuinelyAbsent = /there are no subtitles|no subtitles for the requested|aren't any subtitles/i.test(both);
  if (genuinelyAbsent) return `${lang}: no captions`;

  // The detail is the last MEANINGFUL line -- a Python
  // RequestsDependencyWarning ends every run and says nothing about the
  // video or the request.
  const detail = (both.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^warnings?\.warn/i.test(l))
    .slice(-1)[0] || 'unknown error');
  return `${lang}: caption fetch failed (${detail})`;
}

function fetchYoutubeCaptions(row) {
  // The channel's suffix goes in the name of the raw VTT, so a channel
  // whose VTTs are not tracked can be told apart from one whose are.
  // The JSON's name is unchanged -- every tool looks it up as
  // `<video_id>.json`.
  const suffix = channelDefaults(options.channel).vttSuffix;
  const baseOut = path.join(TRANSCRIPTS_DIR, `${row.video_id}.captions${suffix ? `.${suffix}` : ''}`);
  const errors = [];

  for (const lang of options.subLangs) {
    let result = null;
    // Whether the LAST attempt was refused by the network rather than
    // simply finding no captions. The two are different facts and the
    // report has to keep them apart.
    let rateLimited = false;

    for (let attempt = 0; attempt < RATE_LIMIT_ATTEMPTS; attempt += 1) {
      result = spawnSync(PY, [
        '-3', '-m', 'yt_dlp',
        // AUTO AND MANUAL. `--write-auto-subs` alone leaves a video with
        // manually-uploaded captions looking caption-less, because
        // yt-dlp only offers the tracks it was asked for. Both is
        // correct for a channel where some videos carry hand-made
        // subtitles and the rest have YouTube's automatic ones.
        '--write-auto-subs',
        '--write-subs',
        '--skip-download',
        '--sub-lang', lang,
        '--convert-subs', 'vtt',
        ...youtubeClientArgs(),
        '-o', `${baseOut}.%(ext)s`,
        row.video_url,
      ], { encoding: 'utf8' });

      if (result.error) {
        errors.push(`${lang}: ${result.error.message}`);
        break;
      }
      const stderr = String(result.stderr || '');
      // A 429 is transient, but the wait is LONG. The subtitle endpoint
      // throttles the IP, and hammering it makes the throttle worse -- the
      // project's own rule is that a rate-limited YouTube session needs
      // 30-60 minutes of quiet.
      if (RATE_LIMITED_PATTERN.test(stderr)) {
        rateLimited = true;
        if (attempt === RATE_LIMIT_ATTEMPTS - 1) break;
        const waitSeconds = RATE_LIMIT_WAIT_SECONDS * (attempt + 1);
        console.log(`[sevcik-transcripts] ${row.video_id}: rate limited on "${lang}", waiting ${waitSeconds}s`);
        sleep(waitSeconds * 1000);
        continue;
      }
      break;
    }

    if (!result || result.error) continue;

    const vttPath = `${baseOut}.${lang}.vtt`;
    if (!fs.existsSync(vttPath)) {
      // The distinction matters and is easy to lose. A language the
      // video does not HAVE is a fact about the video; a language that
      // was refused is a fact about the network. Reporting both as "no
      // captions" hides which one happened, and the two need different
      // responses -- one waits, the other gives up on that language.
      errors.push(classifyMissingCaptions(lang, result.stdout, result.stderr, rateLimited));
      continue;
    }

    const vtt = fs.readFileSync(vttPath, 'utf8');
    const segments = normalizeTranscript({ segments: vttToSegments(vtt) }, 'youtube_auto');
    if (!segments.length) {
      errors.push(`${lang}: captions were empty`);
      continue;
    }

    return { ok: true, segments, language: lang };
  }

  return { ok: false, error: errors.join(' | ') || 'no auto-captions' };
}

/**
 * Wait, synchronously.
 *
 * @param {number} ms
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Download the audio and transcribe it with Deepgram.
 *
 * @param {object} row
 * @param {string} transcriptPath
 * @returns {Promise<{ok: boolean, segments?: Array, error?: string}>}
 */
async function fetchDeepgramTranscript(row, transcriptPath) {
  if (!hasDeepgramKey()) {
    return { ok: false, error: 'DEEPGRAM_API_KEY is not set' };
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const audioStem = path.join(AUDIO_DIR, row.video_id);

  // Download the audio only. The full video of a one-hour stream is
  // hundreds of megabytes and none of it is needed for a transcript.
  const download = spawnSync(PY, [
    '-3', '-m', 'yt_dlp',
    '--no-playlist',
    '-f', 'bestaudio/best',
    ...youtubeClientArgs(),
    '-o', `${audioStem}.%(ext)s`,
    row.video_url,
  ], { encoding: 'utf8' });

  if (download.error) {
    return { ok: false, error: `audio download failed: ${download.error.message}` };
  }

  const downloaded = findAudioFile(audioStem);
  if (!downloaded) {
    const stderr = String(download.stderr || '').trim().split('\n').slice(-2).join(' ');
    return { ok: false, error: `no audio downloaded${stderr ? `: ${stderr}` : ''}` };
  }

  const mp3Path = `${audioStem}.mp3`;
  const extracted = extractAudio(downloaded, mp3Path);
  if (!extracted.ok) {
    if (!options.keepAudio) {
      safeUnlink(mp3Path);
      if (downloaded !== mp3Path) safeUnlink(downloaded);
    }
    return { ok: false, error: `audio extraction failed: ${extracted.error}` };
  }

  const transcribed = await transcribeAudio(mp3Path, {
    language: channelDefaults(options.channel).deepgramLanguage,
  });
  if (!transcribed.ok) {
    if (!options.keepAudio) {
      safeUnlink(mp3Path);
      if (downloaded !== mp3Path) safeUnlink(downloaded);
    }
    return { ok: false, error: transcribed.error };
  }

  const segments = normalizeTranscript(transcribed.payload, 'deepgram');
  if (!segments.length) {
    if (!options.keepAudio) {
      safeUnlink(mp3Path);
      if (downloaded !== mp3Path) safeUnlink(downloaded);
    }
    return { ok: false, error: 'Deepgram returned no utterances' };
  }

  if (!options.keepAudio) {
    safeUnlink(mp3Path);
    if (downloaded !== mp3Path) safeUnlink(downloaded);
  }

  // The language is reported, not assumed. It selects the acoustic model,
  // so it is a fact about the request -- and the transcript row used to
  // record `en` for every Deepgram transcript, whatever language the
  // request actually used.
  return { ok: true, segments, language: transcribed.language || deepgramLanguage() };
}

/**
 * The audio file yt-dlp wrote, whatever extension it chose.
 *
 * @param {string} stem
 * @returns {string|null}
 */
function findAudioFile(stem) {
  const directory = path.dirname(stem);
  const base = path.basename(stem);
  if (!fs.existsSync(directory)) return null;
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(base) && !name.endsWith('.mp3'))
    .map((name) => path.join(directory, name));
  return candidates.length ? candidates[0] : null;
}

/**
 * Write the transcript file and the database rows.
 *
 * The file has the same shape `tools/fetchCaptions.js` writes, so the two
 * tools agree on what a transcript file looks like, and the `provider` and
 * `language` fields record which provider produced it and in what
 * language.
 *
 * @param {object} row
 * @param {string} provider
 * @param {string} transcriptPath
 * @param {Array} segments
 * @param {string} [language]
 */
function persistTranscript(row, provider, transcriptPath, segments, language) {
  const checksum = transcriptChecksum(segments);
  const fetchedAt = new Date().toISOString();

  fs.writeFileSync(transcriptPath, JSON.stringify({
    video_id: row.video_id,
    channel: row.channel,
    title: row.title,
    provider,
    language: language || '',
    fetched_at: fetchedAt,
    segment_count: segments.length,
    checksum,
    segments: segments.map((segment) => ({
      start_ts: segment.start_sec,
      end_ts: segment.end_sec,
      text: segment.text,
      confidence: segment.confidence,
    })),
  }, null, 2), 'utf8');

  const db = new DatabaseSync(DB_PATH);
  // Another tool (an extractor) may be writing the same catalog. Wait for
  // its lock instead of failing the video.
  db.exec('PRAGMA busy_timeout = 30000');
  db.exec(fs.readFileSync(path.join(ROOT, 'data', 'db', 'schema.sql'), 'utf8'));
  // `transcript_segments` is not in the catalog -- it is a cache in its own
  // untracked file, and attaching it is what makes the unqualified SQL below
  // resolve to that file. See src/transcript/segmentStore.js.
  attachSegments(db);

  // One transaction: the transcript row, its ~1,000 segments and the catalog
  // pointer land together or not at all. Row-by-row autocommit left a
  // half-written segment cache when another writer held the lock.
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertTranscript(db, row, provider, transcriptPath, segments, checksum, fetchedAt, language);
    db.prepare(
      'UPDATE videos SET transcript_path = ?, transcript_segment_count = ?, transcript_fetched_at = ?, updated_at = ? '
      + 'WHERE video_id = ?',
    ).run(transcriptPath, segments.length, fetchedAt, fetchedAt, row.video_id);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    db.close();
    throw error;
  }
  db.close();
}

/**
 * Insert or update the transcript row and its segments.
 *
 * The re-run case matters: a second run over the same video must not leave
 * two transcript rows, and the segments must not be duplicated either. The
 * UNIQUE(video_id) constraint on the table makes the first half
 * impossible; the segments are deleted and rewritten, because a transcript
 * that changed has different segments.
 *
 * @param {DatabaseSync} db
 * @param {object} row
 * @param {string} provider
 * @param {string} transcriptPath
 * @param {Array} segments
 * @param {string} checksum
 * @param {string} fetchedAt
 * @param {string} [language]
 * @returns {number} the transcript id
 */
function upsertTranscript(db, row, provider, transcriptPath, segments, checksum, fetchedAt, language) {
  const existing = db.prepare('SELECT id, checksum FROM video_transcripts WHERE video_id = ?')
    .get(row.video_id);
  // No language is claimed unless the provider reported one. The old
  // default of `en` for Deepgram was wrong twice over: the channel is
  // Czech, and `language` selects the acoustic model, so the value says
  // which model read the audio -- not which language the speaker used.
  const lang = language || '';

  let transcriptId;
  if (existing) {
    transcriptId = Number(existing.id);
    db.prepare(
      'UPDATE video_transcripts SET provider = ?, language = ?, transcript_path = ?, segment_count = ?, '
      + 'checksum = ?, fetched_at = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(provider, lang, transcriptPath, segments.length, checksum, fetchedAt, transcriptId);
    db.prepare('DELETE FROM transcript_segments WHERE transcript_id = ?').run(transcriptId);
  } else {
    const result = db.prepare(
      'INSERT INTO video_transcripts (video_id, provider, language, transcript_path, segment_count, '
      + 'checksum, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.video_id, provider, lang, transcriptPath, segments.length, checksum, fetchedAt);
    transcriptId = Number(result.lastInsertRowid);
  }

  const insertSegment = db.prepare(
    'INSERT INTO transcript_segments (transcript_id, video_id, segment_index, start_sec, end_sec, text, confidence) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  segments.forEach((segment, index) => {
    insertSegment.run(
      transcriptId,
      row.video_id,
      index,
      segment.start_sec,
      segment.end_sec,
      segment.text,
      segment.confidence === null || segment.confidence === undefined ? null : segment.confidence,
    );
  });

  return transcriptId;
}

/**
 * Parse a WebVTT document into the project's own transcript shape.
 *
 * @param {string} vttText
 * @returns {Array<{start_ts:number,end_ts:number,text:string}>}
 */
function vttToSegments(vttText) {
  const { normalizeVtt } = require('../src/transcript/transcriptNormalize');
  return normalizeVtt(vttText).map((segment) => ({
    start_ts: segment.start_sec,
    end_ts: segment.end_sec,
    text: segment.text,
  }));
}

function safeUnlink(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    // A leftover audio file is not worth failing a run over.
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] || 0) + 1;
  return counts;
}

function readFlag(arr, flag) {
  const index = arr.indexOf(flag);
  if (index === -1) return null;
  return arr[index + 1] || '';
}

module.exports = { classifyMissingCaptions };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[sevcik-transcripts] failed: ${error && error.stack ? error.stack : error}`);
    process.exit(1);
  });
}
