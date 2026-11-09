import test from 'node:test';
import assert from 'node:assert/strict';
import { RedditHtmlSource, HTML_REQUEST_INTERVAL_MS, validateSessionCookie } from '../src/reddit-html-source.js';

const initialTime = Date.now();
const htmlPost = (id, title = '[WTS] Creed (Bottle)', body = '') => `<div class="thing link self" data-fullname="t3_${id}" data-subreddit="fragranceswap" data-timestamp="${initialTime - 60000}"><a class="title" href="/r/fragranceswap/comments/${id}/sale/">${title}</a><a class="comments" href="/r/fragranceswap/comments/${id}/sale/">comments</a>${body}</div>`;
const body = (value) => `<div class="usertext-body"><div class="md"><p>${value}</p></div></div>`;
function harness() {
  let state;
  let now = initialTime;
  let cookie = 'reddit_session=local-test';
  const calls = [];
  let response = () => new Response(htmlPost('sale1') + htmlPost('sale2') + htmlPost('buy', '[WTB] Creed'), { headers: { 'content-type': 'text/html' } });
  const create = () => new RedditHtmlSource({
    getState: () => state, saveState: async (value) => { state = structuredClone(value); },
    now: () => now, loadCookie: async () => cookie,
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options, now }); return response(url); },
  });
  return { create, calls, state: () => structuredClone(state), advance: (ms = HTML_REQUEST_INTERVAL_MS) => { now += ms; },
    setState: (value) => { state = structuredClone(value); },
    setCookie: (value) => { cookie = value; }, setResponse: (value) => { response = value; } };
}

