'use strict';

// First-person trade / plan statements in FundedMind CZ/SK captions.
//
// JS \b is ASCII-only, so Czech/Slovak diacritics break word boundaries.
// Boundaries here use a Latin + CZ/SK letter class instead.

const L = 'A-Za-zÁáÄäČčĎďÉéĚěÍíĹĺĽľŇňÓóÔôŔŕŘřŠšŤťÚúŮůÝýŽž';

function around(body) {
  return new RegExp(`(?:^|[^${L}])(?:${body})(?![${L}])`, 'i');
}

const INTENT_BEFORE = around(
  'kdyby(?:ch(?:om)?|s(?:te)?)?|a?bych(?:om)?|abysme|by\s+som|přemýšlím|uvažuj[ui]|chci|chtěl(?:a)?\\s+bych|chtěla\\s+bych|'
  + 'chcel(?:a)?|mohl(?:a)?\\s+by(?:ch)?|looking\\s+to|might|would\\s+like|if\\s+i',
);
const COACHING_YOU = around(
  'můžete|můžeš|chcete|chceš|vstupujte|longujte|shortujte|zkuste|doporučuju\\s+vám|'
  + 'bra[tť]\\s+long|bra[tť]\\s+short|očakávate|you\\s+(?:can|should|could)',
);
const FIRST_PERSON = around(
  'já|ja|jsem|som|mám|můj|moja|moje|moji|mého|mě|nás|náš|jsme|sme|budu|pôjdem|'
  + 'longuju|longujem|shortuju|shortujem|vstupuj[ui]|vstupoval(?:a)?|beru|beriem|'
  + 'bral(?:a)?\s+som|som\s+bral(?:a)?|zobral(?:a)?\s+som|som\s+zobral(?:a)?|'
  + 'nabral(?:a)?\s+som|som\s+nabral(?:a)?|jsem\s+nabral(?:a)?|brali\s+sme|zobra[tť]|naberu|shortovej|longovej|'
  + 'koupil(?:a)?|kúpil(?:a)?|kupoval(?:a)?|přikoupil(?:a)?|predal(?:a)?|prodal(?:a)?|'
  + 'nakupuju|nakupuji|držím|zavíral(?:a)?|vezmu|naprůměr(?:oval(?:a)?|uju)|targetoval(?:a)?|i|i\'m|im|i’ve|i\'ve|my',
);
const STRONG_HOST_VERB = around(
  'longuju|longujem|shortuju|shortujem|vstupuj[ui]|vstupoval(?:a)?|otevřel(?:a)?|otvoril(?:a)?|'
  + 'zavřel(?:a)?|zatvoril(?:a)?|zatváral(?:a)?|zavíral(?:a)?|koupil(?:a)?|kúpil(?:a)?|kupoval(?:a)?|přikoupil(?:a)?|'
  + 'prodal(?:a)?|predal(?:a)?|targetoval(?:a)?|zlongovat|'
  + 'bral(?:a)?|zobral(?:a)?|nabral(?:a)?|'
  + 'beru\\s+(?:long|short|to|obchod|trade|setup)|'
  + 'beriem\\s+(?:long|short|to|obchod|trade|setup)|'
  + 'som\\s+bral|bral(?:a)?\\s+som|som\\s+zobral|zobral(?:a)?\\s+som|'
  + 'som\\s+nabral|nabral(?:a)?\\s+som|'
  + 'držím\\s+(?:long|short)|jsem(?:\\s+\\S+){0,2}\\s+v\\s+(?:longu|shortu)|som(?:\\s+\\S+){0,2}\\s+v\\s+(?:longu|shortu)|'
  + 'vezmu\\s+(?:ještě\\s+)?(?:jeden\\s+)?(?:long|short)|nakupuju|nakupuji',
);

// Chart gap opens are not host entries: "pak otevřel třeba gap 50 dolarů".
const CHART_GAP_OPEN = around('otevřel(?:a)?|otvoril(?:a)?') ;

