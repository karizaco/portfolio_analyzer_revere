'use strict';

// Group a Czech transcript into the SETUPS the speaker describes.
//
// WHAT A SETUP IS HERE
//
// The speaker does not disclose positions. He describes SETUPS and
// IDEAS: "if it holds this level, long; if it breaks the channel edge,
// short". A setup is a thing he has said, and the point of this module
// is to say HOW MANY setups a video contains and WHICH ones they are.
//
// THE VOCABULARY
//
// He calls them "predikce" -- predictions -- 297 times in the corpus.
// The word carries the whole lifecycle:
//
//   "mám tady novou predikci"      a NEW setup is announced
//   "predikce běží"                the setup is STILL RUNNING
//   "predikce vyšla"               the setup WORKED
//   "predikce nevyšla"             the setup FAILED
//   "predikce zneplatněna"         the setup was INVALIDATED
//   "tahle ta predikce byla stará" this is an OLD setup, being reviewed
//
// So the setup's STATE is read off the sentence that mentions it, and
// the state is what makes the video's record readable: a viewer wants
// to know which setups were still running, which worked, and which were
// killed.
//
// THE RUN MODEL, NOT A WINDOW
//
// The subject of a stream is ONE THING AT A TIME. He talks about
// Tesla for three minutes, then Intel for two, and the sentences in
// between belong to whichever of the two he is on.
//
// So the transcript is scanned ONCE and cut into RUNS, each owned by
// one ticker -- the same model the signal extractor uses, and for the
// same reason. A window around each mention blends two setups into one,
// and a blended setup is not a setup: it has two tickers, two states
// and no meaning.
//
// WHY THE NEAREST-TICKER RULE WAS WRONG
//
// The first version attached each "predikce" sentence to the ticker
// nearest to it in the stream. Measured on the 12-video corpus it
// attached setups to the wrong ticker, and it dropped setups entirely:
//
//   zRiyF6dDekA (2026-10-23)   14 "predikce" sentences, 0 setups found
//
// Every one of those 14 sentences is about a setup, and the ticker was
// named in a sentence further away than the 3-segment window allowed.
// The run model finds them, because the run does not stop where a
// window did.
//
// And it attached a setup to the wrong ticker when it did fire:
// "MONETA" was given the evidence "byl by důkaz, že predikce vyšla.
// Zatím běží predikce na Airbag." -- the "Airbag" setup, on the
// Moneta row.
//
// A SETUP IS ABOUT ONE TICKER
//
// So the subject of a run is its ticker, and every "predikce"
// sentence in that run belongs to that ticker. The run is the subject
// change; the marker sentence is the state.
//
// THE STATE IS FROM THE WORDS, NOT FROM THE OUTCOME
//
// "predikce vyšla" means the setup worked. That is a fact about the
// SPEECH, and it is what a viewer of the video could check. It is not
// a judgement about whether the trade made money, and this module does
// not try to be one.
//
// WHAT IS NOT HERE
//
// The CONFIDENCE. The speaker never says "high conviction" -- he says
// a signal is "silnější" (stronger) or "jasný" (clear). The certainty
// scale is a separate module (`certainty.js`), because it is a
// judgement about language rather than a fact about the structure of
// the video.

const { findCzechCompanyNames } = require('./czechNames');
const { readSetupCertainty } = require('./certainty');

/**
 * The words that mark a setup's state, and the state they mark.
 *
 * The ORDER matters, because several of these phrases contain more than
 * one of the markers: "předtím predikce vyšlo 17, nevyšlo 1" mentions
 * both "vyšlo" and "nevyšlo". The longest and most specific phrase
 * wins, so the multi-word ones are checked first.
 */
