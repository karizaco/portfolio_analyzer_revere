'use strict';

// Group a Czech transcript into the SETUPS the speaker describes.
//
// EPISODES, NOT ONE ROW PER TICKER: a single name often carries several
// predictions in one stream. Those are separate episodes.
//
// STATE VERBS NEED SETUP CONTEXT: bare "vyšly dobře" (earnings) is not a
// setup outcome. Outcome verbs only count next to predikce/setup/idea.
//
// THE RUN MODEL: the subject of a stream is one thing at a time. Markers
// inside a run belong to that ticker.

const { findCzechCompanyNames } = require('./czechNames');
const { readSetupCertainty } = require('./certainty');

/**
 * Lifecycle phrases. Terminal verbs require setup context nearby.
 */
const SETUP_STATES = [
  { state: 'invalidated', weight: 3, requiresSetupContext: true, pattern: /(?<![\p{L}\p{N}])(?:zneplatn[\p{L}\p{N}]*|neplatn[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'failed', weight: 3, requiresSetupContext: true, pattern: /(?<![\p{L}\p{N}])(?:nevyšl[\p{L}\p{N}]*|nevys[\p{L}\p{N}]*|nevyšel[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'worked', weight: 3, requiresSetupContext: true, pattern: /(?<![\p{L}\p{N}])(?:vyšl[\p{L}\p{N}]*|vysl[\p{L}\p{N}]*|vyšel[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'new', weight: 2, requiresSetupContext: false, pattern: /(?<![\p{L}\p{N}])(?:nov(?:[aá]|ou|u|ý|ouho|ého|ému|ém|ými)\s+(?:predikc[\p{L}\p{N}]*|setup[\p{L}\p{N}]*|idej[\p{L}\p{N}]*)|další\s+predikc[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'running', weight: 2, requiresSetupContext: false, pattern: /(?<![\p{L}\p{N}])(?:predikce\s+běží|predikce\s+stále|predikc[\p{L}\p{N}]*\s+běží|běží\s+predikc[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu },
  { state: 'old', weight: 1, requiresSetupContext: true, pattern: /(?<![\p{L}\p{N}])(?:byla\s+stará|stará\s+predikc[\p{L}\p{N}]*|predikc[\p{L}\p{N}]*\s+(?:byla\s+)?stará)(?![\p{L}\p{N}])/iu },
];

/** Words that mean the sentence is about a setup/prediction. */
const SETUP_CONTEXT = /(?<![\p{L}\p{N}])(?:predikc[\p{L}\p{N}]*|setup[\p{L}\p{N}]*|idej[\p{L}\p{N}]*|scénář[\p{L}\p{N}]*|scenar[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu;

/** Marks a setup sentence. Outcome verbs alone are NOT markers. */
const SETUP_MARKER = /(?<![\p{L}\p{N}])(?:predikc[\p{L}\p{N}]*|setup[\p{L}\p{N}]*|idej[\p{L}\p{N}]*|scénář[\p{L}\p{N}]*|scenar[\p{L}\p{N}]*)(?![\p{L}\p{N}])/iu;

/** Soft still-valid language inside an already-marked setup sentence. */
const STILL_RUNNING = /(?<![\p{L}\p{N}])(?:běží|bězí|platí|neustále)(?![\p{L}\p{N}])/iu;

function isLiveState(state) {
  return state === 'running' || state === 'new';
}

function isTerminalState(state) {
  return state === 'worked'
    || state === 'failed'
    || state === 'invalidated'
    || state === 'old';
}

function hasSetupContext(text) {
  return SETUP_CONTEXT.test(String(text || ''));
}

/**
 * The state a sentence states, if any.
 * Outcome verbs only count with setup vocabulary nearby.
 *
 * @param {string} text
 * @returns {string}
 */
function readSetupState(text) {
  const str = String(text || '');

  let best = { state: '', weight: 0 };
  for (const entry of SETUP_STATES) {
    // Clone with an explicit g-flag so we can walk matches once.
    const flags = entry.pattern.flags.includes('g') ? entry.pattern.flags : entry.pattern.flags + 'g';
    const pattern = new RegExp(entry.pattern.source, flags);
    let match;
    while ((match = pattern.exec(str)) !== null) {
      if (entry.requiresSetupContext) {
        const left = Math.max(0, match.index - 48);
        const right = Math.min(str.length, match.index + match[0].length + 48);
        if (!hasSetupContext(str.slice(left, right))) continue;
      }
      if (entry.weight > best.weight) {
        best = { state: entry.state, weight: entry.weight };
      }
      // Avoid zero-length match infinite loops.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  if (best.state) return best.state;
  if (hasSetupContext(str)) return 'running';
  return '';
}

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


/**
 * Find setup episodes in a transcript.
 *
 * @param {object} options
 * @param {Array<{text:string}>} options.segments
 * @param {Set<string>|string[]} options.lexicon
 * @returns {Array<object>}
 */
function findSetups(options) {
  const segments = Array.isArray(options.segments) ? options.segments : [];
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set(options.lexicon || []);
  if (!segments.length) return [];

  const runs = buildSetupRuns(segments, lexicon);

  const markers = [];
  for (const run of runs) {
    for (const piece of run.pieces) {
      if (!SETUP_MARKER.test(piece.text)) continue;
      const state = readSetupState(piece.text);
      if (!state) continue;
      markers.push({
        ticker: run.ticker,
        spoken_name: run.spoken_name,
        index: piece.index,
        text: piece.text,
        state,
      });
    }
  }

  const episodes = [];
  const openByTicker = new Map();

  const closeEpisode = (ticker) => {
    const episode = openByTicker.get(ticker);
    if (!episode) return;
    episodes.push(episode);
    openByTicker.delete(ticker);
  };

  const openEpisode = (marker) => {
    const episode = {
      ticker: marker.ticker,
      spoken_name: marker.spoken_name,
      markers: [],
      states: [],
      first_index: marker.index,
      last_index: marker.index,
    };
    openByTicker.set(marker.ticker, episode);
    return episode;
  };

  for (const marker of markers) {
    let episode = openByTicker.get(marker.ticker);
    if (!episode) {
      episode = openEpisode(marker);
    } else {
      const finalState = episode.states[episode.states.length - 1] || '';
      const startsFresh = marker.state === 'new' && episode.states.length > 0;
      const afterTerminal = isTerminalState(finalState);
      if (startsFresh || afterTerminal) {
        closeEpisode(marker.ticker);
        episode = openEpisode(marker);
      }
    }

    episode.markers.push(marker);
    episode.states.push(marker.state);
    episode.first_index = Math.min(episode.first_index, marker.index);
    episode.last_index = Math.max(episode.last_index, marker.index);
    if (marker.spoken_name) episode.spoken_name = marker.spoken_name;
  }

  for (const ticker of [...openByTicker.keys()]) closeEpisode(ticker);

  return episodes
    .map((episode) => {
      const evidenceParts = episode.markers.map((marker) => marker.text.trim()).filter(Boolean);
      const evidenceText = evidenceParts.join(' ');
      const certainty = readSetupCertainty(evidenceText);
      const finalState = episode.states[episode.states.length - 1] || '';
      const claimKind = isTerminalState(finalState) ? 'retrospective' : 'forward';
      return {
        ticker: episode.ticker,
        spoken_name: episode.spoken_name,
        state: finalState,
        states: episode.states.slice(),
        mentions: episode.markers.length,
        first_index: episode.first_index,
        last_index: episode.last_index,
        certainty_level: certainty.level,
        certainty_confidence: certainty.confidence,
        certainty_marker: certainty.marker,
        probability: certainty.probability == null ? null : certainty.probability,
        direction_uncertain: certainty.direction_uncertain ? 1 : 0,
        still_running: isLiveState(finalState),
        invalidated: episode.states.includes('invalidated'),
        worked: episode.states.includes('worked'),
        failed: episode.states.includes('failed'),
        claim_kind: claimKind,
        evidence: evidenceParts,
      };
    })
    .filter((setup) => setup.ticker && setup.state)
    .sort((a, b) => a.first_index - b.first_index || String(a.ticker).localeCompare(String(b.ticker)));
}

module.exports = {
  SETUP_MARKER,
  SETUP_STATES,
  buildSetupRuns,
  findSetups,
  hasSetupContext,
  isLiveState,
  isTerminalState,
  readSetupState,
};
