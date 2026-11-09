import test from 'node:test';
import assert from 'node:assert/strict';

test('private RSS credentials and redirect cookies are retained without exposing the token', async () => {
  process.env.REDDIT_RSS_USER = 'rss_user';
  process.env.REDDIT_RSS_TOKEN = 'private-token';
  process.env.REDDIT_USER_AGENT = 'node:scentinel-test:v0.1.0 (by /u/rss_user)';

  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const calls = [];
  let clock = 1_800_000_000_000;
  Date.now = () => clock;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options, requestedAt: clock });
    clock += 90_001;
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: '/r/fragranceswap/new/.rss?redirected=1', 'set-cookie': 'reddit_session=session-cookie; Path=/; HttpOnly' } });
    return new Response('<feed></feed>', { headers: { 'content-type': 'application/atom+xml' } });
  };

  const { pollReddit, store } = await import('../src/server.js');
  const originalSave = store.save;
  store.save = async () => {};
  try {
    await pollReddit();
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    store.save = originalSave;
  }

  const firstUrl = new URL(calls[0].url);
  assert.equal(firstUrl.searchParams.get('user'), 'rss_user');
  assert.equal(firstUrl.searchParams.get('feed'), 'private-token');
  assert.equal(calls[1].options.headers.cookie, 'reddit_session=session-cookie');
  assert.equal(calls[1].options.headers['user-agent'], process.env.REDDIT_USER_AGENT);
  assert.ok(calls[1].requestedAt - calls[0].requestedAt >= 90_000);
});
