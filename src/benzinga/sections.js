'use strict';

// Which part of a show a claim was made in.
//
// WHY THIS FILE EXISTS
//
// A show is not one conversation. The daily PreMarket Playbook opens with
// what happened yesterday, moves through what is on the calendar, and
// ends with the ideas for the next session -- and a sponsor reads a
// script in the middle of it.
//
// The shared extractor reads a retrospective claim from the words alone
// ("yesterday", "last week"), which catches most of a recap but not all
// of it: a recap of something that happened the day BEFORE yesterday says
// nothing retrospective. And a sponsor's segment says bullish things
// about the sponsor's product, which is not a call on any ticker.
//
// So the section is read off the transcript AROUND the claim: the cues in
// the preceding window say which part of the show the claim is in.
//
// THE SECTIONS
//
//   recap      what already happened
//   preview    what is coming: the calendar, next week
//   setup      the ideas: a trade, a level, a ticker
//   interview  a guest's own words
//   sponsor    a partner's segment
//
// THE LOOKBACK
//
// The window is 40 segments. A cue further back than that belongs to an
// earlier part of the show, and the section changes as the show moves
// on -- a recap cue from the top of the hour does not make a claim from
// the bottom of the hour a recap. The window is measured in SEGMENTS and
// not in seconds, because a segment is the unit the extractor's own
// windows are made of.

/** How many segments back a cue is looked for. */
const SECTION_LOOKBACK_SEGMENTS = 40;

/**
 * The section cues, in the order they are tested.
 *
 * The order matters: "sponsor" is tested before "setup", because a
 * sponsor reads setup-like language ("we love this product") and the
 * sponsor's segment must not become a trade idea.
 */
const SECTION_CUES = [
  {
    section: 'sponsor',
    pattern: /\b(?:brought\s+to\s+you|sponsored\s+by|support(?:ed)?\s+by|thanks\s+to\s+(?:our\s+)?(?:sponsor|partner)|promo\s+code|use\s+(?:my\s+)?code|all\s+access\s+is\s+free|sign\s+up\s+(?:for|at)|coupon\s+code|discount\s+code)\b/i,
  },
  {
    section: 'interview',
    pattern: /\b(?:welcome\s+to\s+(?:the\s+)?show|joining\s+(?:me|us)\s+(?:today|now)|my\s+guest\s+is|thanks\s+for\s+joining|question\s+from\s+the\s+chat|say\s+hello\s+to)\b/i,
  },
  {
    section: 'preview',
    pattern: /\b(?:next\s+(?:week|month|session|day)|coming\s+up|on\s+the\s+calendar|this\s+week['’]?s|what['’]?s\s+(?:ahead|coming)|looking\s+ahead|the\s+calendar|earnings\s+(?:this|next)|events?\s+(?:this|next)|preview|setup\s+for\s+(?:the\s+)?(?:next|tomorrow|monday|tuesday|wednesday|thursday|friday))\b/i,
  },
  {
    section: 'recap',
    pattern: /\b(?:yesterday|on\s+(?:monday|tuesday|wednesday|thursday|friday|last\s+\w+day)|last\s+(?:week|month|session|week['’]?s)|recap|closing\s+bell|yesterday['’]?s|so\s+what\s+happened|where\s+we\s+left\s+off|that\s+was\s+yesterday)\b/i,
  },
  {
    section: 'setup',
    pattern: /\b(?:my\s+(?:trade|idea|setup|watch)|the\s+(?:trade|setup)\s+is|here['’]?s\s+my|i\s+(?:like|love|am)\s+(?:this|it|the)|levels?\s+to\s+watch|trade\s+idea|my\s+take\s+on|position\s+in|adding\s+(?:to|in)|i['’]?m\s+(?:going\s+to\s+)?buy|i['’]?m\s+going\s+to\s+sell)\b/i,
  },
];

/**
 * The section the segment at `index` belongs to.
 *
 * @param {Array<{text?: string}>} segments
 * @param {number} index
 * @returns {string} the section, or '' when nothing says
 */
function sectionAt(segments, index) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) return '';
  const start = Math.max(0, Math.min(index, list.length - 1) - SECTION_LOOKBACK_SEGMENTS);
  const window = list.slice(start, Math.min(index, list.length - 1) + 1)
    .map((segment) => String(segment.text || ''))
    .join(' ');

  for (const { section, pattern } of SECTION_CUES) {
    if (pattern.test(window)) return section;
  }
  return '';
}

module.exports = {
  SECTION_CUES,
  SECTION_LOOKBACK_SEGMENTS,
  sectionAt,
};
