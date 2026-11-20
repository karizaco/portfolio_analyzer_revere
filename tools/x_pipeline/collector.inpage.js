/*
 * X timeline collector -- runs INSIDE an x.com page.
 *
 * For agentic mode B (tools/x_pipeline/agentic_prompt.md): an agent driving
 * the Playwright MCP browser injects this file with `browser_evaluate`, then
 * scrolls. Every GraphQL timeline response the web app fetches
 * (UserTweets, UserTweetsAndReplies, SearchTimeline, TweetDetail, UserMedia)
 * is captured, COMPACTED to the posts it carries, and buffered as the same
 * envelope tools/runXPipeline.js imports:
 *
 *   { x_capture: 1, route: "web_graphql", operation, url, status, fetched_at, body }
 *
 * The agent then calls `window.__xCollector.drain(maxBytes)` and writes the
 * returned JSON array to data/x_pipeline/raw/<run>/agent_<n>.json.
 *
 * Compaction keeps only what src/x/normalizeGraphql.js reads (the tweet
 * results, their author's id and handle, the note text, the quote/repost,
 * views, edit control), because every byte the drain returns passes through
 * the agent's context.
 *
 * Idempotent: injecting it twice keeps one collector.
 */
(function installXCollector() {
  if (window.__xCollector && window.__xCollector.version === 1) return 'already installed';

  var OPERATIONS = /\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserTweets|UserTweetsAndReplies|SearchTimeline|TweetDetail|UserMedia)(?:\?|$)/;
  var buffer = [];
  var stats = { captured: 0, posts: 0, drained: 0, errors: 0, lastStatus: null, rateLimitReset: null };

  function trimUser(user) {
    if (!user) return user;
    return {
      __typename: user.__typename,
      rest_id: user.rest_id,
      core: user.core ? { screen_name: user.core.screen_name, name: user.core.name } : undefined,
      legacy: user.legacy ? { screen_name: user.legacy.screen_name, name: user.legacy.name } : undefined,
    };
  }

  function trimTweet(result, depth) {
    if (!result || typeof result !== 'object') return result;
    if (result.__typename === 'TweetWithVisibilityResults') {
      return { __typename: result.__typename, tweet: trimTweet(result.tweet, depth) };
    }
    if (!result.legacy) return { __typename: result.__typename, tombstone: result.tombstone };
    var legacy = result.legacy;
    var out = {
      __typename: result.__typename,
      rest_id: result.rest_id,
      core: { user_results: { result: trimUser(result.core && result.core.user_results && result.core.user_results.result) } },
      legacy: {
        id_str: legacy.id_str, user_id_str: legacy.user_id_str, created_at: legacy.created_at, full_text: legacy.full_text,
        conversation_id_str: legacy.conversation_id_str, lang: legacy.lang,
        in_reply_to_status_id_str: legacy.in_reply_to_status_id_str, in_reply_to_user_id_str: legacy.in_reply_to_user_id_str,
        in_reply_to_screen_name: legacy.in_reply_to_screen_name, is_quote_status: legacy.is_quote_status,
        quoted_status_id_str: legacy.quoted_status_id_str, entities: legacy.entities,
        extended_entities: legacy.extended_entities, favorite_count: legacy.favorite_count,
        retweet_count: legacy.retweet_count, reply_count: legacy.reply_count, quote_count: legacy.quote_count,
        bookmark_count: legacy.bookmark_count,
      },
      note_tweet: result.note_tweet,
      views: result.views,
      edit_control: result.edit_control,
    };
    if (depth < 2 && legacy.retweeted_status_result) {
      out.legacy.retweeted_status_result = { result: trimTweet(legacy.retweeted_status_result.result, depth + 1) };
    }
    if (depth < 2 && result.quoted_status_result) {
      out.quoted_status_result = { result: trimTweet(result.quoted_status_result.result, depth + 1) };
    }
    return out;
  }

  function compact(body) {
    var items = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var value = node[key];
        if ((key === 'tweet_results' || key === 'tweetResult') && value && typeof value === 'object' && 'result' in value) {
          items.push({ tweet_results: { result: trimTweet(value.result, 0) } });
          continue;
        }
        if (key === 'cursorType' && node.value) items.push({ cursorType: node.cursorType, value: node.value });
        walk(value);
      }
    })(body);
    stats.posts += items.filter(function (item) { return item.tweet_results; }).length;
    return { data: { x_compact: { items: items } } };
  }

  function capture(url, status, text, resetHeader) {
    var match = OPERATIONS.exec(String(url || ''));
    if (!match) return;
    stats.lastStatus = status;
    if (status === 429) { stats.rateLimitReset = resetHeader || null; return; }
    if (status !== 200) return;
    try {
      buffer.push({
        x_capture: 1, route: 'web_graphql', operation: match[1], url: String(url).split('?')[0],
        status: status, fetched_at: new Date().toISOString(), body: compact(JSON.parse(text)),
      });
      stats.captured += 1;
    } catch (error) {
      stats.errors += 1;
    }
  }

  var originalFetch = window.fetch;
  window.fetch = function patchedFetch() {
    var args = arguments;
    return originalFetch.apply(this, args).then(function (response) {
      try {
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
        if (OPERATIONS.test(String(url || ''))) {
          response.clone().text().then(function (text) {
            capture(url, response.status, text, response.headers.get('x-rate-limit-reset'));
          }).catch(function () { stats.errors += 1; });
        }
      } catch (error) { stats.errors += 1; }
      return response;
    });
  };

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__xUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function patchedSend() {
    var xhr = this;
    if (OPERATIONS.test(String(xhr.__xUrl || ''))) {
      xhr.addEventListener('load', function () {
        try {
          var text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : JSON.stringify(xhr.response);
          capture(xhr.__xUrl, xhr.status, text, xhr.getResponseHeader('x-rate-limit-reset'));
        } catch (error) { stats.errors += 1; }
      });
    }
    return originalSend.apply(this, arguments);
  };

  window.__xCollector = {
    version: 1,
    stats: function () { return Object.assign({ buffered: buffer.length }, stats); },
    /** Remove and return buffered envelopes, up to maxBytes of JSON (default 150 kB). */
    drain: function (maxBytes) {
      var limit = maxBytes || 150000;
      var out = [];
      var size = 2;
      while (buffer.length) {
        var next = JSON.stringify(buffer[0]);
        if (out.length && size + next.length > limit) break;
        out.push(buffer.shift());
        size += next.length + 1;
      }
      stats.drained += out.length;
      return out;
    },
  };
  return 'installed';
})();
