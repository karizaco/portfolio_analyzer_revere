'use strict';

// THE VERDICTS a caption fetch can reach, and the stream they are read
// from. One implementation, two callers -- `tools/fetchSevcikTranscripts.js`
// (which writes the blacklist) and `tools/auditNoCaptions.js` (which
// re-verifies it). If the two disagreed, the audit would measure a
// different thing than the fetch wrote, and the list would stay wrong
// while both reported it as checked.
//
// THE STREAM MATTERS, and it is the defect that put 119 wrong entries in
// the T3Live caption-less list on 2026-11-10. yt-dlp prints
//
//     "There are no subtitles for the requested languages"
//     "x has no automatic captions"
//
// on STDOUT, and only its warnings on stderr. Reading stderr alone
// classifies every genuinely absent track as a failed fetch -- and,
// once the two verdicts were collapsed into one message, every failed
// fetch as an absent track. A wrong blacklist entry is PERMANENT and
// costs money: the video goes to a paid transcription API for audio
// YouTube would transcribe for free.

/**
 * The rate limit, in every wording yt-dlp uses for it.
 *
 * The endpoint says "rate-limited by YouTube for up to an hour" and
 * "HTTP Error 429", and a transcript's DETAIL TEXT can contain either
 * phrase while describing something else -- so the pattern is matched
 * against the whole output and a rate limit outranks an absence.
 */
const RATE_LIMITED_PATTERN = /rate.?limited|HTTP\s*Error\s*429|too many requests|429\b/i;

/** The words that say the track is absent -- YouTube's own answer. */
const ABSENT_PATTERN = /there are no subtitles|no subtitles for the requested|aren't any subtitles|has no automatic captions/i;

/**
 * Classify a caption fetch.
 *
 * @param {string} stdout  yt-dlp's stdout -- where the verdict lives
 * @param {string} stderr  yt-dlp's stderr -- warnings and errors
 * @param {boolean} [rateLimited]  a caller-detected rate limit, as well
 * @returns {{ verdict: string, permanent: boolean, detail: string }}
 *   `permanent: true` means "YouTube said the track is absent", and it
 *   is the ONLY thing that may keep a video on the caption-less
 *   blacklist. Everything else is a failure of the REQUEST and must be
 *   retried.
 */
function classifyCaptionFetch(stdout, stderr, rateLimited = false) {
  const both = `${stdout || ''}\n${stderr || ''}`;

  // The rate limit is detected from the OUTPUT, not only from the flag
  // the caller passes. The flag is set by a check that runs before the
  // call, and a caller that forgets it -- or a second code path that
  // never sets it -- would report a throttled endpoint as a plain
  // failure. The output says it plainly, so the output is what is read.
  if (rateLimited || RATE_LIMITED_PATTERN.test(both)) {
    return {
      verdict: 'rate limited (HTTP 429)',
      permanent: false,
      detail: 'the endpoint is throttling this IP',
    };
  }

  // THE TABLE IS THE RECEIPT. `live_chat` is not a caption track -- it
  // is the stream's chat replay -- so a table that holds only that is a
  // video with NO captions. A rule that counted it would blacklist
  // nothing, and the list would stay wrong forever. The table's rows are
  // `code  name  formats` (three fields), so the track is the FIRST
  // token of each row; the header line and the video-id line above it
  // are not rows.
  const table = (stdout || '').split(/Available (?:automatic )?captions? for/i)[1] || '';
  const tracks = table.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^Language\s/i.test(l))
    .map((l) => l.split(/\s+/)[0].replace(/:$/, ''))
    .filter((lang) => lang && !/^[A-Za-z0-9_-]{11}$/.test(lang));
  const realTracks = tracks.filter((lang) => lang !== 'live_chat');

  if (ABSENT_PATTERN.test(both) && (realTracks.length === 0 || /there are no subtitles|no subtitles for the requested/i.test(both))) {
    return {
      verdict: 'no captions',
      permanent: true,
      detail: 'verified by --list-subs: YouTube reports no caption track',
    };
  }
  if (realTracks.length > 0) {
    return {
      verdict: 'HAS CAPTIONS',
      permanent: false,
      detail: `${realTracks.slice(0, 4).join(', ')} -- wrongly blacklisted`,
    };
  }

  if (/Video unavailable|Private video|This video is not available/i.test(both)) {
    return {
      verdict: 'video unavailable',
      permanent: true,
      detail: 'not a caption question -- the video cannot be fetched either way',
    };
  }

  // The detail is the last MEANINGFUL line -- a Python
  // RequestsDependencyWarning ends every run and says nothing about the
  // video or the request.
  const detail = (both.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^warnings?\.warn/i.test(l))
    .slice(-1)[0] || 'unknown error');
  return { verdict: 'caption fetch failed', permanent: false, detail };
}

/**
 * The blacklist entry this verdict justifies, or `null` when the video
 * must NOT be blacklisted. Only YouTube's own answer may blacklist.
 */
function blacklistEntryFor(result) {
  return result.permanent ? `${result.verdict} (${result.detail})` : null;
}

module.exports = { classifyCaptionFetch, blacklistEntryFor, RATE_LIMITED_PATTERN, ABSENT_PATTERN };
