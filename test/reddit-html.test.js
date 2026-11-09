import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOldRedditListing, parseOldRedditPost } from '../src/reddit-html.js';

const timestamp = Date.now() - 60_000;
const post = (body = '', overrides = '') => `<div class="thing link self" data-fullname="t3_sale1" data-subreddit="fragranceswap" data-timestamp="${timestamp}" ${overrides}>
  <div class="entry"><p class="title"><a class="title" href="/r/fragranceswap/comments/sale1/bottles/">[WTS] Creed &amp; Dior (Bottle)</a></p>
  <p class="tagline"><time datetime="2026-09-30T12:00:00Z">2 days ago</time></p>
  <a class="comments" href="https://old.reddit.com/r/fragranceswap/comments/sale1/bottles/">comments</a>
  ${body}</div></div>`;
const body = (content) => `<div class="expando"><div class="usertext-body"><div class="md">${content}</div></div></div>`;

test('HTML discovery validates real post tags, metadata, and canonical links', () => {
  const [result] = parseOldRedditListing(post(), 'fragranceswap');
  assert.equal(result.id, 't3_sale1');
  assert.equal(result.title, '[WTS] Creed & Dior (Bottle)');
  assert.equal(result.publishedAt, timestamp);
  assert.equal(result.permalink, '/r/fragranceswap/comments/sale1/bottles/');
  assert.throws(() => parseOldRedditListing(post().replace('https://old.reddit.com/', 'https://elsewhere.example/'), 'fragranceswap'), /link did not match/);
  assert.throws(() => parseOldRedditListing(post().replace('data-subreddit="fragranceswap"', 'data-subreddit="another"'), 'fragranceswap'), /requested subreddit/);
});

test('complete body preserves table rows, sold markers, and escaped text', () => {
  const result = parseOldRedditPost(post(body('<table><tr><td><p>Creed Aventus</p></td><td>100ml</td><td>$100</td></tr><tr><td><del>Dior Sauvage</del></td><td><s>60ml $50</s></td></tr></table><p>Shipping &amp; fees included.</p>')), 'fragranceswap', 't3_sale1');
  assert.match(result.selftext, /Creed Aventus\s+100ml\s+\$100\n/);
  assert.match(result.selftext, /~~Dior Sauvage~~.*~~60ml \$50~~/);
  assert.match(result.selftext, /Shipping & fees included/);
});

test('comments and scripts cannot substitute for a missing post body', () => {
  const comment = '<div class="thing comment" data-fullname="t1_comment"><div class="usertext-body"><div class="md">Creed Aventus 100ml $1</div></div></div>';
  assert.throws(() => parseOldRedditPost(post(comment), 'fragranceswap', 't3_sale1'), /complete text body/);
  assert.throws(() => parseOldRedditListing(`<script>${post(body('Fake $10'))}</script>`, 'fragranceswap'), /no readable post elements/);
  const result = parseOldRedditPost(post(body('<p>Creed Aventus 100ml $100</p><script>fake $1</script>') + comment), 'fragranceswap', 't3_sale1');
  assert.equal(result.selftext, 'Creed Aventus 100ml $100');
});

test('login, access challenges, empty bodies, wrong IDs, and missing dates fail closed', () => {
  assert.throws(() => parseOldRedditListing('<main>Log in</main>', 'fragranceswap'), /no readable post elements/);
  assert.throws(() => parseOldRedditListing('<input name="js_challenge" value="1">', 'fragranceswap'), /access challenge/);
  assert.throws(() => parseOldRedditListing('<main>You have been blocked by network security.</main>', 'fragranceswap'), /access challenge/);
  assert.throws(() => parseOldRedditPost(post(body('')), 'fragranceswap', 't3_sale1'), /complete text body/);
  assert.throws(() => parseOldRedditPost(post(body('$100')), 'fragranceswap', 't3_wrong'), /requested post/);
  assert.throws(() => parseOldRedditListing(post().replace(/data-timestamp="[^"]+"/, '').replace(/<time[^>]*>[^<]*<\/time>/, ''), 'fragranceswap'), /publication time/);
  assert.equal(parseOldRedditPost(post(body('[removed]')), 'fragranceswap', 't3_sale1').unavailable, true);
});

test('deleted Old Reddit wrappers are identified by their canonical permalink when fullname is stripped', () => {
  const deleted = `<div class="thing link self deleted" data-subreddit="fragranceswap" data-timestamp="${timestamp}" data-permalink="/r/fragranceswap/comments/sale1/bottles/"><div class="entry"><a class="title" href="/r/fragranceswap/comments/sale1/bottles/">[WTS] Creed (Bottle)</a><div class="usertext-body"><div class="md"><p>[deleted]</p></div></div></div></div><div class="thing comment"><div class="usertext-body"><div class="md">Creed Aventus 100ml $100</div></div></div>`;
  const result = parseOldRedditPost(deleted, 'fragranceswap', 't3_sale1');
  assert.equal(result.id, 't3_sale1');
  assert.equal(result.unavailable, true);
  assert.equal(result.selftext, '[deleted]');
  assert.throws(() => parseOldRedditPost(deleted, 'fragranceswap', 't3_wrong'), /requested post/);
  assert.throws(() => parseOldRedditPost(deleted.replace('data-permalink="/r/', 'data-permalink="https://elsewhere.example/r/'), 'fragranceswap', 't3_sale1'), /no readable post/);
  assert.throws(() => parseOldRedditPost(deleted.replace('data-permalink="/r/fragranceswap', 'data-permalink="/r/another'), 'fragranceswap', 't3_sale1'), /another subreddit|link did not match/);
});

test('only identified login or challenge pages trigger an access failure', () => {
  assert.throws(() => parseOldRedditListing('<title>Welcome to Reddit</title><auth-flow-manager></auth-flow-manager>', 'fragranceswap'), (error) => error.needsAttention && /login page/.test(error.message));
  assert.throws(() => parseOldRedditListing('<title>Unexpected page</title><main>Unavailable</main>', 'fragranceswap'), (error) => !error.needsAttention);
});
