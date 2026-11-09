import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { RedditHtmlSource, validateSessionCookie, HTML_REQUEST_INTERVAL_MS } from '../src/reddit-html-source.js';
import { listingsFromPost } from '../src/server.js';

// A diagnostic only: no store imports, Telegram calls, or source activation.
const cookieFile = resolve(process.env.REDDIT_HTML_COOKIE_FILE || 'data/reddit-session.txt');
const subreddit = process.env.SUBREDDIT || 'fragranceswap';
if (!/^[a-z0-9_]+$/i.test(subreddit)) throw new Error('Invalid subreddit.');
let cookie;
try {
  if (process.argv.includes('--renew')) throw Object.assign(new Error('renew'), { code: 'ENOENT' });
  cookie = (await readFile(cookieFile, 'utf8')).trim();
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (!process.stdin.isTTY) throw new Error('Run this check in your own Terminal to enter a session.');
  console.log('In your normal Chrome session, open https://old.reddit.com/r/' + subreddit + '/new/.');
  console.log('If it shows listings, open DevTools → Network, reload, select the page request,');
  console.log('then copy the Cookie value under Request Headers. Do not paste it into chat.');
  process.stdout.write('Paste Cookie value here (hidden), then press Enter: ');
  const hidden = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output: hidden, terminal: true });
  try { cookie = (await input.question('')).trim(); } finally { input.close(); }
  process.stdout.write('\n');
}
cookie = validateSessionCookie(cookie);
await mkdir(dirname(cookieFile), { recursive: true });
await writeFile(cookieFile, cookie + '\n', { mode: 0o600 });
await chmod(cookieFile, 0o600);

// Exercise the production transport and queue using an in-memory checkpoint.
let state;
const source = new RedditHtmlSource({ subreddit, cookieFile, userAgent: process.env.REDDIT_USER_AGENT,
  getState: () => state, saveState: async (value) => { state = structuredClone(value); } });

try {
  await source.fetchPosts();
  console.log(`Discovery check passed: ${state.queue.length} sale posts queued over HTTP.`);
  if (!state.queue.length) throw new Error('No sale posts were available to verify the full-body read.');
  // Preview the newest sale first; production processes its queue oldest first.
  state.queue.sort((a, b) => b.publishedAt - a.publishedAt);
  // Space the two reads conservatively; this command is not a polling loop.
  console.log('Waiting 90 seconds before checking a complete post.');
  await new Promise((done) => setTimeout(done, HTML_REQUEST_INTERVAL_MS));
  const [post] = await source.fetchPosts();
  const listings = post.unavailable ? [] : listingsFromPost(post);
  console.log(`Detail check passed: ${post.id}, ${post.selftext.length} body characters, ${listings.length} parsed listings (${listings.filter((listing) => listing.status === 'available').length} active).`);
  if (!listings.length) throw new Error(post.unavailable ? 'This sale post is already sold or removed. Re-run the check to verify a current listing.' : 'No listings were parsed from this complete sale post. Inspect the parser before activating this source.');
  console.log('No listings were saved and no alerts were sent. Production HTML transport and listing parsing passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
