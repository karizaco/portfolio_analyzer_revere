'use strict';

/**
 * The API spending guard.
 *
 * X bills a post read per post RETURNED ($0.005 on 2026-11-20). A search
 * page asks for up to `max_results` posts, so the worst case of a page is
 * known BEFORE it is requested -- and that is what lets this guard stop
 * BEFORE a request that could cross the budget, instead of noticing after.
 *
 * The page size is shrunk to what is still affordable; when even the
 * minimum page (10 posts) is not affordable, the run stops with
 * `stop_reason: 'budget'` and the window keeps its pagination token, so a
 * later run with more budget continues exactly where this one stopped.
 *
 * X also de-duplicates a resource within one UTC day; this guard ignores
 * that and charges every returned post, so its estimate is an UPPER bound.
 */

const fs = require('node:fs');
const path = require('node:path');

const PRICING_PATH = path.resolve(__dirname, '..', '..', 'config', 'x_api_pricing.json');
const MIN_SEARCH_PAGE = 10;
const MAX_SEARCH_PAGE = 500;

/**
 * @param {string} [file]
 * @returns {{post_read: number, user_read: number, counts_all_request: number, counts_recent_request: number}}
 */
function loadPricing(file = PRICING_PATH) {
  const pricing = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['post_read', 'user_read', 'counts_all_request']) {
    if (!(Number(pricing[key]) > 0)) throw new Error(`pricing ${key} is missing in ${file}`);
  }
  return pricing;
}

/**
 * @param {object} options
 * @param {number} options.budgetUsd - the most this run may spend
 * @param {number} [options.maxPosts] - an additional cap on posts read
 * @param {object} [options.pricing]
 */
function createBudget(options) {
  const pricing = options.pricing || loadPricing();
  const budgetUsd = Number(options.budgetUsd);
  if (!(budgetUsd >= 0)) throw new Error('a budget in USD is required (--budget-usd)');
  const maxPosts = Number.isFinite(options.maxPosts) && options.maxPosts > 0 ? options.maxPosts : Infinity;
  let spent = 0;
  let posts = 0;

  return {
    pricing,
    get spent() { return Number(spent.toFixed(6)); },
    get posts() { return posts; },
    get remainingUsd() { return Math.max(0, budgetUsd - spent); },

    /** Can a request of this unit (counts / user lookup) be afforded? */
    canAfford(unit) {
      return spent + Number(pricing[unit]) <= budgetUsd + 1e-9;
    },

    /**
     * The search page size that cannot cross the budget, or 0 to stop.
     *
     * @param {number} [wanted]
     * @returns {number}
     */
    searchPageSize(wanted = MAX_SEARCH_PAGE) {
      const byMoney = Math.floor((budgetUsd - spent + 1e-9) / pricing.post_read);
      const byCount = maxPosts - posts;
      const size = Math.min(wanted, MAX_SEARCH_PAGE, byMoney, byCount);
      return size >= MIN_SEARCH_PAGE ? size : 0;
    },

    /**
     * Charge what a response returned.
     *
     * @param {string} unit
     * @param {number} resources - posts/users returned; ignored for per-request units
     * @returns {{unit: string, unitPrice: number, cost: number}}
     */
    charge(unit, resources = 1) {
      const unitPrice = Number(pricing[unit]);
      const perRequest = unit.endsWith('_request');
      const cost = perRequest ? unitPrice : unitPrice * resources;
      spent += cost;
      if (unit === 'post_read') posts += resources;
      return { unit, unitPrice, cost: Number(cost.toFixed(6)) };
    },
  };
}

/**
 * The estimated cost of reading `posts` posts.
 *
 * @param {number} posts
 * @param {object} [pricing]
 * @returns {number}
 */
function estimateReadCost(posts, pricing = loadPricing()) {
  return Number((posts * pricing.post_read).toFixed(4));
}

module.exports = { MAX_SEARCH_PAGE, MIN_SEARCH_PAGE, PRICING_PATH, createBudget, estimateReadCost, loadPricing };