test('HTML source persists discoveries, spaces reads across restart, and acknowledges only saved posts', async () => {
  const h = harness();
  const source = h.create();
  assert.deepEqual(await source.fetchPosts(), []);
  assert.equal(h.state().queue.length, 2);
  h.setResponse(() => new Response(htmlPost('sale1', undefined, body('Creed Aventus 100ml $100')), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(h.create().fetchPosts(), /Preserving/);
  assert.equal(h.calls.length, 1);
  h.advance();
  const [post] = await h.create().fetchPosts();
  assert.equal(post.id, 't3_sale1');
  assert.equal(h.state().queue.length, 2); // An ingestion failure still leaves the post queued.
  h.advance();
  const [retry] = await h.create().fetchPosts();
  assert.equal(retry.id, post.id);
  await source.acknowledgePost(retry, true);
  assert.equal(h.state().queue.length, 1);
  assert.equal(h.state().known[post.id].active, true);
  assert.ok(h.calls.every((call) => call.url.startsWith('https://old.reddit.com/r/fragranceswap/') && !/\.rss|\.json/.test(call.url)));
});

test('renewed cookies are read on the next request and never forwarded through redirects', async () => {
  const h = harness();
  const source = h.create();
  h.setResponse(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
  await assert.rejects(source.fetchPosts(), /Renew/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.redirect, 'manual');
  h.advance();
  h.setCookie('reddit_session=renewed-test');
  h.setResponse(() => new Response(htmlPost('sale1'), { headers: { 'content-type': 'text/html' } }));
  await source.fetchPosts();
  assert.equal(h.calls[1].options.headers.cookie, 'reddit_session=renewed-test');
  await assert.rejects(source.readHtml('https://elsewhere.example/'), /outside/);
  await assert.rejects(source.readHtml('/r/another/new/'), /outside/);
  assert.equal(h.calls.length, 2);
  assert.throws(() => validateSessionCookie('reddit_session=value\nInjected: header'), /Invalid/);
});

test('unreadable bodies stay queued for retry while other posts can proceed', async () => {
  const h = harness();
  const source = h.create();
  await source.fetchPosts();
  h.advance();
  h.setResponse(() => new Response(htmlPost('sale1'), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(source.fetchPosts(), /complete text body/);
  assert.deepEqual(h.state().queue.map((post) => post.id), ['t3_sale2', 't3_sale1']);
  assert.ok(h.state().queue[1].nextAttemptAt > initialTime);
  h.advance();
  h.setResponse(() => new Response(htmlPost('sale2', undefined, body('$100')), { headers: { 'content-type': 'text/html' } }));
  const [post] = await source.fetchPosts();
  assert.equal(post.id, 't3_sale2');
});

test('HTTP failures and HTML access challenges preserve the queue and discovery checkpoint', async () => {
  const h = harness();
  const source = h.create();
  await source.fetchPosts();
  h.advance();
  h.setResponse(() => new Response('Denied', { status: 403 }));
  await assert.rejects(source.fetchPosts(), (error) => error.status === 403);
  assert.equal(h.state().queue.length, 2);
  h.advance();
  h.setResponse(() => new Response('<input name="js_challenge" value="1">', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(source.fetchPosts(), (error) => error.needsAttention && error.retryAfterMs >= 900000);
  assert.equal(h.state().queue.length, 2);
});

test('new sale discoveries precede refreshes and RSS listings seed later refresh work', async () => {
  const h = harness();
  const source = h.create();
  await source.fetchPosts();
  await source.acknowledgePost({ id: 't3_sale1', permalink: '/r/fragranceswap/comments/sale1/sale/', publishedAt: initialTime - 60000 }, true);
  await source.acknowledgePost({ id: 't3_sale2', permalink: '/r/fragranceswap/comments/sale2/sale/', publishedAt: initialTime - 60000 }, false);
  h.advance(31 * 60000);
  h.setResponse(() => new Response(htmlPost('sale1') + htmlPost('newest'), { headers: { 'content-type': 'text/html' } }));
  await source.fetchPosts([{ postId: 't3_rss', permalink: 'https://www.reddit.com/r/fragranceswap/comments/rss/old/', recordedAt: initialTime - 60000, status: 'available' }]);
  assert.equal(h.state().queue[0].id, 't3_newest');
  assert.ok(h.state().queue.some((post) => post.id === 't3_sale1'));
  assert.ok(h.state().queue.some((post) => post.id === 't3_rss'));
  assert.ok(!h.state().queue.some((post) => post.id === 't3_sale2'));
});

test('long polling intervals still process queued bodies and idle steps do not claim a fresh read', async () => {
  const h = harness();
  const source = h.create();
  await source.fetchPosts();
  h.advance(10 * 60000);
  h.setResponse(() => new Response(htmlPost('sale1', undefined, body('$100')), { headers: { 'content-type': 'text/html' } }));
  const [post] = await source.fetchPosts();
  assert.equal(post.id, 't3_sale1');
  await source.acknowledgePost(post, false);
  await source.acknowledgePost({ id: 't3_sale2', permalink: '/r/fragranceswap/comments/sale2/sale/', publishedAt: initialTime - 60000 }, false);
  h.advance();
  h.setResponse(() => new Response(htmlPost('sale1') + htmlPost('sale2'), { headers: { 'content-type': 'text/html' } }));
  await source.fetchPosts();
  const lastRead = h.state().lastSuccessfulReadAt;
  const requestCount = h.calls.length;
  h.advance();
  assert.deepEqual(await source.fetchPosts(), []);
  assert.equal(h.calls.length, requestCount);
  assert.equal(h.state().lastSuccessfulReadAt, lastRead);
});

test('legacy RSS refresh backlogs cannot crowd out new sales or grow the ready refresh batch', async () => {
  const h = harness();
  const source = h.create();
  const oldQueue = Array.from({ length: 2800 }, (_, i) => ({ id: `t3_old${i}`, permalink: `/r/fragranceswap/comments/old${i}/sale/`, publishedAt: initialTime - (2800 - i) * 60000, checkedAt: 0, active: true }));
  h.setState({ subreddit: 'fragranceswap', queue: oldQueue, known: {}, lastDiscoveryAt: 0, lastRequestAt: 0 });
  await source.fetchPosts();
  assert.equal(h.state().queue.length, 12);
  assert.deepEqual(h.state().queue.slice(0, 2).map((post) => post.id), ['t3_sale1', 't3_sale2']);
  assert.equal(h.state().queue[2].id, 't3_old2799');
  assert.ok(h.state().queue.slice(2).every((post) => post.kind === 'refresh'));
  await source.acknowledgePost({ id: 't3_sale1', permalink: '/r/fragranceswap/comments/sale1/sale/', publishedAt: initialTime - 60000 }, true);
  await source.acknowledgePost({ id: 't3_sale2', permalink: '/r/fragranceswap/comments/sale2/sale/', publishedAt: initialTime - 60000 }, true);
  // The acknowledgments above stand in for two completed detail requests.
  h.setState({ ...h.state(), lastRequestKind: 'detail' });
  h.advance(6 * 60000);
  h.setResponse(() => new Response(htmlPost('newest'), { headers: { 'content-type': 'text/html' } }));
  await source.fetchPosts();
  assert.equal(h.state().queue[0].id, 't3_newest');
  assert.equal(h.state().queue.filter((post) => post.kind === 'refresh' && !post.nextAttemptAt).length, 10);
});

test('a page without readable post elements is deferred without treating it as a global auth failure', async () => {
  const h = harness();
  const source = h.create();
  await source.fetchPosts();
  h.advance();
  h.setResponse(() => new Response('<title>Unexpected page</title><main>Unavailable</main>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(source.fetchPosts(), (error) => !error.needsAttention && /post t3_sale1/.test(error.message));
  assert.equal(h.state().queue[0].id, 't3_sale2');
});
