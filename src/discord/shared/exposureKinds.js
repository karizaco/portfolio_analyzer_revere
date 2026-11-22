'use strict';

/**
 * Shared vocabulary for the unified exposure projection.
 * Existing tables keep their own shapes; this is the cross-trader view only.
 */

const EXPOSURE_KINDS = {
  HOLDING: 'holding',     // snapshot weight / stated book
  ACTION: 'action',       // trade verb event
  IDEA: 'idea',           // watch/focus/long_idea mention
  REGIME: 'regime',       // market checklist day (Clement plans)
  FOCUS_EPISODE: 'focus_episode', // soft book membership span
};

module.exports = { EXPOSURE_KINDS };
