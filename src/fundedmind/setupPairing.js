'use strict';

// Collapse FundedMind utterance-level trade_signals into session setups.
// Pure post-process: does not re-parse transcripts.

/**
 * @typedef {object} SignalLike
 * @property {string} video_id
 * @property {string} [ticker]
 * @property {string} [action]
 * @property {string} [bias]
 * @property {string} [claim_kind]
 * @property {number|null} [event_time_sec]
 * @property {number|null} [entry_price]
 * @property {number|null} [stop_price]
 * @property {number|null} [target_price_low]
 * @property {string} [evidence_text]
 * @property {string} [rationale]
 * @property {string} [parser_version]
 */

function fieldFromRationale(rationale, key) {
  const m = String(rationale || '').match(new RegExp(`${key}=([^;]+)`));
  return m ? m[1].trim() : '';
}

function sideFromBias(bias, action) {
  if (bias === 'bullish') return 'long';
  if (bias === 'bearish') return 'short';
  return '';
}

function actionabilityScore(setup) {
  let score = 0;
  if (setup.side) score += 1;
  const hasOpen = setup.entry_price != null
    || (Array.isArray(setup.events) && setup.events.some((e) => e && e.action === 'open'));
  if (hasOpen) score += 1;
  if (setup.ticker_from && setup.ticker_from !== 'session_default' && setup.ticker_from !== 'session_dominant') {
    score += 1;
  }
  if (setup.stop_price != null || (setup.targets && setup.targets.length)) score += 1;
  if (setup.status === 'closed' || setup.status === 'stopped') score += 1;
  if (setup.claim_kind === 'plan') score -= 1;
  if (setup.ticker_from === 'session_dominant' && setup.stop_price == null) score -= 1;
  return score;
}

/**
 * Pair ordered signals from one video into setups.
 * @param {SignalLike[]} signals
 * @param {{host?: string, kind?: string, session_date?: string, title?: string}} meta
 */
