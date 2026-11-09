import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Terminal JSON ingestion parses prices, sends once, refreshes edits, and retires removed posts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-html-integration-'));
  const cookieFile = join(directory, 'session.txt');
  await writeFile(cookieFile, 'reddit_session=integration-test', { mode: 0o600 });
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  let clock = originalNow();
  const published = clock - 60000;
  let body = '<p>Creed Aventus 100ml $100 90%</p>';
  const calls = [];
  Date.now = () => clock;
  process.env.REDDIT_SOURCE = 'json';
  process.env.REDDIT_HTML_COOKIE_FILE = cookieFile;
  // These legacy settings must be ignored by the HTML source.
  process.env.REDDIT_RSS_URL = 'https://should-not-be-used.example/.rss';
  process.env.REDDIT_RSS_USER = 'incomplete-legacy-config';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/sendMessage')) return Response.json({ ok: true, result: { message_id: 123 } });
    assert.match(String(url), /^https:\/\/www\.reddit\.com\/r\/fragranceswap\//);
    const post = { name: 't3_sale', id: 'sale', subreddit: 'fragranceswap', title: '[WTS] Creed Aventus (Bottle)', selftext: body.replace(/<[^>]+>/g, '\n'), created_utc: published / 1000, permalink: '/r/fragranceswap/comments/sale/bottles/', link_flair_text: null, removed_by_category: null };
    return Response.json({ kind: 'Listing', data: { children: [{ kind: 't3', data: post }] } });
  };
  try {
    const { pollReddit, store } = await import('../src/server.js');
    store.save = async () => {};
    store.data.subscriptions = { test: [{ id: 'watch', query: 'aventus', fragrance: 'aventus', createdAt: published - 60000 }] };
    await pollReddit(); // Complete batch on the first request.
    const listing = Object.values(store.data.listings)[0];
    assert.equal(listing.cents, 10000);
    assert.equal(listing.sizeMl, 100);
    assert.equal(listing.fillPct, 90);
    assert.equal(store.data.redditHtml.queue.length, 0);
    assert.equal(store.notified(`${listing.id}:test`), true);
    body = '<p>Shipping included.</p><p>Creed Aventus 100ml $90 90%</p>';
    clock += 31 * 60000;
    await pollReddit();
    clock += 90001;
    await pollReddit();
    assert.equal(store.data.listings[listing.id].cents, 9000);
    assert.equal(calls.filter((call) => call.url.includes('/sendMessage')).length, 1);
    body = '<p>[removed]</p>';
    clock += 31 * 60000;
    await pollReddit();
    clock += 90001;
    await pollReddit();
    assert.equal(store.data.listings[listing.id].status, 'removed');
    assert.equal(store.data.redditHtml.known.t3_sale.active, false);
    assert.equal(calls.filter((call) => call.url.includes('/sendMessage')).length, 1);
    assert.ok(!calls.some((call) => /\.rss|old\.reddit/.test(call.url)));
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
