'use strict';

// Turn a free AsymTrading post's HTML into structured, quotable data.
//
// WHY A PARSER AND NOT A REGEX SWEEP
//
// A "Market Pulse" post is not free-form prose. It is a FIXED REPORT, and
// the fixedness is what makes it machine-readable. The author reads his own
// breadth and momentum sheets and reports the readings, which is exactly
// the kind of signal the other channels produce in speech.
//
// WHAT THE REPORT CONTAINS
//
//   Market Metrics
//     <backdrop reading>                 the overall market assessment
//     Overall Trend: <state>            + Large / Mid / Small Cap
//     Overall NH/NL Breadth: <state>    + Large / Mid / Small Cap
//     Overall Up/Down Momentum: <state> + Large / Mid / Small Cap
//   Market Recap
//     <link> "Market Monitor (Click Here)"  -> the breadth spreadsheet
//     <link> "TC2000 Stock list: <url>"      -> the day's stock list
//   <div class="native-video-embed">          -> the embedded commentary
//   Tactical Plan of Action
//     1) Market Posture -- Cautiously Constructive
//     2) Leadership -- Follow Proven Strength
//     ...                                 (the plan, section by section)
//     Base Case: ...                       (the scenarios, in the newer posts)
//   Bottom Line
//
// THE FORMAT EVOLVED, AND THE PARSER FOLLOWS IT
//
// Measured over the 42 free posts, there are THREE formats:
//
//   2025-02 .. 2025-06   the backdrop is a HEADING ("Overall: Mixed") and
//                         the trend is called "Index Trends"; the plan
//                         sections are UNNUMBERED headings.
//   2025-09 .. 2025-12   the trend is called "Overall Trend"; the plan
//                         sections are numbered with a DOT ("1. Trend ...").
//   2026-03 .. today     the backdrop became a LABELLED PARAGRAPH
//                         ("Market Backdrop: Mixed") and the plan sections
//                         are numbered with a PARENTHESIS ("1) Market
//                         Posture -- Cautiously Constructive").
//
// So the parser does NOT switch on a date -- a date-based switch breaks the
// moment the author changes the layout again, and it has to be updated every
// time. It switches on the LABELS, which is what actually carries the
// meaning:
//
//   backdrop  <- "Market Backdrop" | "Overall"
//   trend     <- "Overall Trend"   | "Index Trends"
//   breadth   <- "Overall NH/NL Breadth" | "Overall Breadth"
//   momentum  <- "Overall Up/Down Momentum" | "Overall Momentum"
//
// and it accepts a plan section numbered with either a dot or a parenthesis,
// or not numbered at all.
//
// WHY THE PARSE KEEPS THE EVIDENCE
//
// Every extracted value keeps the sentence it came from. A breadth reading
// of "Positive" is a claim, and a claim you cannot point at is a claim you
// cannot check -- the same rule the transcript pipeline follows by keeping
// `evidence_text` on every signal row.
//
// WHAT THIS DOES NOT EXTRACT
//
// It does not extract individual STOCK tickers from the prose. The tickers
// that matter for this source are in the TC2000 stock list (a paywalled
// link) and in the embedded video, not in the article body -- the body's
// ticker mentions are the indices (SPY, QQQ, MDY, IWM). The index mentions
// are extracted separately and are labelled as such, because "SPY" in a
// market backdrop is context, not a call.

/**
 * The vocabulary the market-state readings come from.
 *
 * This is the set of states the author actually uses. It is a REPORT of what
 * was seen, not a guess at what he might say: an unseen state is still
 * reported (with `known: false`) rather than dropped, because a parser
 * that silently discards a reading is worse than one that admits it does
 * not recognise it.
 */
const MARKET_STATES = new Set([
  'mixed', 'positive', 'negative', 'neutral', 'constructive', 'defensive',
  'cautiously constructive', 'selectively constructive', 'cautious',
  'cautionary', 'bearish', 'bullish', 'improving', 'weakening', 'deteriorating',
  'strong', 'weak', 'stable', 'uncertain', 'elevated', 'compressed', 'up', 'down',
]);

