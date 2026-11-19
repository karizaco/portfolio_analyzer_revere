'use strict';

// Week Recap speech -> confirm / deny / no_trade judgments for that week's desks.
// Not live open mining: past-tense and outcome language only.

const { collapseRollingCues } = require('../transcript/transcriptNormalize');
const { instrumentsIn } = require('./tradeRead');

const L = 'A-Za-zÁáÄäČčĎďÉéĚěÍíĹĺĽľŇňÓóÔôŔŕŘřŠšŤťÚúŮůÝýŽž';

function around(body) {
  return new RegExp('(?:^|[^' + L + '])(?:' + body + ')(?![' + L + '])', 'i');
}

const FIRST_PERSON = around(
  'já|ja|jsem|som|mám|mě|mne|nás|jsme|sme|bral(?:a)?|zobral(?:a)?|nabral(?:a)?|'
  + 'vzal(?:a)?|nevzal(?:a)?|nebral(?:a)?|držel(?:a)?|drzel(?:a)?|shortoval(?:a)?|'
  + 'longoval(?:a)?|i|i\'m|im|my'
);

const NO_TRADE = around(
  '(?:týden|tyden|tento\\s+týden|tenhl(?:ec|e)?ten\\s+týden|tenhlecten\\s+týden)\\s+'
  + '(?:jsem|som)\\s+(?:nevzal|nebral)(?:a)?\\s+(?:žádn(?:ej|ý)|ziadny|zadny)?\\s*(?:obchod|pozic)?|'
  + '(?:jsem|som)\\s+(?:nevzal|nebral)(?:a)?\\s+(?:žádn(?:ej|ý)|ziadny)?\\s*(?:obchod|pozic)|'
  + 'no\\s+trades?\\s+this\\s+week|didn\'t\\s+take\\s+any'
);

const HELD = around(
  'držel(?:a)?|drzel(?:a)?|held|keeping\\s+(?:the\\s+)?(?:short|long)'
);

const WORKED = around(
  'vyš(?:el|lo|la)|vyslo|fungoval(?:o|a)?|trefili|worked|paid'
);

const FAILED = around(
  'nevyš(?:el|lo|la)|nevyslo|nefungoval(?:o|a)?|failed|stopped\\s+out'
);

const PAST_SHORT = around(
  '(?:jsem|som)\\s+short|shortov\\w*\\s+pozic|bral(?:a)?\\s+(?:jsem\\s+)?short|'
  + 'short\\s+na|was\\s+short|i\\s+shorted'
);

const PAST_LONG = around(
  '(?:jsem|som)\\s+long|longov\\w*|bral(?:a)?\\s+(?:jsem\\s+)?long|'
  + 'long\\s+na|hral(?:a)?\\s+(?:právě\\s+)?longov\\w*|was\\s+long|i\\s+longed'
);

const LIGHT_TAKEN = around(
  '(?:týden|tyden)\\s+(?:jsem|som)\\s+nebral(?:a)?\\s+za\\s+tolik|'
  + 'obchodů\\s+nebylo\\s+zas\\s+tolik|not\\s+many\\s+trades'
);

function shiftYmd(ymd, deltaDays) {
  const s = String(ymd || '');
  if (!/^\d{8}$/.test(s)) return '';
  const dt = new Date(Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
  ));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function weekWindowFromRecapDate(sessionDateYmd) {
  const end = String(sessionDateYmd || '');
  if (!/^\d{8}$/.test(end)) return { start: '', end: '' };
  return { start: shiftYmd(end, -6), end };
}

function sideFromText(raw) {
  if (PAST_SHORT.test(raw)) return 'short';
  if (PAST_LONG.test(raw)) return 'long';
  if (/\bshort\b/i.test(raw)) return 'short';
  if (/\blong\b/i.test(raw)) return 'long';
  return '';
}