const VERBS = [
  // Negatives first so "nebral" is not treated as an open.
  { action: 'skip', side: '', pattern: around('nebral(?:a)?|nezobral(?:a)?|neberiem|neberu|nebral(?:i)?') },
  { action: 'stop_out', side: '', pattern: around('stop(?:\\s*out|nul|nutý)|stopk[ayu]?|dostal(?:a)?(?:\\s+\\S+){0,4}\\s+stop|vyhodilo\\s+(?:ze\\s+)?stop|trailing\\s+stop|stop\\s*los(?:s|u)?|stop\\s*loss') },
  { action: 'skip', side: '', pattern: around('nezavřel(?:a)?|neuzavřel(?:a)?|nezatvoril(?:a)?') },
  { action: 'exit', side: '', pattern: around('zavřel(?:a)?|uzavřel(?:a)?|zatvoril(?:a)?|zatváral(?:a)?|zavíral(?:a)?|prodal(?:a)?|predal(?:a)?|take\\s*profit|takeprofit|\\btp\\b|closing|closed|covered') },
  { action: 'trim', side: '', pattern: around('přikoupil(?:a)?|přidal(?:a)?|naprůměroval(?:a)?|naprumeroval(?:a)?|naprůměruju|dokoupím|dokoupim|vypnu\\s+půlku|půlku\\s+pozic|trimmed|trimming') },
  // SK desk: "bral som short", "nabral som long", "som bral znova short"
  { action: 'open', side: 'short', pattern: around(
    'shortovat|shortuju|shortujem|shortuji|zshortovat|jsem\\s+short(?:ovej|ový)?|som\\s+short|mám\\s+short|jsem\\s+shortovej|'
    + 'jsem(?:\\s+\\S+){0,2}\\s+v\\s+shortu|som(?:\\s+\\S+){0,2}\\s+v\\s+shortu|držím\\s+short|'
    + 'beru\\s+short|beriem\\s+short|bral(?:a)?\\s+(?:som\\s+)?short|som\\s+bral(?:a)?\\s+short|'
    + 'bral(?:a)?(?:\\s+\\S+){0,4}\\s+short|'
    + 'zobral(?:a)?\\s+(?:som\\s+)?short|nabral(?:a)?\\s+(?:som\\s+)?short|jsem\\s+nabral(?:a)?\\s+short|'
    + 'naberu\\s+(?:ještě\\s+)?(?:jeden\\s+)?short|vezmu\\s+(?:ještě\\s+)?(?:jeden\\s+)?short|short(?:ed|ing)'
  ) },
  { action: 'open', side: 'long', pattern: around(
    'longovat|longuju|longujem|longuji|zlongovat|jsem\\s+long(?:ovej|ový)?|som\\s+long|mám\\s+long|jsem\\s+longovej|'
    + 'jsem(?:\\s+\\S+){0,2}\\s+v\\s+longu|som(?:\\s+\\S+){0,2}\\s+v\\s+longu|držím\\s+long|'
    + 'beru\\s+long|beriem\\s+long|bral(?:a)?\\s+(?:som\\s+)?long|som\\s+bral(?:a)?\\s+long|'
    + 'bral(?:a)?(?:\\s+\\S+){0,4}\\s+long|'
    + 'zobral(?:a)?\\s+(?:som\\s+)?long|nabral(?:a)?\\s+(?:som\\s+)?long|nabral(?:a)?\\s+som\\s+long|jsem\\s+nabral(?:a)?\\s+long|'
    + 'naberu\\s+(?:ještě\\s+)?(?:jeden\\s+)?long|vezmu\\s+(?:ještě\\s+)?(?:jeden\\s+)?long|'
    + 'long(?:ed)|koupil(?:a)?|kúpil(?:a)?|kupoval(?:a)?|nakupoval(?:a)?|nakupuju|nakupuji|přikoupil(?:a)?|bought|buying'
  ) },
  { action: 'open', side: '', pattern: around(
    'vstupuj[ui]|vstupoval(?:a)?|vstoupil(?:a)?|otevřel(?:a)?|otvoril(?:a)?|'
    + 'beru\\s+(?:to|obchod|trade|setup)|beriem\\s+(?:to|obchod|trade|setup)|'
    + 'bral(?:a)?\\s+som|som\\s+bral(?:a)?|zobral(?:a)?\\s+som|som\\s+zobral(?:a)?|'
    + 'nabral(?:a)?\\s+som|som\\s+nabral(?:a)?|bral(?:a)?\\s+(?:tento|ten|to|setup|obchod)|'
    + 'opened'
  ) },
  { action: 'target', side: '', pattern: around('target(?:ovat|ovala|oval|y)?|cíl(?:ov(?:at|ala|al))?|cie[lľ](?:ov(?:ať|ala|al))?') },
];

