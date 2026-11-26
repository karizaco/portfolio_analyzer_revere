'use strict';

/**
 * The page-scrape fallback: read the visible post articles.
 *
 * Used only when a window captured no GraphQL. It is lossy (no user id, no
 * reply target id, "Show more" truncation), so its records are marked
 * partial fidelity (src/x/normalizeDom.js).
 *
 * `extractVisibleArticles` runs INSIDE the page (Playwright's
 * page.evaluate), so it must be self-contained: no closures, no requires.
 */

/* eslint-disable no-undef */
function extractVisibleArticles() {
  const out = [];
  // X dropped the `tweet` test id (measured 2026-11-26): the articles render
  // with no test id at all, but each post still links to its own /status/ id.
  const tagged = document.querySelectorAll('article[data-testid="tweet"]');
  // A quoted post renders as an article INSIDE the quoting post's article, and
  // reading it as its own post publishes the quoted author's words under the
  // wrong account and, being older, ends the window early.
  const articles = [...(tagged.length ? tagged : document.querySelectorAll('article'))]
    .filter((a) => !a.parentElement.closest('article') && a.querySelector('a[href*="/status/"]'));
  for (const article of articles) {
    const timeEl = article.querySelector('time[datetime]');
    const link = timeEl ? timeEl.closest('a[href*="/status/"]') : article.querySelector('a[href*="/status/"]');
    const textEl = article.querySelector('[data-testid="tweetText"]')
      || [...article.querySelectorAll('div[dir="auto"]')].find((d) => (d.className || '').includes('whitespace-pre-wrap'));
    const social = article.querySelector('[data-testid="socialContext"]');
    // THE REPLY CONTEXT.
    //
    // X marks it with [data-testid="reply"]; the older markup has a div
    // whose text starts with "Replying to". Scanning EVERY div and taking
    // the first match finds a CONTAINER div as often as the marker itself
    // -- and then collects the article's own links as well, so the reply
    // policy is applied to the wrong handle. A wrong handle here flips
    // `self_thread`, and with it whether the post is kept at all.
    const replyContext = article.querySelector('[data-testid="reply"]')
      || [...article.querySelectorAll('div')].find((div) => div.childElementCount
        && /^Replying to/.test(div.innerText || '')
        && !div.querySelector('article')
        && !div.querySelector('[data-testid="tweetText"]'));
    const replyingTo = [];
    if (replyContext) {
      for (const a of replyContext.querySelectorAll('a[href^="/"]')) {
        const handle = (a.getAttribute('href') || '').replace(/^\//, '');
        if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) replyingTo.push(handle);
      }
    }
    out.push({
      status_path: link ? link.getAttribute('href') : '',
      datetime: timeEl ? timeEl.getAttribute('datetime') : '',
      text: textEl ? textEl.innerText : '',
      social_context: social ? social.innerText : '',
      replying_to: replyingTo,
      media: [...article.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]')]
        .map((img) => img.src).filter((src, i, all) => all.indexOf(src) === i),
      show_more: Boolean(article.querySelector('[data-testid="tweet-text-show-more-link"]')),
    });
  }
  return out;
}
/* eslint-enable no-undef */

/**
 * The page facts the stop-signal check needs, read inside the page.
 */
/* eslint-disable no-undef */
function readPageState() {
  return {
    url: location.href,
    title: document.title,
    bodyText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 5000),
    hasChallengeFrame: Boolean(document.querySelector(
      'iframe[src*="arkoselabs"], iframe[src*="challenges.cloudflare.com"], #arkose_iframe, #challenge-running',
    )),
    articles: document.querySelectorAll('article[data-testid="tweet"]').length
      || [...document.querySelectorAll('article')].filter((a) => a.querySelector('a[href*="/status/"]')).length,
    // Is the viewport within about a screen of the end of what is loaded?
    // Only THERE can a scroll that brought nothing mean "no more results":
    // a page of 20 tall posts (images, quotes) takes many more wheel turns
    // to cross than a page of short ones, and every one of those turns
    // brings nothing new (measured 2026-11-21: @StockSavvyShay stalled on
    // page one, 20 posts, while @BoujeeFinances's short posts paged fine).
    atBottom: (window.innerHeight + window.scrollY)
      >= (document.documentElement ? document.documentElement.scrollHeight : 0) - Math.max(window.innerHeight, 900),
  };
}
/* eslint-enable no-undef */

module.exports = { extractVisibleArticles, readPageState };
