'use strict';

// A stated trade, as the two tables want it.
//
// trade_signals is a ticker table, so a verb with no subject does not go
// there. martinlukkt_trade_actions keeps every statement, including that
// one, because a missing ticker is a miss and a dropped row hides it.
//
// A review stream ("Oct trades") is history. A plan ("I'm going to short")
// has not happened. Neither is a call made on the session date, so neither
// is claim_kind 'forward'.

const { readTrades } = require('./tradeRead');
const { dateFromTitle, sessionKind } = require('./contentFilter');

const PARSER_VERSION = 'martinlukkt-signals-1';

/**
 * @param {{text: string, start_sec?: number}[]} segments
 * @param {{video_id?: string, title?: string, upload_date?: string}} video
 * @returns {object[]}
 */
function tradesFromSegments(segments, video) {
  const kind = sessionKind(video && video.title);
  const sessionDate = dateFromTitle(video && video.title) || String((video && video.upload_date) || '');
  return readTrades(segments).map((trade) => {
    const claimKind = kind === 'review' ? 'retrospective' : (trade.kind === 'plan' ? 'plan' : 'forward');
    const bias = trade.side === 'long' ? 'bullish' : (trade.side === 'short' ? 'bearish' : 'neutral');
    return {
      action: sharedAction(trade),
      bias,
      claim_kind: claimKind,
      confidence_label: '',
      confidence_score: null,
      entry_price: trade.price,
      event_time_sec: Number.isFinite(Number(trade.start_sec)) ? Number(trade.start_sec) : null,
      evidence_text: trade.evidence_text,
      horizon_text: '',
      kind: trade.kind,
      parser_version: PARSER_VERSION,
      price: trade.price,
      rationale: '',
      raw_action: trade.action,
      segment_end_index: trade.segment_index,
      segment_index: trade.segment_index,
      segment_start_index: trade.segment_index,
      session_date: sessionDate,
      session_kind: kind,
      side: trade.side,
      stop_price: trade.stop_price,
      target_price_high: null,
      target_price_low: null,
      ticker: trade.ticker,
      ticker_from: trade.ticker_from,
      transcript_id: null,
      verb: trade.verb,
      video_id: (video && video.video_id) || '',
    };
  });
}

/** The shared table's action vocabulary. The source's own verb stays on the action row. */
function sharedAction(trade) {
  if (trade.action === 'open' && trade.side === 'short') return 'short';
  if (trade.action === 'open') return 'buy';
  if (trade.action === 'trim') return 'trim';
  if (trade.action === 'exit' || trade.action === 'stop_out') return 'sell';
  return trade.action || '';
}

/** Rows the ticker table can hold. A statement with no ticker is not one. */
function signalRows(trades) {
  return trades.filter((trade) => trade.ticker);
}

module.exports = {
  PARSER_VERSION,
  signalRows,
  tradesFromSegments,
};
