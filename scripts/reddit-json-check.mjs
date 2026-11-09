import { RedditJsonSource } from '../src/reddit-json-source.js';
import { store, listingsFromPost } from '../src/server.js';
await store.load();
const source = new RedditJsonSource({
  subreddit: process.env.SUBREDDIT || 'fragranceswap',
  cookieFile: process.env.REDDIT_HTML_COOKIE_FILE || 'data/reddit-session.txt',
  userAgent: process.env.REDDIT_USER_AGENT || 'node:scentinel:v0.1.0 (fragrance listing monitor)',
  getState: () => store.data.redditHtml,
  saveState: (state) => store.transact((data) => { data.redditHtml = state; }),
});
const pause = async () => {
  const remaining = Math.max(0, (source.state().lastRequestAt || 0) + 90000 - Date.now());
  if (remaining) { console.log(`Waiting ${Math.ceil(remaining / 1000)} seconds to preserve request spacing.`); await new Promise((resolve) => setTimeout(resolve, remaining)); }
};
await pause();
const posts = await source.readPosts(`/r/${source.subreddit}/new.json?limit=25&raw_json=1`);
console.log(`Discovery passed: ${posts.length} complete posts, ${posts.reduce((sum, post) => sum + (post.unavailable ? 0 : listingsFromPost(post).length), 0)} parsed price rows.`);
const target = posts.find((post) => /\[wts\]/i.test(post.title) && !post.unavailable && listingsFromPost(post).length);
if (!target) throw new Error('No available sale with parsed prices found in the batch.');
await pause();
const [detail] = await source.readPosts(`/r/${source.subreddit}/comments/${target.id.slice(3)}.json?limit=1&raw_json=1`, target.id);
console.log(`Detail passed: ${detail.id}, ${detail.selftext.length} body characters, ${listingsFromPost(detail).length} price rows.`);
console.log('No listings were saved and no alerts were sent. Request timestamps were saved.');
