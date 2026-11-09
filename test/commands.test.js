import test from 'node:test';
import assert from 'node:assert/strict';
import { command, store, listingFromLine, atomPosts, pollReddit, redditPollInterval } from '../src/server.js';

const now = Date.now();
const bottle = (id, overrides = {}) => ({ id, postId: id, fragrance: 'absolu aventus', brand: 'creed', raw: 'Creed Absolu Aventus 100ml $100', status: 'available', recordedAt: now - 1000, cents: 10000, sizeMl: 100, normalizedCentsPerMl: 100, isDecant: false, permalink: 'https://www.reddit.com/r/fragranceswap/test', ...overrides });

test('Reddit polling cannot be configured more frequently than every 90 seconds', () => {
  assert.equal(redditPollInterval(undefined), 90_000);
  assert.equal(redditPollInterval('60000'), 90_000);
  assert.equal(redditPollInterval('120000'), 120_000);
});

test('/find accepts reordered names, brand-only queries, and gives usage without arguments', async () => {
  store.data.listings = { a: bottle('a'), b: bottle('b', { status: 'sold' }), c: bottle('c', { recordedAt: now - 31 * 86400000 }) };
  for (const query of ['/find aventus absolu', '/find Creed', '/find@ScentinelBot absolu']) {
    const result = await command('test', query);
    assert.match(result.text, /Showing 1 of 1/);
    assert.match(result.text, /absolu aventus/);
    assert.match(result.text, /\$1\/ml/);
    assert.doesNotMatch(result.text, /\$100\/ml/);
  }
  assert.match(await command('test', '/find'), /Use \/find/);
  assert.match(await command('test', '/find adventurous'), /No active indexed/);
});

test('/deals excludes decants and above-median bottles and does not use decant comparables', async () => {
  const rows = [bottle('deal'), bottle('expensive', { normalizedCentsPerMl: 250 }), bottle('decant', { isDecant: true, normalizedCentsPerMl: 10 }), bottle('legacy-decant', { raw: 'Absolu Aventus sample 2ml $5', normalizedCentsPerMl: 10 }), ...Array.from({ length: 6 }, (_, i) => bottle(`comp-${i}`, { normalizedCentsPerMl: 200, recordedAt: now - 2 * 86400000 }))];
  store.data.listings = Object.fromEntries(rows.map((row) => [row.id, row]));
  const result = await command('test', '/deals');
  assert.match(result.text, /TOP 1 BOTTLE DEALS/);
  assert.match(result.text, /50% below median/);
  store.data.listings = Object.fromEntries(rows.filter((row) => !row.id.startsWith('comp-')).map((row) => [row.id, row]));
  assert.match(await command('test', '/deals'), /No bottle deals/);
});

test('parser handles fractional fill, stable IDs, samples, sold rows, and ambiguous rows', () => {
  const post = { id: 'post', title: '[WTS] Bottles', selftext: 'Also have samples', permalink: '/r/fragranceswap/test', publishedAt: now };
  const listing = listingFromLine(post, 'Creed Aventus 50/100ml $100', 1);
  assert.equal(listing.sizeMl, 100);
  assert.equal(listing.fillPct, 50);
  assert.equal(listing.normalizedCentsPerMl, 200);
  assert.equal(listing.isDecant, false);
  assert.equal(listingFromLine(post, 'Creed Aventus 50/100ml $90', 1).id, listing.id);
  assert.equal(listingFromLine(post, 'Creed Aventus sample 2ml $5', 2).isDecant, true);
  assert.equal(listingFromLine(post, '~~Creed Aventus 100ml $100~~', 3).status, 'sold');
  assert.equal(listingFromLine(post, 'Creed Aventus $100 Dior Sauvage $50', 4), null);
});

test('Atom tables preserve rows and sold strikethrough markers', () => {
  const [post] = atomPosts('<feed><entry><id>post</id><title>[WTS] Bottles</title><link href="https://www.reddit.com/r/fragranceswap/test"/><published>2026-09-08T12:00:00Z</published><content>&lt;table&gt;&lt;tr&gt;&lt;td&gt;&lt;del&gt;Aventus $100&lt;/del&gt;&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;Sauvage $50&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</content></entry></feed>');
  assert.match(post.selftext, /~~Aventus \$100~~/);
  assert.match(post.selftext, /\n.*Sauvage/);
});

test('failed alerts retry on unchanged listings and overlapping watches deliver once per chat', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalSave = store.save;
  const originalError = console.error;
  const attempts = [];
  let clock = now;
  let fail = true;
  store.data.listings = { a: bottle('a') };
  const watch = { id: 'watch', query: 'aventus', fragrance: 'aventus', createdAt: now - 5000 };
  store.data.subscriptions = { first: [watch, { ...watch, id: 'overlap' }], second: [watch] };
  store.data.notifications = {};
  store.save = async () => {};
  console.error = () => {};
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/sendMessage')) return new Response('<feed></feed>');
    const { chat_id } = JSON.parse(options.body);
    attempts.push(chat_id);
    if (chat_id === 'first' && fail) return Response.json({ ok: false, description: 'temporary failure' }, { status: 503 });
    return Response.json({ ok: true, result: { message_id: 123 } });
  };
  try {
    await pollReddit();
    assert.deepEqual(attempts, ['first', 'second']);
    fail = false;
    clock += 90_001;
    await pollReddit();
    clock += 90_001;
    await pollReddit();
    assert.deepEqual(attempts, ['first', 'second', 'first']);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    store.save = originalSave;
    console.error = originalError;
    store.data.subscriptions = {};
  }
});