const INSTRUMENT_PATTERNS = [
  { ticker: 'BTC', pattern: around('bitcoin(?:u|e|em)?|btc') },
  { ticker: 'ETH', pattern: around('ethereum(?:u|e)?|ether|eth') },
  { ticker: 'XAUUSD', pattern: around('zlato|zlat(?:a|e|ě|em|u)|gold|xau(?:usd)?') },
  { ticker: 'NAS100', pattern: around('nasdaq\\w*|nas\\s*100|us\\s*100|nq|nasd[aá]\\w*|nazak\\w*') },
  { ticker: 'US30', pattern: around('us\\s*30|dow\\s*jones|dowjones|\\bdji\\b') },
  { ticker: 'ES', pattern: around('s\\s*&\\s*p|spx|sp\\s*500|sp500|(?<![a-z])es(?![a-z])|e-mini') },
  { ticker: 'USDJPY', pattern: around('usd\\s*jpy|dolar\\s*(?:yen|jpy)|jpy|yen(?:u|em)?|japon(?:ec|ský|skeho)?|\\bjp\\b') },
  { ticker: 'EURUSD', pattern: around('eurusd|\\beuro\\b|euro\\s*(?:vůči\\s+|voci\\s+)?(?:dolaru|doláru|dolar|dollar|usd)|eur\\s*/\\s*usd') },
  { ticker: 'DXY', pattern: around('dxy|dolar(?:ový)?\\s+index|dollar\\s+index|index\\s+dolaru') },
  { ticker: 'USOIL', pattern: around('ropa|wti|brent|crude') },
];

const PRICE_NEAR_ROLE = new RegExp(
  `(?:^|[^${L}])(?:stop(?:\\s*loss)?|sl|target|tp|cíl|vstup|entry|na)(?![${L}])[^0-9]{0,24}(\\d{1,3}(?:[ \\u00a0]?\\d{3})*(?:[.,]\\d+)?|\\d+(?:[.,]\\d+)?)`,
  'i',
);
const BARE_PRICE = /\b(\d{1,3}(?:[ \u00a0]?\d{3})+|\d{2,5}(?:[.,]\d+)?)\b/g;

function parsePriceToken(raw) {
  const cleaned = String(raw || '').replace(/[ \u00a0]/g, '').replace(',', '.');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1) return null;
  return n;
}

function instrumentsIn(text) {
  const raw = String(text || '');
  const out = [];
  for (const item of INSTRUMENT_PATTERNS) {
    if (item.pattern.test(raw)) out.push(item.ticker);
  }
  return [...new Set(out)];
}

function matchIndex(re, raw) {
  const m = re.exec(raw);
  if (!m) return null;
  const full = m[0];
  const boundary = new RegExp(`[^${L}]`);
  const start = m.index + (boundary.test(full[0]) ? 1 : 0);
  return { index: start, word: full.slice(start - m.index).trim(), match: m };
}