/**
 * The cap-size buckets the author reports on.
 */
const CAP_SIZES = ['Large Cap', 'Mid Cap', 'Small Cap'];

/**
 * The metric readings, and the labels that introduce them.
 *
 * The FIRST label is the modern one and the second is the older spelling.
 * Both are listed because the author renamed these fields at least twice,
 * and a parser that only knows the current spelling silently loses a year
 * of readings.
 */
const METRIC_ALIASES = {
  backdrop: ['Market Backdrop', 'Overall'],
  trend: ['Overall Trend', 'Index Trends'],
  breadth: ['Overall NH/NL Breadth', 'Overall Breadth'],
  momentum: ['Overall Up/Down Momentum', 'Overall Momentum'],
};

/**
 * The sectors the author reports on.
 *
 * They are the eleven GICS sectors, under the names HE uses -- which are not
 * always the index names. "Defensives" is his name for the defensive
 * basket, "Consumer" for consumer discretionary, and "Financials" is
 * sometimes written "Financial Services". So each sector has a canonical
 * name and the aliases it appears under.
 *
 * Counting the words across the free corpus: technology 72, defensive 71,
 * consumer 52, energy 52, healthcare 49, financials 44, materials 36,
 * industrials 34, utilities 24 -- so these are the vocabulary, not a guess.
 */
const SECTORS = [
  { canonical: 'Technology', aliases: ['Technology', 'Tech'] },
  { canonical: 'Healthcare', aliases: ['Healthcare'] },
  { canonical: 'Financials', aliases: ['Financials', 'Financial Services'] },
  { canonical: 'Energy', aliases: ['Energy'] },
  { canonical: 'Materials', aliases: ['Materials'] },
  { canonical: 'Industrials', aliases: ['Industrials', 'Industrial'] },
  { canonical: 'Utilities', aliases: ['Utilities'] },
  { canonical: 'Real Estate', aliases: ['Real Estate', 'RealEstate'] },
  { canonical: 'Consumer Discretionary', aliases: ['Consumer Discretionary', 'Consumer Cyclical', 'Consumer Cyclicals', 'Consumer'] },
  { canonical: 'Consumer Staples', aliases: ['Consumer Staples', 'Staples'] },
  { canonical: 'Communication Services', aliases: ['Communication Services', 'Communications', 'Communication', 'Comms Svcs', 'Services'] },
  { canonical: 'Semiconductors', aliases: ['Semiconductors', 'Semis'] },
];

/**
 * The sectors a post puts in focus, and the ones it puts on the back
 * burner.
 *
 * The author names them in prose rather than in a table, so this is a
 * vocabulary scan over the sector section, not a field read. A sector is
 * reported only when it appears in the sector section of the report.
 */
const SECTOR_TIER_LABELS = [
  { tier: 'primary', pattern: /^(primary|main) (focus|interest|leaders)/i },
  { tier: 'secondary', pattern: /^secondary/i },
  { tier: 'turnaround', pattern: /^(monitor for )?turnaround/i },
  { tier: 'avoid', pattern: /^(avoid|lower priority|depriorit)/i },
];

/**
 * The index tickers the prose mentions.
 *
 * These are the ETFs the author measures the market with. They are context
 * in a breadth statement, not trade calls, so they are reported separately
 * from anything the pipeline treats as a signal.
 */
const INDEX_TICKERS = new Set(['SPY', 'QQQ', 'MDY', 'IWM', 'DIA', 'VTI']);

/**
 * The headings that open the plan and close the report.
 */
const PLAN_HEADINGS = /^(\d+)?[.)]?\s*(tactical )?plan of action$/i;
const BOTTOM_LINE_HEADING = /^bottom line$/i;

/**
 * Decode the HTML entities Substack's body uses.
 *
 * @param {string} html
 * @returns {string}
 */
