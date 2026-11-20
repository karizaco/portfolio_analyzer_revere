'use strict';

/**
 * Which network responses carry posts, and the browser profile's location.
 *
 * The web app fetches timelines from `/i/api/graphql/<queryId>/<Operation>`.
 * The query id ROTATES whenever X ships a new client, so the match is on the
 * OPERATION NAME, never on the id.
 */

const os = require('node:os');
const path = require('node:path');

const TIMELINE_OPERATIONS = new Set([
  'UserTweets',
  'UserTweetsAndReplies',
  'SearchTimeline',
  'TweetDetail',
  // The USER lookup. It carries no posts, but it carries the account's
  // numeric user id -- which the page-scrape route cannot do without: a
  // DOM record needs the user id, and the DOM carries only the handle.
  'UserByScreenName',
]);
// `UserMedia` was in this list and is NOT: it is a media grid, not a
// timeline, and a media entry can carry a tweet the crawler never
// scrolled to -- a post from a moment the window does not cover.

const GRAPHQL_PATH = /\/i\/api\/graphql\/[A-Za-z0-9_-]+\/([A-Za-z]+)(?:\?|$)/;

/**
 * The GraphQL operation of a URL, if it is one that carries posts.
 *
 * @param {string} url
 * @returns {string|null}
 */
function timelineOperation(url) {
  const match = GRAPHQL_PATH.exec(String(url || ''));
  if (!match) return null;
  return TIMELINE_OPERATIONS.has(match[1]) ? match[1] : null;
}

/**
 * The URL with its (long, volatile) query string removed: enough to know
 * what was fetched, without storing request variables.
 *
 * @param {string} url
 * @returns {string}
 */
function stripQuery(url) {
  return String(url || '').split('?')[0];
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * The persistent browser profile. It holds the X session cookies, so it
 * lives OUTSIDE the repository by default -- a profile inside the working
 * tree is one `git add -A` away from publishing a login.
 *
 * @param {object} [env]
 * @returns {string}
 */
function defaultProfileDir(env = process.env) {
  if (env.X_BROWSER_PROFILE_DIR) return path.resolve(env.X_BROWSER_PROFILE_DIR);
  const base = env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'portfolio-analyzer', 'x-browser-profile');
}

/**
 * Is a directory inside the repository?
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isInsideRepo(dir) {
  const relative = path.relative(REPO_ROOT, path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = { REPO_ROOT, TIMELINE_OPERATIONS, defaultProfileDir, isInsideRepo, stripQuery, timelineOperation };
