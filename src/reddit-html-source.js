import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseOldRedditListing, parseOldRedditPost } from './reddit-html.js';

export const HTML_REQUEST_INTERVAL_MS = 90_000;
const FEED_INTERVAL_MS = 300_000;
const REFRESH_INTERVAL_MS = 30 * 60_000;
const RETENTION_MS = 30 * 86400_000;
const origin = 'https://old.reddit.com';
const MAX_READY_REFRESHES = 10;

function prepareQueue(state, now) {
  const queue = new Map();
  for (const post of state.queue) {
    if (post.publishedAt < now - RETENTION_MS) continue;
    const kind = post.kind || (post.title && !state.known[post.id] ? 'new' : 'refresh');
    queue.set(post.id, { ...post, kind });
  }
  const fresh = [...queue.values()].filter((post) => post.kind === 'new').sort((a, b) => a.publishedAt - b.publishedAt);
  const refreshes = [...queue.values()].filter((post) => post.kind === 'refresh').sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0) || b.publishedAt - a.publishedAt);
  // Older index entries can be rescheduled from the store on the next discovery.
  // Keep new sales and deferred retries; bound only the ready refresh batch.
  return [...fresh, ...refreshes.filter((post) => !post.nextAttemptAt || post.nextAttemptAt <= now).slice(0, MAX_READY_REFRESHES), ...refreshes.filter((post) => post.nextAttemptAt > now)];
}

export function validateSessionCookie(value) {
  const cookie = String(value).trim().replace(/^cookie:\s*/i, '');
  if (!cookie || /[\r\n\x00-\x1f\x7f]/.test(cookie) || cookie.length > 32_768 || !/(?:^|;\s*)(?:reddit_session|token_v2)=\S+/.test(cookie)) {
    throw new Error('Invalid Reddit session file. Run npm run reddit:session-check -- --renew.');
  }
  return cookie;
}

