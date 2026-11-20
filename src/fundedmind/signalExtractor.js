'use strict';

const { collapseRollingCues } = require('../transcript/transcriptNormalize');
const { hostFromTitle, sessionKind, FUNDEDMIND_KINDS, dateFromTitle } = require('./contentFilter');
const { dominantInstrument, readTrades } = require('./tradeRead');
const { readRecapJudgments, weekWindowFromRecapDate } = require('./recapRead');

// fundedmind-10: week_recap eligible + retrospective recap judgments (not live opens).
const PARSER_VERSION = 'fundedmind-10';

const KIND_DEFAULT_TICKER = {
  [FUNDEDMIND_KINDS.GOLD]: 'XAUUSD',
};

// Measured on Veselovský SK desks: index/Nasdaq is the unnamed default product.
function hostDefaultTicker(title) {
  const host = hostFromTitle(title || '');
  if (/Veselovsk/i.test(host)) return 'NAS100';
  return '';
}

function biasFromSide(side, action) {
  if (side === 'long') return 'bullish';
  if (side === 'short') return 'bearish';
  if (action === 'exit' || action === 'stop_out' || action === 'hold') return 'neutral';
  return 'neutral';
}

function confidenceFor(trade) {
  if (!trade.ticker) return { label: 'low', score: 0.25 };
  if (trade.kind === 'plan') return { label: 'low', score: 0.35 };
  if (trade.price != null || trade.stop_price != null) return { label: 'medium', score: 0.55 };
  return { label: 'medium', score: 0.45 };
}

function baseMeta(meta, title) {
  return {
    host: hostFromTitle(title),
    kind: sessionKind(title),
    sessionDate: dateFromTitle(title, { uploadDate: meta.upload_date || meta.uploadDate || '' }),
    videoId: meta.video_id || '',
    transcriptId: meta.transcript_id == null ? null : meta.transcript_id,
  };
}

function extractRecapSignals(rawSegments, meta = {}) {
  const segments = collapseRollingCues(rawSegments || []);
  const title = meta.title || '';
  const { host, kind, sessionDate, videoId, transcriptId } = baseMeta(meta, title);
  const week = weekWindowFromRecapDate(sessionDate);
  const judgments = readRecapJudgments(segments);
  const signals = [];

  for (const j of judgments) {
    // no_trade without ticker still records the week-level claim.
    if (!j.ticker && j.verdict !== 'no_trade' && j.verdict !== 'light') continue;
    const conf = j.verdict === 'confirm' || j.verdict === 'held'
      ? { label: 'medium', score: 0.5 }
      : { label: 'low', score: 0.35 };
    signals.push({
      video_id: videoId,
      transcript_id: transcriptId,
      segment_start_index: j.segment_index || 0,
      segment_end_index: j.segment_index || 0,
      event_time_sec: j.start_sec,
      ticker: j.ticker || 'MARKET',
      action: j.action || 'hold',
      bias: biasFromSide(j.side, j.action),
      claim_kind: 'retrospective',
      confidence_label: conf.label,
      confidence_score: conf.score,
      entry_price: null,
      target_price_low: null,
      target_price_high: null,
      stop_price: null,
      horizon_text: week.start && week.end ? `week:${week.start}-${week.end}` : 'week',
      rationale: [
        host ? `host=${host}` : '',
        kind ? `kind=${kind}` : '',
        j.side ? `side=${j.side}` : '',
        j.verdict ? `recap_verdict=${j.verdict}` : '',
        week.start ? `week_start=${week.start}` : '',
        week.end ? `week_end=${week.end}` : '',
      ].filter(Boolean).join('; '),
      evidence_text: j.evidence_text,
      parser_version: PARSER_VERSION,
    });
  }
  return signals;
}

function extractLiveSignals(rawSegments, meta = {}) {
  const segments = collapseRollingCues(rawSegments || []);
  const title = meta.title || '';
  const { host, kind, videoId, transcriptId } = baseMeta(meta, title);
  const defaultTicker = KIND_DEFAULT_TICKER[kind] || hostDefaultTicker(title) || '';
  const dominantTicker = defaultTicker ? '' : dominantInstrument(segments);
  const trades = readTrades(segments, { defaultTicker, dominantTicker });

  const indexByText = new Map();
  segments.forEach((seg, idx) => {
    const key = String(seg.text || '').trim();
    if (key && !indexByText.has(key)) indexByText.set(key, idx);
  });

  const signals = [];
  for (const trade of trades) {
    if (!trade.ticker) continue;

    const conf = confidenceFor(trade);
    const segIndex = indexByText.has(trade.evidence_text)
      ? indexByText.get(trade.evidence_text)
      : 0;
    const startSec = Number(trade.start_sec);
    signals.push({
      video_id: videoId,
      transcript_id: transcriptId,
      segment_start_index: segIndex,
      segment_end_index: segIndex,
      event_time_sec: Number.isFinite(startSec) ? startSec : null,
      ticker: trade.ticker,
      action: trade.action,
      bias: biasFromSide(trade.side, trade.action),
      claim_kind: trade.kind === 'plan' ? 'plan' : 'forward',
      confidence_label: conf.label,
      confidence_score: conf.score,
      entry_price: trade.action === 'open' ? trade.price : null,
      target_price_low: trade.action === 'target' ? trade.price : null,
      target_price_high: null,
      stop_price: trade.stop_price,
      horizon_text: '',
      rationale: [
        host ? `host=${host}` : '',
        kind ? `kind=${kind}` : '',
        trade.side ? `side=${trade.side}` : '',
        trade.verb ? `verb=${trade.verb}` : '',
        trade.ticker_from ? `ticker_from=${trade.ticker_from}` : '',
      ].filter(Boolean).join('; '),
      evidence_text: trade.evidence_text,
      parser_version: PARSER_VERSION,
    });
  }
  return signals;
}

function extractSignals(rawSegments, meta = {}) {
  const title = meta.title || '';
  const kind = sessionKind(title);
  if (kind === FUNDEDMIND_KINDS.WEEK_RECAP) {
    return extractRecapSignals(rawSegments, meta);
  }
  return extractLiveSignals(rawSegments, meta);
}

module.exports = {
  PARSER_VERSION,
  extractSignals,
  extractLiveSignals,
  extractRecapSignals,
};