function readSegment(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (COACHING_YOU.test(raw)) return null;
  // "O koľkej si bral short?" / "Brali ste dneska nejaký obchod?"
  const SECOND_PERSON_COACH = around('si\\s+bral|brali\\s+ste|ste\\s+bral|si\\s+vzal|ste\\s+zobral|si\\s+zobral|jsi\\s+vstupoval|jsi\\s+bral|ako\\s+obchoduješ|obchoduješ');
  if (SECOND_PERSON_COACH.test(raw)) return null;

  const hasPerson = FIRST_PERSON.test(raw);
  const hasStrong = STRONG_HOST_VERB.test(raw);
  if (!hasPerson && !hasStrong) return null;

  let best = null;
  for (const verb of VERBS) {
    const hit = matchIndex(verb.pattern, raw);
    if (!hit) continue;
    if (!best || hit.index < best.index) {
      best = { action: verb.action, side: verb.side, index: hit.index, word: hit.word };
    }
  }
  if (!best) return null;
  if (best.action === 'skip') return null;
  // take profit overrides a "bral" open on the same line
  if (best.action === 'open' && /take\s*profit|takeprofit|(?:^|[^A-Za-z])tp(?:[^A-Za-z]|$)/i.test(raw)) {
    best = { action: 'exit', side: best.side || '', index: best.index, word: 'take profit' };
  }
  if (best.action === 'open' && /stoplos|stop\s*loss|stopku|stopka/i.test(raw) && /zobral|bral/i.test(best.word || '')) {
    best = { action: 'stop_out', side: '', index: best.index, word: 'stop' };
  }

  // "otevřel gap" / "otvoril gap" is chart talk, not a host fill.
  if (best.action === 'open' && /\bgap\b/i.test(raw) && /otevřel|otvoril/i.test(raw)) {
    return null;
  }
  // Market open narration, not a position.
  if (best.action === 'open' && /otvor(?:í|i|il)|otevř/i.test(best.word || raw) && /\bmarket\b|trh\b/i.test(raw)) {
    return null;
  }
  // Account / chat / non-trade "opens" and "buys" (Veselovský desk measured).
  const NON_TRADE_OPEN = /whatsapp|telef[oó]n|email|e-?mail|discord|účet|ucet|flex\b|čaj|tea|káv[auy]|oběd|obed|snídan|100k\s+účet|for\s+traders/i;
  if (best.action === 'open' && NON_TRADE_OPEN.test(raw)) {
    return null;
  }
  // Conditional SK: "Zobral by som nejaký short" / "tak by som bral short".
  // Note: /som\s+bral/ also matches inside "by som bral", so test the by-som-VERB form first.
  if (best.action === 'open' && /\bby\s+som\s+(?:bral|zobral|nabral|vzal|vzal|otvor|otevř|kúpil|koupil)/i.test(raw)) {
    return null;
  }
  if (best.action === 'open' && /\bby\s+som\b|\bzoberieme\b|\bzobra[tť]\b/i.test(raw) && !/(?<!\bby\s)(?:bral(?:a)?\s+som|som\s+bral|zobral(?:a)?\s+som|som\s+zobral|nabral)/i.test(raw)) {
    return null;
  }
  // Hypothetical stop sizing: "Asi by som dal väčší stopku" is not a stop-out.
  if (best.action === 'stop_out' && /\bby\s+som\b/i.test(raw) && !/dostal(?:a)?\s+som|som\s+dostal|vyhodilo|stopnul/i.test(raw)) {
    return null;
  }
  // Chart subject opened (candle/RSI/he), not the host — unless first-person open.
  if (best.action === 'open' && /otvor|otevř/i.test(best.word || raw)) {
    // Require explicit first-person open ("jsem ... otevřela" / "otvoril som").
    // Bare "Nvidia otevřela" / "sviečka otvorila" must not attach. "mě" alone is not enough.
    const hostOpen = /(?:(?:jsem|som).{0,40}(?:otevřel|otvoril)|(?:otevřel|otvoril).{0,24}(?:jsem|som)|já\s+(?:to\s+)?(?:otevř|otvor)|ja\s+(?:to\s+)?(?:otevř|otvor))/i.test(raw);
    if (!hostOpen) return null;
  }

  if (!hasPerson && (best.action === 'target' || best.action === 'stop_out') && !hasStrong) {
    return null;
  }
  // stopk requires host anchor
  if (best.action === 'stop_out' && /stopk/i.test(best.word || raw)) {
    if (!around('som|jsem|já|ja|mám|dostal(?:a)?|stiahol|posun').test(raw)) return null;
  }
  // bare collective target planning
  if (best.action === 'target' && /by\\s+sme|bychom|mohli/i.test(raw) && !around('môj|moj|môj\\s+target|targetoval').test(raw)) {
    return null;
  }

  const before = raw.slice(0, best.index);
  if (INTENT_BEFORE.test(before)) return null;
  if (COACHING_YOU.test(before)) return null;
  // "som chcel brať short" — intent even when verb is later.
  if (around('chcel(?:a)?|chtěl(?:a)?').test(raw) && best.action === 'open') return null;

  // Infer long/short side when the verb matched without side ("som bral znova short").
  if (best.action === 'open' && !best.side) {
    if (around('short').test(raw)) best.side = 'short';
    else if (around('long').test(raw)) best.side = 'long';
  }

  const goingTo = around('budu|chystám|jdu|idem|going\\s+to|gonna|plan(?:ning)?\\s+to').test(before);

  let price = null;
  let stopPrice = null;
  const role = PRICE_NEAR_ROLE.exec(raw);
  if (role) {
    const value = parsePriceToken(role[1]);
    if (/stop|sl/i.test(role[0])) stopPrice = value;
    else price = value;
  }
  if (price == null && stopPrice == null) {
    const nums = [];
    let m;
    const re = new RegExp(BARE_PRICE.source, 'g');
    while ((m = re.exec(raw)) !== null) {
      const value = parsePriceToken(m[1]);
      if (value != null) nums.push({ value, index: m.index });
    }
    const stopAt = raw.search(/stop/i);
    if (stopAt !== -1) {
      const after = nums.find((n) => n.index > stopAt);
      if (after) stopPrice = after.value;
    }
    const beforeStop = nums.find((n) => stopAt === -1 || n.index < stopAt);
    if (beforeStop && price == null) price = beforeStop.value;
  }

  return {
    action: best.action,
    kind: goingTo || best.action === 'target' ? 'plan' : 'action',
    price,
    side: best.side,
    stop_price: stopPrice,
    verb: String(best.word || '').toLowerCase(),
  };
}