function decodeEntities(html) {
  return String(html || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8217;/g, "'")
    .replace(/&#8212;/g, '--')
    .replace(/&#8211;/g, '-')
    .replace(/&hellip;/g, '...');
}

/**
 * Strip tags and collapse whitespace.
 *
 * @param {string} html
 * @returns {string}
 */
function textOf(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split the body into blocks, keeping the tag each block came from.
 *
 * The report is a sequence of headings, paragraphs and list items, and the
 * headings are what give the paragraphs their meaning. A flat list of text
 * nodes would lose that.
 *
 * @param {string} html
 * @returns {Array<{tag: string, text: string, html: string}>}
 */
function splitBlocks(html) {
  const source = String(html || '');
  const blocks = [];
  const re = /<(h1|h2|h3|h4|h5|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const text = textOf(match[2]);
    if (!text) continue;
    blocks.push({ tag: match[1].toLowerCase(), text, html: match[2] });
  }
  return blocks;
}

/**
 * Read a "Label: value" line.
 *
 * The value is normalised to lower case for comparison but the ORIGINAL text
 * is kept as the evidence, because the original is what a reader checks.
 *
 * @param {string} text
 * @returns {{label: string, value: string}|null}
 */
function splitLabelValue(text) {
  const match = /^([^:]{2,60}):\s*(.+)$/.exec(String(text || '').trim());
  if (!match) return null;
  return { label: match[1].trim(), value: match[2].trim() };
}

/**
 * Is this value one of the market states?
 *
 * The check is a MEMBERSHIP test against the vocabulary above. An
 * unrecognised value is still reported, with `known: false`, so the parser
 * degrades visibly rather than silently.
 *
 * @param {string} value
 * @returns {{known: boolean, normalized: string}}
 */
function classifyState(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[.]+$/, '');
  return { known: MARKET_STATES.has(normalized), normalized };
}

/**
 * The metric a label introduces, if any.
 *
 * @param {string} label
 * @returns {string|null} one of backdrop | trend | breadth | momentum
 */
function metricForLabel(label) {
  const wanted = String(label || '').trim().toLowerCase();
  for (const [metric, aliases] of Object.entries(METRIC_ALIASES)) {
    for (const alias of aliases) {
      if (wanted === alias.toLowerCase()) return metric;
    }
  }
  return null;
}

/**
 * The cap-size readings that belong to a metric.
 *
 * They are the list items that directly follow the metric's heading, and
 * they stop at the next heading.
 *
 * @param {Array<object>} blocks
 * @param {number} startIndex
 * @returns {Array<{cap: string, state: string, known: boolean, evidence: string}>}
 */
function readCapSizes(blocks, startIndex) {
  const readings = [];
  for (let i = startIndex + 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.tag.startsWith('h')) break;
    const parsed = splitLabelValue(block.text);
    if (!parsed) continue;
    const cap = CAP_SIZES.find((size) => parsed.label.toLowerCase() === size.toLowerCase());
    if (!cap) continue;
    const state = classifyState(parsed.value);
    readings.push({
      cap,
      state: state.normalized,
      known: state.known,
      evidence: block.text,
    });
  }
  return readings;
}

/**
 * The sectors named in a piece of text.
 *
 * @param {string} text
 * @returns {string[]} the canonical sector names, in the order they appear
 */
function matchSectors(text) {
  const source = String(text || '');
  // Every alias is matched, and then the MATCHES ARE RESOLVED AGAINST EACH
  // OTHER, longest first. Without that, "Consumer Staples" would match both
  // the "Consumer Staples" alias AND the "Consumer" alias, and the text
  // would report two sectors where the author named one.
  const hits = [];
  for (const sector of SECTORS) {
    for (const alias of sector.aliases) {
      const re = new RegExp('\\b' + alias.replace(/ /g, '\\s+') + '\\b', 'i');
      const at = re.exec(source);
      if (at) hits.push({ sector: sector.canonical, alias, at: at.index, length: alias.length });
    }
  }
  hits.sort((a, b) => b.length - a.length || a.at - b.at);

  const claimed = [];
  for (const hit of hits) {
    const overlaps = claimed.some((other) => {
      const end = other.at + other.length;
      return hit.at < end && other.at < hit.at + hit.length;
    });
    if (overlaps) continue;
    claimed.push(hit);
  }
  claimed.sort((a, b) => a.at - b.at);
  return claimed.map((hit) => hit.sector);
}

/**
 * Parse a free post's body.
 *
 * @param {object} post - a post object with `body_html`
 * @returns {object} the parsed report
 */
function parseAsymArticle(post) {
  const source = post || {};
  const html = typeof source.body_html === 'string' ? source.body_html : '';
  const blocks = splitBlocks(html);

  const result = {
    backdrop: null,
    trend: null,
    breadth: null,
    momentum: null,
    capSizes: { trend: [], breadth: [], momentum: [] },
    leadership: [],
    sectors: [],
    planSections: [],
    scenarios: [],
    bottomLine: '',
    spreadsheetUrl: '',
    tc2000Url: '',
    indexTickers: [],
    paragraphs: [],
    headings: [],
  };

  for (const block of blocks) {
    if (block.tag.startsWith('h')) result.headings.push(block.text);
  }

  // -- the attachments ----------------------------------------------------
  const sheetMatch = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(html);
  if (sheetMatch) {
    result.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${sheetMatch[1]}/edit?usp=sharing`;
  }
  const tcMatch = /tc2000\.com\/~([A-Za-z0-9]+)/.exec(html);
  if (tcMatch) result.tc2000Url = `https://www.tc2000.com/~${tcMatch[1]}`;

  // -- the metric readings ------------------------------------------------
  //
  // A metric reading is either a HEADING ("Overall Trend: Mixed") or a
  // LABELLED PARAGRAPH ("Market Backdrop: Mixed"), depending on the era.
  // Both are found by their label, and the cap sizes that follow a HEADING
  // belong to that heading's metric.
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const isHeading = block.tag.startsWith('h');
    const parsed = splitLabelValue(block.text);
    if (!parsed) continue;
    const metric = metricForLabel(parsed.label);
    if (!metric) continue;
    if (result[metric]) continue; // the first reading of a metric wins

    const state = classifyState(parsed.value);
    result[metric] = {
      state: state.normalized,
      known: state.known,
      evidence: block.text,
    };
    if (isHeading && metric !== 'backdrop') {
      result.capSizes[metric] = readCapSizes(blocks, i);
    }
  }

  // -- the leadership -----------------------------------------------------
  //
  // The leadership is a set of labelled lines ("Primary focus: Energy,
  // Defensives, ...") rather than a heading, so it is found by label.
  for (const block of blocks) {
    const parsed = splitLabelValue(block.text);
    if (!parsed) continue;
    const label = parsed.label.toLowerCase();
    if (!/^(primary focus|primary interest|secondary watch|secondary focus|lower priority|deprioritized)/.test(label)) {
      continue;
    }
    const tier = /primary/i.test(label) ? 'primary'
      : /secondary/i.test(label) ? 'secondary' : 'lower';
    const sectors = parsed.value
      .replace(/\s+until\s+.*$/i, '')
      .split(/,\s*/)
      .map((s) => s.trim().replace(/[.]+$/, ''))
      // "Energy, Defensives, Healthcare, Utilities, and Consumer Cyclicals"
      // lists five sectors, and the conjunction before the last one is
      // not part of the name.
      .map((s) => s.replace(/^and\s+/i, ''))
      .filter(Boolean);
    const existing = result.leadership.find((entry) => entry.tier === tier);
    if (existing) {
      existing.sectors.push(...sectors);
      existing.evidence = `${existing.evidence} | ${block.text}`;
    } else {
      result.leadership.push({ tier, label: parsed.label, sectors, evidence: block.text });
    }
  }

  // -- the plan and the scenarios ----------------------------------------
  //
  // The plan is everything between the plan heading and the Bottom Line.
  // The plan SECTIONS are the numbered ones ("1) Market Posture -- ...");
  // in the older posts they are unnumbered headings instead. The SCENARIOS
  // are the unnumbered headings that follow the numbered ones ("Base Case:
  // ...", "Bullish Expansion Scenario") -- they are the post's conditional
  // branches, and they are a different thing from the plan.
  const planStart = blocks.findIndex((block) => PLAN_HEADINGS.test(block.text.trim()));
  const bottomIndex = blocks.findIndex((block) => BOTTOM_LINE_HEADING.test(block.text.trim()));

  if (planStart >= 0) {
    const planEnd = bottomIndex > planStart ? bottomIndex : blocks.length;
    for (let i = planStart + 1; i < planEnd; i += 1) {
      const block = blocks[i];
      if (!block.tag.startsWith('h')) continue;

      const text = block.text.trim();
      const numbered = /^(\d+)[.)]\s*(.+)$/.exec(text);
      if (numbered) {
        const number = Number(numbered[1]);
        const rest = numbered[2].trim();
        // MOST sections carry a state after a dash ("1) Market Posture --
        // Cautiously Constructive"), but not all do. A section without a
        // state has an EMPTY state, which is different from a state this
        // parser does not recognise.
        const split = /\s*(?:--|—|–)\s*(.+)$/.exec(rest);
        const title = (split ? rest.slice(0, split.index) : rest).trim();
        const stateText = split ? split[1].trim() : '';
        const state = stateText ? classifyState(stateText) : { known: true, normalized: '' };
        const body = [];
        for (let j = i + 1; j < planEnd; j += 1) {
          if (blocks[j].tag.startsWith('h')) break;
          body.push(blocks[j].text);
        }
        result.planSections.push({
          number,
          title,
          state: state.normalized,
          known: state.known,
          evidence: block.text,
          body,
        });
        continue;
      }

      // An unnumbered heading inside the plan. In the newer posts these are
      // the scenarios; in the older ones they are the plan sections.
      if (result.planSections.length && /^(base case|current case|bullish|bearish|continuation|continued|defensive|repair|rotation|large|small|breakdown|constructive|mixed tape|split tape)/i.test(text)) {
        const split = /\s*(?:--|—|–)\s*(.+)$/.exec(text);
        const title = (split ? text.slice(0, split.index) : text).trim();
        const stateText = split ? split[1].trim() : '';
        const state = stateText ? classifyState(stateText) : { known: true, normalized: '' };
        result.scenarios.push({
          title,
          state: state.normalized,
          known: state.known,
          evidence: block.text,
        });
      }
    }
  }

  // -- the bottom line ----------------------------------------------------
  if (bottomIndex >= 0) {
    for (let j = bottomIndex + 1; j < blocks.length; j += 1) {
      if (blocks[j].tag.startsWith('h')) break;
      result.bottomLine = blocks[j].text;
      break;
    }
  }

  // -- the narrative ------------------------------------------------------
  result.paragraphs = blocks
    .filter((block) => block.tag === 'p')
    .map((block) => block.text);

  // -- the sectors in focus -----------------------------------------------
  //
  // The sector call is PROSE, not a table, and it is written three ways
  // across the corpus:
  //
  //   "Primary focus: Energy, Defensives, Healthcare, ..."   a labelled line
  //   "Primary Focus" followed by a bullet per sector          a sub-heading
  //   "Healthcare, Materials, Financials, ... continue to show strong RS"
  //                                                          a plain sentence
  //
  // So the scan has three parts: the sector SECTION (when the report has
  // one) for the sub-heading and plain-sentence forms, and a scan of the
  // WHOLE plan for the labelled-line form -- because a post whose plan has
  // no "Sector Focus" heading can still name its sectors in a labelled
  // line under "Leadership".
  //
  // The tier comes from the nearest tier label, and a sentence that says
  // "avoid" or "laggard" about a sector is that sector's being deprioritised
  // even when the tier label says otherwise.
  {
    const sectorStart = blocks.findIndex((block) => /sector (focus|allocation)/i.test(block.text));
    const planEnd = bottomIndex > 0 ? bottomIndex : blocks.length;

    const found = new Map();
    const add = (sector, tier, evidence) => {
      const existing = found.get(sector);
      if (!existing) {
        found.set(sector, { sector, tier, evidence });
        return;
      }
      // "primary" wins over the weaker tiers, because a sector that is
      // called primary somewhere and secondary elsewhere is primary.
      const rank = { avoid: 0, turnaround: 1, secondary: 2, primary: 3 };
      if ((rank[tier] ?? 2) > (rank[existing.tier] ?? 2)) {
        found.set(sector, { sector, tier, evidence });
      }
    };

    // -- the sector section: sub-headings, bare bullets, plain sentences ---
    if (sectorStart >= 0) {
      let tier = '';
      for (let i = sectorStart; i < planEnd; i += 1) {
        const block = blocks[i];
        const text = block.text;

        const tierLabel = SECTOR_TIER_LABELS.find((entry) => entry.pattern.test(text));
        if (tierLabel && text.length < 90) {
          tier = tierLabel.tier;
          continue;
        }

        const labelled = splitLabelValue(text);
        if (labelled && /leaders?|focus|allocation|tier|avoid|laggard/i.test(labelled.label)) {
          const lineTier = /avoid|laggard/i.test(labelled.label) ? 'avoid'
            : /primary|main/i.test(labelled.label) ? 'primary' : (tier || 'secondary');
          for (const sector of matchSectors(labelled.value)) add(sector, lineTier, text);
          continue;
        }

        // A bare bullet naming one sector.
        if (block.tag === 'li' && text.length < 40) {
          const sector = matchSectors(text)[0];
          if (sector) add(sector, tier || 'primary', text);
          continue;
        }

        // A plain sentence naming sectors.
        const named = matchSectors(text);
        if (named.length) {
          const sentenceTier = /avoid|laggard|underperform|weakness/i.test(text) ? 'avoid'
            : /primary|main focus|top tier|leader/i.test(text) ? 'primary' : (tier || 'secondary');
          for (const sector of named) add(sector, sentenceTier, text);
        }
      }
    }

    // -- the whole plan: the labelled-line form ---------------------------
    for (let i = 0; i < planEnd; i += 1) {
      const block = blocks[i];
      const labelled = splitLabelValue(block.text);
      if (!labelled) continue;
      if (!/^(primary|main|secondary|lower|deprioritiz|avoid|current leaders?|leading|top tier)/i.test(labelled.label)) {
        continue;
      }
      const tier = /avoid|laggard/i.test(labelled.label) ? 'avoid'
        : /lower|deprioritiz/i.test(labelled.label) ? 'secondary'
          : /primary|main/i.test(labelled.label) ? 'primary' : 'secondary';
      for (const sector of matchSectors(labelled.value)) add(sector, tier, block.text);
    }

    result.sectors = [...found.values()];
  }

  // -- the index tickers the prose mentions -------------------------------
  const tickers = new Set();
  for (const block of blocks) {
    for (const token of block.text.split(/[^A-Za-z]+/)) {
      const upper = token.toUpperCase();
      if (INDEX_TICKERS.has(upper)) tickers.add(upper);
    }
  }
  result.indexTickers = [...tickers].sort();

  return result;
}

/**
 * A one-line summary of a parsed report, for a report header.
 *
 * @param {object} parsed
 * @returns {string}
 */
function summarizeAsymArticle(parsed) {
  const report = parsed || {};
  const parts = [];
  if (report.backdrop) parts.push(`backdrop=${report.backdrop.state}`);
  if (report.trend) parts.push(`trend=${report.trend.state}`);
  if (report.breadth) parts.push(`breadth=${report.breadth.state}`);
  if (report.momentum) parts.push(`momentum=${report.momentum.state}`);
  const primary = (report.leadership || []).find((entry) => entry.tier === 'primary');
  if (primary) parts.push(`lead=${primary.sectors.slice(0, 3).join('/')}`);
  return parts.join(' ');
}

module.exports = {
  CAP_SIZES,
  INDEX_TICKERS,
  MARKET_STATES,
  METRIC_ALIASES,
  SECTORS,
  classifyState,
  decodeEntities,
  matchSectors,
  metricForLabel,
  parseAsymArticle,
  splitBlocks,
  splitLabelValue,
  summarizeAsymArticle,
  textOf,
};