export class RedditHtmlSource {
  constructor({ subreddit = 'fragranceswap', cookieFile = 'data/reddit-session.txt', userAgent = 'node:scentinel:v0.1.0 (fragrance listing monitor)', getState, saveState, fetchImpl = (...args) => fetch(...args), now = Date.now, loadCookie = null }) {
    if (!/^[a-z0-9_]+$/i.test(subreddit)) throw new Error('Invalid subreddit.');
    this.subreddit = subreddit;
    this.cookieFile = resolve(cookieFile);
    this.userAgent = userAgent;
    this.getState = getState;
    this.saveState = saveState;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.loadCookie = loadCookie || (() => readFile(this.cookieFile, 'utf8'));
  }
  state() {
    const state = this.getState?.();
    return state?.subreddit === this.subreddit ? structuredClone(state) : { subreddit: this.subreddit, queue: [], known: {}, lastDiscoveryAt: 0, lastRequestAt: 0 };
  }
  async checkSession() {
    try { return validateSessionCookie(await this.loadCookie()); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Reddit session file is missing. Run npm run reddit:session-check.');
      throw error;
    }
  }
  async readHtml(path, transport = {}) {
    const requestOrigin = transport.origin || origin;
    const url = new URL(path, requestOrigin);
    if (url.origin !== requestOrigin || !url.pathname.toLowerCase().startsWith(`/r/${this.subreddit.toLowerCase()}/`)) throw new Error('Refused a URL outside the configured Reddit community.');
    const cookie = await this.checkSession(); // Re-read so session renewal requires no restart.
    const state = this.state();
    const now = this.now();
    const remaining = (state.lastRequestAt || 0) + HTML_REQUEST_INTERVAL_MS - now;
    if (remaining > 0) {
      const error = new Error('Preserving the Reddit request interval.');
      error.retryAfterMs = remaining;
      throw error;
    }
    // Persist before sending, including failed requests, to preserve spacing on restart.
    state.lastRequestAt = now;
    state.lastRequestKind = /\/new(?:\/|\.json)$/.test(url.pathname) ? 'discovery' : 'detail';
    await this.saveState(state);
    const response = await this.fetchImpl(url, {
      headers: { accept: transport.accept || 'text/html', 'user-agent': this.userAgent, cookie },
      redirect: 'manual', signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) {
      const error = new Error(response.status >= 300 && response.status < 400 ? 'Reddit redirected the saved session. Renew it with npm run reddit:session-check -- --renew.' : `Reddit request failed: HTTP ${response.status}.`);
      if ([401, 403].includes(response.status)) error.message += ' Reddit denied access. Renew the saved session with npm run reddit:session-check -- --renew; if access is still denied, check that Reddit opens in your signed-in browser.';
      error.message += ` (${state.lastRequestKind === 'discovery' ? 'new-post discovery' : 'post refresh'})`;
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) error.retryAfterMs = 15 * 60_000;
      throw error;
    }
    if (!(transport.contentType || /text\/html/i).test(response.headers.get('content-type') || '')) throw new Error('Reddit returned an unexpected response format. Check the saved session.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Reddit returned an empty response.');
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8_000_000) throw new Error('Reddit HTML exceeded the response size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
  }
  async fetchPosts(listings = []) {
    let state = this.state();
    const now = this.now();
    const queue = prepareQueue(state, now);
    if (JSON.stringify(queue) !== JSON.stringify(state.queue)) {
      state.queue = queue;
      await this.saveState(state);
    }
    const readyPost = state.queue.some((post) => !post.nextAttemptAt || post.nextAttemptAt <= now);
    // Even a long configured poll interval must leave a step for queued bodies.
    if (!state.lastDiscoveryAt || (now - state.lastDiscoveryAt >= FEED_INTERVAL_MS && (state.lastRequestKind !== 'discovery' || !readyPost))) {
      let posts;
      try { posts = parseOldRedditListing(await this.readHtml(`/r/${this.subreddit}/new/`), this.subreddit); }
      catch (error) { error.message += ' (new-posts page)'; if (error.needsAttention) error.retryAfterMs = 15 * 60_000; throw error; }
      state = this.state();
      const queued = new Set(state.queue.map((post) => post.id));
      const pending = new Map(state.queue.map((post) => [post.id, post]));
      for (const post of posts.filter((post) => /\[wts\]/i.test(post.title) && !state.known[post.id])) {
        // Promote any visible sale that was previously scheduled as an RSS refresh.
        pending.set(post.id, { ...pending.get(post.id), ...post, kind: 'new' });
        queued.add(post.id);
      }
      state.queue = [...pending.values()];
      const refresh = new Map(Object.values(state.known).filter((post) => post.active).map((post) => [post.id, post]));
      for (const listing of listings) {
        if (listing.status !== 'available' || listing.recordedAt < now - RETENTION_MS || !/^t3_[a-z0-9]+$/i.test(listing.postId)) continue;
        // Older RSS listings can be refreshed even before the HTML source has seen them.
        const url = new URL(listing.permalink, origin);
        if (!new RegExp(`^/r/${this.subreddit}/comments/${listing.postId.slice(3)}(?:/|$)`, 'i').test(url.pathname)) continue;
        if (!refresh.has(listing.postId)) refresh.set(listing.postId, { id: listing.postId, permalink: url.pathname, publishedAt: listing.recordedAt, checkedAt: 0, active: true });
      }
      for (const post of [...refresh.values()].sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0))) {
        if (!queued.has(post.id) && post.publishedAt >= now - RETENTION_MS && now - (post.checkedAt || 0) >= REFRESH_INTERVAL_MS) { state.queue.push({ ...post, kind: 'refresh' }); queued.add(post.id); }
      }
      state.known = Object.fromEntries(Object.entries(state.known).filter(([, post]) => post.publishedAt >= now - RETENTION_MS));
      state.queue = prepareQueue(state, now);
      state.lastDiscoveryAt = now;
      state.lastSuccessfulReadAt = this.now();
      state.discoveryPostCount = posts.length;
      await this.saveState(state);
      return [];
    }
    const target = state.queue.find((post) => !post.nextAttemptAt || post.nextAttemptAt <= now);
    if (!target) return [];
    const html = await this.readHtml(target.permalink);
    try { return [parseOldRedditPost(html, this.subreddit, target.id)]; }
    catch (error) {
      error.message += ` (post ${target.id})`;
      if (error.needsAttention) { error.retryAfterMs = 15 * 60_000; throw error; }
      // Keep an unreadable post for a later retry without blocking other sales.
      state = this.state();
      state.queue = state.queue.filter((post) => post.id !== target.id);
      state.queue.push({ ...target, nextAttemptAt: now + REFRESH_INTERVAL_MS });
      await this.saveState(state);
      throw error;
    }
  }
  async acknowledgePost(post, active) {
    const state = this.state();
    state.known[post.id] = { id: post.id, permalink: post.permalink, publishedAt: post.publishedAt, checkedAt: this.now(), active };
    state.lastSuccessfulReadAt = this.now();
    state.queue = state.queue.filter((target) => target.id !== post.id);
    await this.saveState(state);
  }
}