function instrumentsNear(rows, index, maxGapSec, opts = {}) {
  const center = Number(rows[index]?.start_sec);
  const found = [];
  const start = Math.max(0, index - 20);
  const end = opts.backwardOnly ? index : Math.min(rows.length - 1, index + 20);
  for (let j = start; j <= end; j += 1) {
    if (opts.backwardOnly && j > index) continue;
    const t = Number(rows[j].start_sec) || 0;
    const gap = Math.abs(t - (Number.isFinite(center) ? center : 0));
    if (Number.isFinite(center) && gap > maxGapSec) continue;
    // For backward-only, ignore future timestamps even if index order is messy.
    if (opts.backwardOnly && Number.isFinite(center) && t > center) continue;
    if (!Number.isFinite(center) && Math.abs(j - index) > 2) continue;
    found.push(...instrumentsIn(rows[j].text));
  }
  return [...new Set(found)];
}

function borrowTicker(rows, index, maxGapSec, preferIndexes) {
  for (const j of preferIndexes) {
    if (j < 0 || j >= rows.length) continue;
    const gap = Math.abs((Number(rows[j].start_sec) || 0) - (Number(rows[index].start_sec) || 0));
    const close = !Number.isFinite(gap) || gap <= maxGapSec;
    if (!close) continue;
    const tickers = instrumentsIn(rows[j].text);
    if (tickers.length) return { tickers, fromIndex: j };
  }
  return null;
}

function dominantInstrument(segments, { minCount = 8, minShare = 0.55 } = {}) {
  const rows = Array.isArray(segments) ? segments : [];
  const hist = Object.create(null);
  let total = 0;
  for (const row of rows) {
    for (const t of instrumentsIn(row.text)) {
      hist[t] = (hist[t] || 0) + 1;
      total += 1;
    }
  }
  if (total < minCount) return '';
  const ranked = Object.entries(hist).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return '';
  const [top, count] = ranked[0];
  if (count < minCount) return '';
  if (count / total < minShare) return '';
  if (ranked.length > 1 && ranked[1][1] >= count * 0.75) return '';
  return top;
}

