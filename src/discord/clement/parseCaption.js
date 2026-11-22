'use strict';

/**
 * Parse a Clement Discord caption into a post + idea rows.
 *
 * RULES
 *
 * 1. Dates come from a leading "DD Mon YYYY:" header when present; otherwise
 *    from the message posted_at (UTC calendar date is fine for v1; callers can
 *    refine to America/New_York later).
 * 2. `$TICKER` is always an idea. Bare capitals need the lexicon (arbiter, not
 *    allow-list for $ cashtags — a $ name is kept even if the snapshot is old).
 * 3. Numbered sections like "1) $TEM - ..." set role/theme from nearby words.
 * 4. Empty captions with images are chart_note posts with zero ideas.
 * 5. Link-only captions are other, zero ideas.
 */

const { findTickers, JARGON, loadLexicon } = require('../symbols');
const { loadMarketTickers } = require('../../normalize/marketTickers');
const { PARSER_VERSION, SOURCE_NAME } = require('./sources');

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** `10 June 2025:` or `**09 Jan 2026: Title**` */
const HEADER_RE = /^\s*(?:\*\*)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*:\s*(.*?)(?:\*\*)?\s*$/m;

const SECTION_RE = /(?:^|\n)\s*(?:\*\*)?(?:\(?\d+\)?[.)]|\d+\))\s*(?:\*\*)?\s*([^\n]+)/g;

const THEME_LINE_RE = /(?:^|\n)\s*(?:\*\*)?(\d+)\)\s*(?:\*\*)?\s*([^\n$*]+?)(?:\s*\$|\s*$)/;

const CRYPTO_MAP = {
  BTCUSD: 'BTC',
  ETHUSD: 'ETH',
  BTC: 'BTC',
  ETH: 'ETH',
};

const EXTRA_STOP = new Set([
  ...JARGON,
  'VCP', 'VCPS',
]);

let marketCache = null;

function marketSet() {
  if (marketCache) return marketCache;
  try {
    marketCache = loadMarketTickers();
  } catch {
    marketCache = new Set();
  }
  return marketCache;
}

/**
 * @param {string} mon
 * @returns {number|null}
 */
function monthNum(mon) {
  return MONTHS[String(mon || '').toLowerCase()] || null;
}

/**
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @returns {string}
 */
function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * @param {string} postedAt
 * @returns {string} YYYY-MM-DD
 */