function pairSetupsForVideo(signals, meta = {}) {
  const rows = (Array.isArray(signals) ? signals.slice() : []).sort((a, b) => {
    const ta = Number(a.event_time_sec);
    const tb = Number(b.event_time_sec);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return 0;
  });

  /** @type {Map<string, object>} */
  const active = new Map(); // key = `${ticker}|${side||'na'}`
  const closed = [];

  function keyOf(ticker, side) {
    return `${ticker}|${side || 'na'}`;
  }

  function finalize(setup, status, endEvent) {
    setup.status = status;
    setup.end_sec = endEvent && endEvent.event_time_sec != null ? Number(endEvent.event_time_sec) : setup.end_sec;
    if (endEvent) {
      setup.events.push(endEvent);
      if (endEvent.evidence_text) setup.evidence.push(endEvent.evidence_text);
    }
    setup.score = actionabilityScore(setup);
    closed.push(setup);
  }

  for (const raw of rows) {
    const ticker = String(raw.ticker || '').trim();
    if (!ticker) continue;
    const action = String(raw.action || '');
    const side = sideFromBias(raw.bias, action) || fieldFromRationale(raw.rationale, 'side');
    const tickerFrom = fieldFromRationale(raw.rationale, 'ticker_from');
    const event = {
      action,
      side,
      event_time_sec: raw.event_time_sec == null ? null : Number(raw.event_time_sec),
      entry_price: raw.entry_price,
      stop_price: raw.stop_price,
      target_price_low: raw.target_price_low,
      evidence_text: raw.evidence_text || '',
      claim_kind: raw.claim_kind || '',
      ticker_from: tickerFrom,
    };

    if (action === 'open') {
      // Flip: close opposite or same-ticker active without side match.
      for (const [k, setup] of [...active.entries()]) {
        if (setup.ticker !== ticker) continue;
        if (side && setup.side && setup.side !== side) {
          finalize(setup, 'flipped', event);
          active.delete(k);
        } else if (!side || !setup.side || setup.side === side) {
          // replace same-side open
          finalize(setup, 'replaced', event);
          active.delete(k);
        }
      }
      const setup = {
        video_id: raw.video_id,
        session_date: meta.session_date || '',
        host: meta.host || fieldFromRationale(raw.rationale, 'host'),
        kind: meta.kind || fieldFromRationale(raw.rationale, 'kind'),
        title: meta.title || '',
        ticker,
        side: side || '',
        status: 'open',
        start_sec: event.event_time_sec,
        end_sec: null,
        entry_price: raw.entry_price,
        stop_price: raw.stop_price,
        targets: raw.target_price_low != null ? [raw.target_price_low] : [],
        ticker_from: tickerFrom,
        claim_kind: raw.claim_kind || 'forward',
        evidence: event.evidence_text ? [event.evidence_text] : [],
        events: [event],
        parser_version: raw.parser_version || '',
        score: 0,
        recap_verdict: '',
        recap_evidence: '',
        recap_video_id: '',
      };
      active.set(keyOf(ticker, side), setup);
      continue;
    }

    // Attach to best active setup on ticker (prefer matching side).
    let targetKey = side ? keyOf(ticker, side) : '';
    let setup = targetKey ? active.get(targetKey) : null;
    if (!setup) {
      for (const [k, s] of active.entries()) {
        if (s.ticker === ticker) {
          setup = s;
          targetKey = k;
          break;
        }
      }
    }
    if (!setup) {
      // orphan exit/target/stop → synthetic short setup
      setup = {
        video_id: raw.video_id,
        session_date: meta.session_date || '',
        host: meta.host || fieldFromRationale(raw.rationale, 'host'),
        kind: meta.kind || fieldFromRationale(raw.rationale, 'kind'),
        title: meta.title || '',
        ticker,
        side: side || '',
        status: 'orphan',
        start_sec: event.event_time_sec,
        end_sec: event.event_time_sec,
        entry_price: null,
        stop_price: raw.stop_price,
        targets: raw.target_price_low != null ? [raw.target_price_low] : [],
        ticker_from: tickerFrom,
        claim_kind: raw.claim_kind || '',
        evidence: event.evidence_text ? [event.evidence_text] : [],
        events: [event],
        parser_version: raw.parser_version || '',
        score: 0,
        recap_verdict: '',
        recap_evidence: '',
        recap_video_id: '',
      };
      if (action === 'stop_out') setup.status = 'stopped';
      else if (action === 'exit') setup.status = 'closed';
      else setup.status = 'partial';
      setup.score = actionabilityScore(setup);
      closed.push(setup);
      continue;
    }

    setup.events.push(event);
    if (event.evidence_text) setup.evidence.push(event.evidence_text);
    if (raw.stop_price != null) setup.stop_price = raw.stop_price;
    if (raw.target_price_low != null) setup.targets.push(raw.target_price_low);
    if (raw.entry_price != null && setup.entry_price == null) setup.entry_price = raw.entry_price;
    if (tickerFrom && (!setup.ticker_from || setup.ticker_from === 'session_default')) {
      setup.ticker_from = tickerFrom;
    }

    if (action === 'stop_out') {
      finalize(setup, 'stopped', null);
      active.delete(targetKey);
    } else if (action === 'exit') {
      finalize(setup, 'closed', null);
      active.delete(targetKey);
    } else if (action === 'trim' || action === 'target') {
      // stay active
      setup.score = actionabilityScore(setup);
    }
  }

  for (const [k, setup] of active.entries()) {
    finalize(setup, 'still_open', null);
    active.delete(k);
  }

  return closed.sort((a, b) => (b.score - a.score) || ((a.start_sec || 0) - (b.start_sec || 0)));
}

/**
 * Group setups by calendar session_date across videos.
 * @param {object[]} setups
 */
function groupSetupsByDay(setups) {
  const byDay = new Map();
  for (const s of setups) {
    const day = s.session_date || 'unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([session_date, rows]) => ({
      session_date,
      setup_count: rows.length,
      tickers: [...new Set(rows.map((r) => r.ticker))].sort(),
      hosts: [...new Set(rows.map((r) => r.host).filter(Boolean))],
      setups: rows.sort((a, b) => b.score - a.score),
    }));
}

module.exports = {
  actionabilityScore,
  fieldFromRationale,
  groupSetupsByDay,
  pairSetupsForVideo,
};
