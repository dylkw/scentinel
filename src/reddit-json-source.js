import { RedditHtmlSource } from './reddit-html-source.js';

const RETENTION_MS = 30 * 86400_000;
const REFRESH_MS = 30 * 60_000;

export function parseRedditJson(payload, subreddit, expectedId = null) {
  const listing = Array.isArray(payload) ? payload[0] : payload;
  if (listing?.kind !== 'Listing' || !Array.isArray(listing.data?.children)) throw new Error('Reddit returned an invalid JSON listing.');
  const posts = listing.data.children.filter((child) => child.kind === 't3').map(({ data }) => {
    if (!data || !/^t3_[a-z0-9]+$/i.test(data.name) || data.name !== `t3_${data.id}` || data.subreddit?.toLowerCase() !== subreddit.toLowerCase() || typeof data.title !== 'string' || typeof data.selftext !== 'string' || !Number.isFinite(data.created_utc) || data.created_utc <= 0) throw new Error('Reddit JSON post is missing required fields.');
    const url = new URL(data.permalink, 'https://www.reddit.com');
    if (url.origin !== 'https://www.reddit.com' || !new RegExp(`^/r/${subreddit}/comments/${data.id}(?:/|$)`, 'i').test(url.pathname)) throw new Error('Reddit JSON post has an invalid permalink.');
    return { id: data.name, title: data.title, selftext: data.selftext, permalink: url.pathname, publishedAt: data.created_utc * 1000, unavailable: Boolean(data.removed_by_category) || /^\s*\[(?:removed|deleted)\]\s*$/i.test(data.selftext) || /\bsold\b/i.test(data.link_flair_text || '') };
  });
  if (!posts.length || (expectedId && (posts.length !== 1 || posts[0].id !== expectedId))) throw new Error('Reddit JSON did not return the expected posts.');
  return posts;
}

// Reuse the saved session, bounded transport, durable request spacing and acknowledgments.
// The shared checkpoint also preserves request spacing when switching back to HTML.
export class RedditJsonSource extends RedditHtmlSource {
  async readPosts(path, expectedId = null) {
    const body = await this.readHtml(path, { origin: 'https://www.reddit.com', accept: 'application/json, text/plain, */*', contentType: /application\/json/i });
    return parseRedditJson(JSON.parse(body), this.subreddit, expectedId);
  }
  async fetchPosts(listings = []) {
    let state = this.state();
    const now = this.now();
    const candidates = new Map(Object.values(state.known).filter((post) => post.active).map((post) => [post.id, post]));
    for (const listing of listings) {
      if (listing.status !== 'available' || listing.recordedAt < now - RETENTION_MS || !/^t3_[a-z0-9]+$/i.test(listing.postId)) continue;
      if (!candidates.has(listing.postId)) candidates.set(listing.postId, { id: listing.postId, publishedAt: listing.recordedAt, checkedAt: 0 });
    }
    const target = [...candidates.values()].filter((post) => post.publishedAt >= now - RETENTION_MS && now - (post.checkedAt || 0) >= REFRESH_MS).sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0) || b.publishedAt - a.publishedAt)[0];
    // Alternate discovery and old-post refreshes while a refresh backlog exists.
    // With no backlog every request returns a complete batch of the newest 25 posts.
    // A failed discovery must be retried, rather than hidden by a successful
    // old-post refresh on the next poll. Only alternate after a parsed response.
    const discovery = state.transport !== 'json' || state.lastSuccessfulRequestKind !== 'discovery' || !target;
    const posts = await this.readPosts(discovery ? `/r/${this.subreddit}/new.json?limit=25&raw_json=1` : `/r/${this.subreddit}/comments/${target.id.slice(3)}.json?limit=1&raw_json=1`, discovery ? null : target.id);
    state = this.state();
    state.transport = 'json';
    state.queue = [];
    state.known = Object.fromEntries(Object.entries(state.known).filter(([, post]) => post.publishedAt >= now - RETENTION_MS));
    state.lastSuccessfulReadAt = this.now();
    state.lastSuccessfulRequestKind = discovery ? 'discovery' : 'detail';
    if (discovery) { state.lastDiscoveryAt = now; state.discoveryPostCount = posts.length; }
    await this.saveState(state);
    return posts;
  }
}