function verdictFromText(raw) {
  if (NO_TRADE.test(raw)) return 'no_trade';
  if (FAILED.test(raw)) return 'deny';
  if (WORKED.test(raw)) return 'confirm';
  if (HELD.test(raw) && (PAST_SHORT.test(raw) || PAST_LONG.test(raw) || /\b(?:short|long)\b/i.test(raw))) {
    return 'held';
  }
  if (PAST_SHORT.test(raw) || PAST_LONG.test(raw)) return 'confirm';
  if (LIGHT_TAKEN.test(raw)) return 'light';
  return '';
}

function readRecapJudgments(rawSegments) {
  const segments = collapseRollingCues(rawSegments || []);
  const out = [];
  const seen = new Set();

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const raw = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    if (!FIRST_PERSON.test(raw) && !NO_TRADE.test(raw) && !LIGHT_TAKEN.test(raw)) continue;

    const verdict = verdictFromText(raw);
    if (!verdict) continue;

    let tickers = instrumentsIn(raw);
    if (!tickers.length) {
      for (const j of [i - 1, i + 1, i - 2, i + 2]) {
        if (j < 0 || j >= segments.length) continue;
        tickers = instrumentsIn(segments[j].text || '');
        if (tickers.length) break;
      }
    }

    const side = sideFromText(raw);
    const startSec = Number(seg.start_sec != null ? seg.start_sec : seg.start);
    const list = tickers.length ? tickers : ((verdict === 'no_trade' || verdict === 'light') ? [''] : []);

    for (const ticker of list) {
      const key = `${verdict}|${ticker}|${side}|${raw.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ticker: ticker || '',
        side,
        verdict,
        action: verdict === 'no_trade' ? 'hold' : (verdict === 'deny' ? 'exit' : 'open'),
        evidence_text: raw,
        start_sec: Number.isFinite(startSec) ? startSec : null,
        segment_index: i,
      });
    }
  }
  return out;
}

function applyRecapJudgments(setups, judgments, week) {
  const start = week && week.start ? week.start : '';
  const end = week && week.end ? week.end : '';
  let applied = 0;
  if (!start || !end) return { applied: 0 };

  const inWeek = setups.filter((s) => {
    const d = s.session_date || '';
    return d >= start && d <= end && s.kind !== 'week_recap';
  });

  for (const j of judgments || []) {
    const verdict = j.verdict || fieldVerdict(j);
    if (!verdict) continue;
    const ticker = String(j.ticker || '').trim();
    const side = String(j.side || fieldSide(j) || '').trim();
    const evidence = j.evidence_text || j.evidence || '';

    if (verdict === 'no_trade' || verdict === 'light') {
      // Without a ticker, a light/no_trade note is week-level commentary —
      // do not stamp every live setup in the window.
      if (!ticker) continue;
      const targets = inWeek.filter((s) => s.ticker === ticker);
      for (const s of targets) {
        if (s.recap_verdict) continue;
        if (side && s.side && s.side !== side) continue;
        s.recap_verdict = verdict;
        s.recap_evidence = evidence;
        s.recap_video_id = j.video_id || s.recap_video_id || '';
        applied += 1;
      }
      continue;
    }

    if (!ticker) continue;
    const candidates = inWeek
      .filter((s) => s.ticker === ticker)
      .filter((s) => !side || !s.side || s.side === side)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    const target = candidates[0];
    if (!target) continue;
    const rank = { confirm: 3, held: 2, deny: 3, light: 1, no_trade: 2 };
    const prev = rank[target.recap_verdict] || 0;
    if ((rank[verdict] || 0) < prev) continue;
    target.recap_verdict = verdict;
    target.recap_evidence = evidence;
    target.recap_video_id = j.video_id || '';
    applied += 1;
  }
  return { applied };
}

function fieldVerdict(row) {
  const r = String(row.rationale || '');
  const m = r.match(/recap_verdict=([a-z_]+)/i);
  return m ? m[1] : '';
}

function fieldSide(row) {
  const r = String(row.rationale || '');
  const m = r.match(/side=([a-z]+)/i);
  return m ? m[1] : '';
}

module.exports = {
  applyRecapJudgments,
  readRecapJudgments,
  shiftYmd,
  weekWindowFromRecapDate,
};
