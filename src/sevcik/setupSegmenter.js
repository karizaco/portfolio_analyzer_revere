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
const { determineBias } = require('./signalExtractor');
const { collapseRollingCues, sourceIndexOf } = require('../transcript/transcriptNormalize');

/** Max segment gap before same-ticker markers become a new episode. */
const EPISODE_MERGE_GAP = 45;

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
  return state === 'running' || state === 'new' || state === 'open';
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
  // Soft still-running language inside a setup sentence counts as running.
  if (STILL_RUNNING.test(str) && (hasSetupContext(str) || SETUP_MARKER.test(str))) {
    return 'running';
  }
  // Bare setup vocabulary without a lifecycle verb is an OPEN claim, not
  // proof that he said the old prediction is still running.
  if (hasSetupContext(str) || SETUP_MARKER.test(str)) return 'open';
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
  const rawSegments = Array.isArray(options.segments) ? options.segments : [];
  const lexicon = options.lexicon instanceof Set ? options.lexicon : new Set(options.lexicon || []);
  if (!rawSegments.length) return [];

  // Caption transcripts show every line twice (see collapseRollingCues),
  // which doubled `mentions` and the evidence. Indices are reported in the
  // stored numbering via source_index.
  const segments = collapseRollingCues(rawSegments);

  const runs = buildSetupRuns(segments, lexicon);

  const markers = [];
  for (const run of runs) {
    for (const piece of run.pieces) {
      if (!SETUP_MARKER.test(piece.text) && !hasSetupContext(piece.text)) continue;
      const state = readSetupState(piece.text);
      if (!state) continue;
      markers.push({
        ticker: run.ticker,
        spoken_name: run.spoken_name,
        index: piece.index,
        text: piece.text,
        state,
        explicit_still_running: STILL_RUNNING.test(piece.text) || state === 'running',
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
      explicit_still_running: false,
    };
    openByTicker.set(marker.ticker, episode);
    return episode;
  };

  for (const marker of markers) {
    let episode = openByTicker.get(marker.ticker);
    if (!episode) {
      episode = openEpisode(marker);
    } else {
      const gap = marker.index - episode.last_index;
      const finalState = episode.states[episode.states.length - 1] || '';
      const startsFresh = marker.state === 'new' && episode.states.length > 0;
      const farAway = gap > EPISODE_MERGE_GAP;
      // A live claim after a terminal outcome is a new episode (reopen).
      // Another terminal soon after stays the same retrospective episode.
      const reopenAfterTerminal = isTerminalState(finalState) && isLiveState(marker.state);
      const splitFarForward = farAway && isLiveState(finalState) && isLiveState(marker.state);
      if (startsFresh || reopenAfterTerminal || splitFarForward) {
        closeEpisode(marker.ticker);
        episode = openEpisode(marker);
      }
    }

    episode.markers.push(marker);
    episode.states.push(marker.state);
    episode.first_index = Math.min(episode.first_index, marker.index);
    episode.last_index = Math.max(episode.last_index, marker.index);
    if (marker.spoken_name) episode.spoken_name = marker.spoken_name;
    if (marker.explicit_still_running) episode.explicit_still_running = true;
  }

  for (const ticker of [...openByTicker.keys()]) closeEpisode(ticker);

  // Second pass: merge adjacent same-ticker near-duplicates.
  // Third pass: at most one forward + one retrospective episode per ticker
  // in a single video (the ledger unit the user wants).
  const merged = collapsePerTickerClaimFamily(mergeNearDuplicateEpisodes(episodes));

  return merged
    .map((episode) => {
      // Marker snippets keep the lifecycle verbs; the full segment span is
      // what carries direction (do Longu / short) spoken around the claim.
      const markerParts = episode.markers.map((marker) => marker.text.trim()).filter(Boolean);
      const spanParts = [];
      const start = Math.max(0, episode.first_index);
      const end = Math.min(segments.length - 1, episode.last_index);
      for (let i = start; i <= end; i += 1) {
        const t = String(segments[i] && segments[i].text || '').trim();
        if (t) spanParts.push(t);
      }
      const evidenceParts = spanParts.length ? spanParts : markerParts;
      const evidenceText = evidenceParts.join(' ');
      const finalState = pickFinalState(episode.states);
      const terminal = episode.states.some((state) => isTerminalState(state));
      const claimKind = terminal && !isLiveState(finalState) ? 'retrospective' : 'forward';

      const biasInfo = determineBias(evidenceText);
      let bias = biasInfo.bias || '';
      if (bias === 'neutral') bias = '';
      const directionUncertain = /(?<![\p{L}\p{N}])nev[ií]m(?![\p{L}\p{N}])/iu.test(evidenceText)
        || bias === 'mixed';

      const isPrediction = Boolean(
        claimKind === 'forward'
        && !directionUncertain
        && (bias === 'bullish' || bias === 'bearish')
      );

      const certainty = readSetupCertainty(evidenceText, {
        hasDirection: bias === 'bullish' || bias === 'bearish',
        isPrediction,
        directionUncertain,
      });

      const stillRunning = Boolean(
        episode.explicit_still_running
        || episode.states.includes('running')
      ) && !terminal;

      return {
        ticker: episode.ticker,
        spoken_name: episode.spoken_name,
        state: finalState,
        states: episode.states.slice(),
        mentions: episode.markers.length,
        first_index: sourceIndexOf(segments, episode.first_index),
        last_index: sourceIndexOf(segments, episode.last_index),
        bias: bias === 'mixed' ? 'mixed' : bias,
        is_prediction: Boolean(isPrediction),
        certainty_level: certainty.level,
        certainty_confidence: certainty.confidence,
        certainty_marker: certainty.marker,
        probability: certainty.probability == null ? null : certainty.probability,
        direction_uncertain: Boolean(directionUncertain),
        still_running: Boolean(stillRunning),
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

/**
 * Prefer terminal lifecycle when present; otherwise the last state.
 * @param {string[]} states
 * @returns {string}
 */
function pickFinalState(states) {
  const list = Array.isArray(states) ? states : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (isTerminalState(list[i])) return list[i];
  }
  return list[list.length - 1] || '';
}

/**
 * Collapse near-duplicate same-ticker episodes inside one video.
 * @param {Array<object>} episodes
 * @returns {Array<object>}
 */
function mergeNearDuplicateEpisodes(episodes) {
  if (!Array.isArray(episodes) || episodes.length < 2) return episodes || [];
  const ordered = [...episodes].sort((a, b) => a.first_index - b.first_index || String(a.ticker).localeCompare(String(b.ticker)));
  const kept = [];
  for (const episode of ordered) {
    const prev = kept.filter((row) => row.ticker === episode.ticker).pop();
    if (!prev) {
      kept.push(episode);
      continue;
    }
    const gap = episode.first_index - prev.last_index;
    const prevTerminal = prev.states.some((s) => isTerminalState(s));
    const nextTerminal = episode.states.some((s) => isTerminalState(s));
    const bothRetro = prevTerminal && nextTerminal;
    const bothForward = !prevTerminal && !nextTerminal;
    const hasNew = episode.states.includes('new');
    // Merge crowded same-ticker chatter; keep a genuine "nova predikce" split.
    if (gap <= EPISODE_MERGE_GAP && (bothRetro || (bothForward && !hasNew))) {
      prev.markers.push(...episode.markers);
      prev.states.push(...episode.states);
      prev.last_index = Math.max(prev.last_index, episode.last_index);
      prev.first_index = Math.min(prev.first_index, episode.first_index);
      if (episode.spoken_name) prev.spoken_name = episode.spoken_name;
      if (episode.explicit_still_running) prev.explicit_still_running = true;
      continue;
    }
    kept.push(episode);
  }
  return kept;
}

/**
 * Keep at most one forward and one retrospective episode per ticker.
 * @param {Array<object>} episodes
 * @returns {Array<object>}
 */
function collapsePerTickerClaimFamily(episodes) {
  if (!Array.isArray(episodes) || episodes.length < 2) return episodes || [];
  const buckets = new Map();
  const order = [];
  for (const episode of episodes) {
    const terminal = (episode.states || []).some((state) => isTerminalState(state));
    const key = `${episode.ticker}:${terminal ? 'R' : 'F'}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        ...episode,
        markers: [...(episode.markers || [])],
        states: [...(episode.states || [])],
      });
      order.push(key);
      continue;
    }
    const prev = buckets.get(key);
    prev.markers.push(...(episode.markers || []));
    prev.states.push(...(episode.states || []));
    prev.first_index = Math.min(prev.first_index, episode.first_index);
    prev.last_index = Math.max(prev.last_index, episode.last_index);
    if (episode.spoken_name) prev.spoken_name = episode.spoken_name;
    if (episode.explicit_still_running) prev.explicit_still_running = true;
  }
  return order.map((key) => buckets.get(key));
}


module.exports = {
  EPISODE_MERGE_GAP,
  SETUP_MARKER,
  SETUP_STATES,
  buildSetupRuns,
  findSetups,
  hasSetupContext,
  isLiveState,
  isTerminalState,
  collapsePerTickerClaimFamily,
  mergeNearDuplicateEpisodes,
  pickFinalState,
  readSetupState,
};