function dateFromPostedAt(postedAt) {
  const s = String(postedAt || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Strip light markdown for body storage.
 * @param {string} text
 */
function stripMarkdownLight(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`+/g, '')
    .trim();
}

/**
 * Normalize a raw ticker token.
 * @param {string} raw
 */
function normalizeTicker(raw) {
  let t = String(raw || '').toUpperCase().replace(/^\$/, '');
  if (CRYPTO_MAP[t]) t = CRYPTO_MAP[t];
  return t;
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.posted_at]
 * @param {number} [options.image_count]
 * @param {string} [options.primary_attachment_id]
 * @param {string} [options.discord_message_id]
 * @param {number} [options.message_id]
 * @param {Set<string>} [options.known]
 * @returns {{post: object, ideas: object[]}}
 */
function parseCaption(text, options = {}) {
  const content = String(text || '');
  const postedAt = options.posted_at || '';
  const imageCount = Number(options.image_count) || 0;
  const known = options.known || loadLexicon();
  const market = marketSet();

  let asOfDate = '';
  let asOfSource = '';
  let title = '';
  let body = content;

  const headerMatch = content.match(HEADER_RE);
  if (headerMatch) {
    const day = Number(headerMatch[1]);
    const mon = monthNum(headerMatch[2]);
    const year = Number(headerMatch[3]);
    if (mon && day >= 1 && day <= 31 && year >= 2000) {
      asOfDate = ymd(year, mon, day);
      asOfSource = 'caption_header';
      title = stripMarkdownLight(headerMatch[4] || '');
      // body is full content still (header is part of the post)
      body = content;
    }
  }
  if (!asOfDate) {
    asOfDate = dateFromPostedAt(postedAt);
    asOfSource = asOfDate ? 'posted_at' : '';
  }

  const stripped = content.trim();
  let postKind = 'other';
  const hasCashtag = /\$[A-Za-z]{1,5}\b/.test(content);
  const hasNumberedIdea = /(?:^|\n)\s*(?:\*\*)?\d+\)\s*(?:\*\*)?\s*\$/.test(content)
    || /(?:^|\n)\s*(?:\*\*)?\d+\)\s*(?:\*\*)?.{0,40}\$/.test(content);
  if (!stripped && imageCount > 0) {
    postKind = 'chart_note';
  } else if (!stripped) {
    postKind = 'other';
  } else if (/^https?:\/\/\S+$/i.test(stripped)) {
    postKind = 'other';
  } else if (headerMatch && asOfSource === 'caption_header' && (hasNumberedIdea || (hasCashtag && stripped.length >= 600))) {
    // Dated multi-ticker writeup (e.g. "21 Aug 2025: Define The Leaders")
    postKind = 'idea_writeup';
  } else if (headerMatch && asOfSource === 'caption_header') {
    postKind = 'daily_plan';
  } else if (stripped.length >= 400 || hasCashtag || /\(\d+\)/.test(content)) {
    postKind = 'idea_writeup';
  } else if (imageCount > 0) {
    postKind = 'chart_note';
  } else {
    postKind = 'other';
  }

  // Theme sections: "3) AI Healthcare $TEM $HNGE"
  /** @type {Map<string, {theme: string, role: string, note: string}>} */
  const contextByTicker = new Map();

  const sectionIter = content.matchAll(
    /(?:^|\n)\s*(?:\*\*)?(\d+)\)\s*(?:\*\*)?\s*([^\n]+)/g,
  );
  for (const m of sectionIter) {
    const line = m[2] || '';
    const themeMatch = line.match(/^([^$:]+?)(?:\s*[-–—:]|\s+\$)/);
    let theme = '';
    if (themeMatch) {
      theme = stripMarkdownLight(themeMatch[1]).replace(/\s+/g, ' ').trim();
      // drop leading ticker-only themes
      if (/^[A-Z]{1,5}$/.test(theme)) theme = '';
    }
    let role = 'watch';
    const low = line.toLowerCase();
    if (/\bshort\b/.test(low)) role = 'short_idea';
    else if (/\blong\b/.test(low) || /\bbuy\b/.test(low)) role = 'long_idea';
    else if (/\bfocus\b/.test(low) || /\bwatching\b/.test(low) || /\bwatch\b/.test(low)) role = 'focus';

    const cashtags = [...line.matchAll(/\$([A-Za-z]{1,5})\b/g)].map((x) => normalizeTicker(x[1]));
    const note = stripMarkdownLight(line).slice(0, 400);
    for (const t of cashtags) {
      if (!t) continue;
      contextByTicker.set(t, {
        theme: theme && !/^[\$A-Z0-9\s]{0,6}$/.test(theme) ? theme : (contextByTicker.get(t)?.theme || ''),
        role,
        note,
      });
    }
    // "Looking at BTCUSD" without $
    const bare = findTickers(line, { known, slot: false });
    for (const hit of bare) {
      const t = normalizeTicker(hit.ticker);
      if (!t || EXTRA_STOP.has(t)) continue;
      if (!hit.dollar && !known.has(t) && !market.has(t) && !CRYPTO_MAP[t] && !CRYPTO_MAP[hit.ticker]) {
        // bare unknown — skip unless crypto-ish
        if (!/USD$/.test(hit.ticker)) continue;
      }
      if (!contextByTicker.has(t)) {
        contextByTicker.set(t, { theme, role, note });
      }
    }
  }

  // Global ticker harvest
  const found = findTickers(content, { known });
  /** @type {Map<string, object>} */
  const ideasByTicker = new Map();

  function addIdea(ticker, partial) {
    const t = normalizeTicker(ticker);
    if (!t || t.length < 1 || t.length > 5) return;
    if (EXTRA_STOP.has(t) && !partial.force) return;
    // Drop pure jargon again
    if (JARGON.has(t) && !partial.dollar && !['BTC', 'ETH'].includes(t)) return;

    const prev = ideasByTicker.get(t);
    const ctx = contextByTicker.get(t) || {};
    const role = partial.role || ctx.role || 'mention';
    const theme = partial.theme || ctx.theme || '';
    const note = partial.note || ctx.note || '';
    const confidence = partial.confidence
      || (partial.dollar || ctx.note ? 'high' : 'medium');
    const next = {
      ticker: t,
      role,
      theme,
      note: note.slice(0, 500),
      confidence,
      source: 'caption',
    };
    if (!prev) {
      ideasByTicker.set(t, next);
      return;
    }
    // Prefer richer role/note
    const rank = { short_idea: 4, long_idea: 4, focus: 3, watch: 2, theme_member: 2, mention: 1 };
    if ((rank[role] || 0) >= (rank[prev.role] || 0)) {
      ideasByTicker.set(t, {
        ...prev,
        ...next,
        note: next.note || prev.note,
        theme: next.theme || prev.theme,
        confidence: next.confidence === 'high' || prev.confidence === 'high' ? 'high' : next.confidence,
      });
    }
  }

  for (const hit of found) {
    const t = normalizeTicker(hit.ticker);
    if (!t) continue;
    if (!hit.dollar) {
      // bare token: lexicon or market arbiter
      if (!known.has(t) && !market.has(t) && !['BTC', 'ETH'].includes(t)) continue;
      if (EXTRA_STOP.has(t)) continue;
    }
    // dollar cashtag always kept
    addIdea(t, {
      dollar: hit.dollar,
      confidence: hit.dollar ? 'high' : 'medium',
      role: contextByTicker.get(t)?.role || (hit.dollar ? 'mention' : 'mention'),
      note: contextByTicker.get(t)?.note || '',
      theme: contextByTicker.get(t)?.theme || '',
      force: hit.dollar,
    });
  }

  // Theme list members: "$TEM $HNGE $MEDP" after a theme name → theme_member
  for (const [t, ctx] of contextByTicker) {
    if (!ideasByTicker.has(t)) {
      addIdea(t, {
        role: ctx.role === 'watch' && ctx.theme ? 'theme_member' : ctx.role,
        theme: ctx.theme,
        note: ctx.note,
        confidence: 'high',
        dollar: true,
        force: true,
      });
    } else if (ctx.theme) {
      const cur = ideasByTicker.get(t);
      if (cur.role === 'mention' || cur.role === 'watch') {
        cur.role = cashtagThemeRole(ctx);
        cur.theme = ctx.theme;
        if (ctx.note) cur.note = ctx.note;
      }
    }
  }

  function cashtagThemeRole(ctx) {
    if (ctx.role === 'short_idea' || ctx.role === 'long_idea' || ctx.role === 'focus') return ctx.role;
    return ctx.theme ? 'theme_member' : ctx.role || 'watch';
  }

  // Index ETFs as mentions are fine when cashtagged; bare SPY in jargon-heavy text already filtered.

  const ideas = [...ideasByTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));

  // If idea_writeup produced nothing but has cashtags we failed — still ok.

  const post = {
    parser_version: PARSER_VERSION,
    source_name: SOURCE_NAME,
    message_id: options.message_id || 0,
    discord_message_id: options.discord_message_id || '',
    posted_at: postedAt,
    as_of_date: asOfDate,
    as_of_source: asOfSource,
    post_kind: postKind,
    title,
    body: stripMarkdownLight(body).slice(0, 8000),
    image_count: imageCount,
    primary_attachment_id: options.primary_attachment_id || '',
    idea_count: ideas.length,
  };

  const ideaRows = ideas.map((idea) => ({
    parser_version: PARSER_VERSION,
    source_name: SOURCE_NAME,
    message_id: post.message_id,
    discord_message_id: post.discord_message_id,
    as_of_date: post.as_of_date,
    ticker: idea.ticker,
    role: idea.role,
    theme: idea.theme || '',
    note: idea.note || '',
    confidence: idea.confidence || 'medium',
    source: 'caption',
  }));

  return { post, ideas: ideaRows };
}

module.exports = {
  HEADER_RE,
  dateFromPostedAt,
  normalizeTicker,
  parseCaption,
  stripMarkdownLight,
  PARSER_VERSION,
  SOURCE_NAME,
};