function readTrades(segments, options = {}) {
  const rows = Array.isArray(segments) ? segments : [];
  const defaultTicker = options.defaultTicker || '';
  const dominantTicker = options.dominantTicker || '';
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const read = readSegment(rows[i].text);
    if (!read) continue;
    let tickers = instrumentsIn(rows[i].text);
    let tickerFrom = 'segment';

    const canNext = read.action === 'open' || read.action === 'target';
    const canPrev = read.action === 'open' || read.action === 'target'
      || read.action === 'stop_out' || read.action === 'exit' || read.action === 'trim';

    if (!tickers.length && canNext) {
      const hit = borrowTicker(rows, i, 25, [i + 1]);
      if (hit) { tickers = hit.tickers; tickerFrom = 'next_segment'; }
    }
    if (!tickers.length && canPrev) {
      const hit = borrowTicker(rows, i, 25, [i - 1]);
      if (hit) { tickers = hit.tickers; tickerFrom = 'prev_segment'; }
    }
    if (!tickers.length && canNext) {
      const hit = borrowTicker(rows, i, 45, [i + 2]);
      if (hit) { tickers = hit.tickers; tickerFrom = 'next2_segment'; }
    }
    if (!tickers.length && canPrev) {
      const hit = borrowTicker(rows, i, 45, [i - 2]);
      if (hit) { tickers = hit.tickers; tickerFrom = 'prev2_segment'; }
    }
    if (!tickers.length && (canNext || canPrev)) {
      // Opens/targets may look either side; stop/exit stay backward-only
      // (measured false attach: stop then unrelated "gold" chatter).
      const near = (read.action === 'stop_out' || read.action === 'exit')
        ? instrumentsNear(rows, i, 60, { backwardOnly: true })
        : instrumentsNear(rows, i, 60);
      if (near.length === 1) {
        tickers = near;
        tickerFrom = 'window_unique';
      }
    }

    const near60 = instrumentsNear(rows, i, 60);
    const nonTrade = /\bčaj(?:ek|ku|e)?\b|tea|káv[auy]|coffee|oběd|obed|snídan|affiliate|kód(?:em)?|100k\s+účet|for\s+traders/i.test(rows[i].text || '');
    const verbOk = /long|short|otevř|otvor|vstup|zlong|bral|zobral|nabral|beru\s+(?:long|short)|beriem\s+(?:long|short)|držím|vezmu|nakupuj|zavíral|stopk|target|naprůměr|půlku/i.test(
      String(read.verb || '') + ' ' + String(rows[i].text || ''),
    );

    if (!tickers.length && defaultTicker && verbOk && !nonTrade) {
      const competing = near60.filter((t) => t !== defaultTicker);
      if (competing.length === 0) {
        tickers = [defaultTicker];
        tickerFrom = 'session_default';
      }
    }

    if (!tickers.length && !defaultTicker && dominantTicker && verbOk && !nonTrade) {
      const strongFill = /long|short|bral|zobral|nabral|držím|vezmu|zavíral|naberu|jsem\\s+v\\s+|som\\s+v\\s+|nakupuj|stopk|take\\s*profit/i.test(
        String(read.verb || '') + ' ' + String(rows[i].text || ''),
      );
      if (strongFill && near60.length === 0) {
        tickers = [dominantTicker];
        tickerFrom = 'session_dominant';
      }
    }

    out.push({
      ...read,
      evidence_text: String(rows[i].text || '').trim(),
      start_sec: rows[i].start_sec,
      ticker: tickers[0] || '',
      ticker_from: tickers.length ? tickerFrom : '',
    });
  }
  return out;
}

module.exports = {
  dominantInstrument,
  instrumentsIn,
  parsePriceToken,
  readSegment,
  readTrades,
};