const SETUP_STATES = [
  // The specific phrases, checked first.
  { state: 'invalidated', weight: 3, pattern: /(?<![\p{L}\p{N}])(?:zneplatn[\p{L}\p{N}]*|zrušen[\p{L}\p{N}]*|neplatn[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'failed', weight: 3, pattern: /(?<![\p{L}\p{N}])(?:nevyšl[\p{L}\p{N}]*|nevys[\p{L}\p{N}]*|nevyšel[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'worked', weight: 3, pattern: /(?<![\p{L}\p{N}])(?:vyšl[\p{L}\p{N}]*|vysl[\p{L}\p{N}]*|vyšel[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'new', weight: 2, pattern: /(?<![\p{L}\p{N}])(?:nov(?:[aá]|ou|u|ý|ouho|ého|ému|ém|ými)\s+(?:predikc[\p{L}\p{N}]*|setup[\p{L}\p{N}]*|idej[\p{L}\p{N}]*)|další\s+predikc[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'running', weight: 2, pattern: /(?<![\p{L}\p{N}])(?:predikce běží|predikce stále)(?![\p{L}\p{N}])/iu },
  { state: 'old', weight: 1, pattern: /(?<![\p{L}\p{N}])(?:byla stará|stará)(?![\p{L}\p{N}])/iu },
];

/**
 * The word that marks a setup at all.
 *
 * Measured: 297 occurrences of "predikce" in 10,847 segments, plus
 * "setup" and "idea" as the English and Czech equivalents.
 */
const SETUP_MARKER = /(?<![\p{L}\p{N}])(?:predikc[\p{L}\p{N}]*|setup[\p{L}\p{N}]*|idej[\p{L}\p{N}]*|scénář[\p{L}\p{N}]*|scenar[\p{L}\p{N}]*|vyšl[\p{L}\p{N}]*|nevyšl[\p{L}\p{N}]*|zneplatn[\p{L}\p{N}]*|zrušen[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu;

/**
 * The word that says the setup is STILL VALID.
 *
 * "predikce běží" -- the prediction is running. It is the most common
 * statement about a live setup and it is the one that says a setup has
 * not been invalidated.
 */
const STILL_RUNNING = /(?<![\p{L}\p{N}])(?:běží|bězí|platí|neustále)(?![\p{L}\p{N}])/iu;

/**
 * The state a sentence states, if any.
 *
 * @param {string} text
 * @returns {string}
 */
function readSetupState(text) {
  const str = String(text || '');

  let best = { state: '', weight: 0 };
  for (const entry of SETUP_STATES) {
    if (!entry.pattern.test(str)) continue;
    if (entry.weight > best.weight) best = { state: entry.state, weight: entry.weight };
  }

  if (best.state) return best.state;

  // A "setup" sentence that states no outcome is a setup that is still
  // running -- he is describing it, not reporting on it.
  return STILL_RUNNING.test(str) ? 'running' : 'running';
}

/**
 * The runs of text a ticker owns.
 *
 * THE MODEL
 *
 * A name belongs to the speech that FOLLOWS it until the next name. So
 * the transcript is scanned once, and the text is cut into runs, each
 * owned by one ticker.
 *
 * The first ticker of a segment owns the run-up to it: "Takže to 10
 * Amazon nevypadá špatně" -- "to 10" (this one) introduces Amazon.
 *
 * @param {Array<{text: string}>} segments
 * @param {Set<string>} lexicon
 * @returns {Array<{ticker: string, pieces: Array<{index: number, text: string}>, segmentStart: number, segmentEnd: number, text: string}>}
 */
function buildSetupRuns(segments, lexicon) {
  const runs = [];
  let open = null;

  const closeRun = () => {
    if (!open) return;
    open.text = open.pieces.map((piece) => piece.text).join(' ');
    runs.push(open);
    open = null;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const text = String(segments[index].text || '');
    if (!text.trim()) continue;

    // The names in this segment, in the order they appear.
    const names = findCzechCompanyNames(text, { lexicon })
      .filter((name) => name.ticker)
      .sort((a, b) => a.index - b.index);

    if (!names.length) {
      // A segment with no name continues the run that is open.
      if (open) {
        open.pieces.push({ index, text });
        open.segmentEnd = index;
      }
      continue;
    }

    for (let k = 0; k < names.length; k += 1) {
      // The first name of a segment owns the run-up to it; every other
      // name owns the text from itself to the next one.
      const pieceStart = k === 0 ? 0 : names[k].index;
      const pieceEnd = k + 1 < names.length ? names[k + 1].index : text.length;
      const piece = text.slice(pieceStart, pieceEnd);
      if (!piece.trim()) continue;

      if (!open || open.ticker !== names[k].ticker) {
        closeRun();
        open = {
          ticker: names[k].ticker,
          spoken_name: names[k].spoken,
          pieces: [],
          segmentStart: index,
          segmentEnd: index,
          text: '',
        };
      }
      open.pieces.push({ index, text: piece });
      open.segmentEnd = index;
    }
  }

  closeRun();
  return runs;
}

/**
 * Find the setups in a transcript.
 *
 * @param {object} options
 * @param {Array<{start_sec:number,end_sec:number,text:string}>} options.segments
 * @param {Set<string>} options.lexicon - the tickers that may be reported
 * @param {string} [options.videoId]
 * @returns {Array<object>} the setups, in the order they were introduced
 */
function findSetups(options) {
  const segments = Array.isArray(options.segments) ? options.segments : [];
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set(options.lexicon || []);
  if (!segments.length) return [];

  const runs = buildSetupRuns(segments, lexicon);
  if (!runs.length) return [];

  // 1. Every run that talks about a setup.
  //
  //    A run is ONE subject, so every "predikce" sentence in it is
  //    about that run's ticker. There is no search for the nearest
  //    ticker -- the run already knows.
  const setupRuns = [];
  for (const run of runs) {
    const markers = run.pieces.filter((piece) => SETUP_MARKER.test(piece.text));
    if (!markers.length) continue;

    setupRuns.push({
      ticker: run.ticker,
      spoken_name: run.spoken_name,
      segmentStart: run.segmentStart,
      segmentEnd: run.segmentEnd,
      text: run.text,
      markers: markers.map((piece) => ({
        index: piece.index,
        text: piece.text,
        state: readSetupState(piece.text),
      })),
    });
  }
  if (!setupRuns.length) return [];

  // 2. Fold the runs of one ticker into one setup.
  //
  //    The same ticker is talked about in several runs over a stream --
  //    he comes back to it. Those are ONE setup with several states,
  //    not several setups. The states are kept in order, because the
  //    ORDER is the story: "new" then "running" then "worked".
  const byTicker = new Map();
  for (const run of setupRuns) {
    if (!byTicker.has(run.ticker)) {
      byTicker.set(run.ticker, {
        ticker: run.ticker,
        spoken_name: run.spoken_name,
        runs: [],
        states: [],
        markers: [],
        first_index: run.segmentStart,
        last_index: run.segmentEnd,
        text: '',
      });
    }
    const group = byTicker.get(run.ticker);
    group.runs.push(run);
    for (const marker of run.markers) {
      group.markers.push(marker);
      if (!group.states.includes(marker.state)) group.states.push(marker.state);
    }
    group.first_index = Math.min(group.first_index, run.segmentStart);
    group.last_index = Math.max(group.last_index, run.segmentEnd);
    group.text += `${run.text} `;
  }

  // 3. Report them.
  return [...byTicker.values()]
    .map((group) => {
      const certainty = readSetupCertainty(group.text);
      const evidence = group.markers.map((marker) => marker.text.trim());
      return {
        ticker: group.ticker,
        spoken_name: group.spoken_name,
        // The state a setup is IN at the end of the video is the LAST one
        // it was stated in -- "predikce běží" after "predikce vyšla"
        // means it is running now.
        state: group.states[group.states.length - 1],
        states: group.states,
        mentions: group.markers.length,
        first_index: group.first_index,
        last_index: group.last_index,
        still_running: group.states.includes('running') || group.states.includes('new'),
        invalidated: group.states.includes('invalidated'),
        worked: group.states.includes('worked'),
        failed: group.states.includes('failed'),
        certainty_level: certainty.level,
        certainty_confidence: certainty.confidence,
        certainty_marker: certainty.marker,
        probability: certainty.probability,
        direction_uncertain: certainty.direction_uncertain,
        hedged: Boolean(certainty.hedged),
        evidence,
      };
    })
    .sort((a, b) => a.first_index - b.first_index);
}

module.exports = {
  SETUP_MARKER,
  SETUP_STATES,
  STILL_RUNNING,
  buildSetupRuns,
  findSetups,
  readSetupState,
};
