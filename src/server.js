import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { dealFor, isDecantListing, searchListings, fold, formatUsd, normalize, parseWatch, valuationFor, watchMatches } from './domain.js';
import { Store } from './store.js';
import { RedditHtmlSource } from './reddit-html-source.js';
import { RedditJsonSource } from './reddit-json-source.js';
import { acquireInstanceLock } from './instance-lock.js';
import { createTelegramApi, TelegramUpdateRetry } from './telegram.js';
import { createCatalog } from './catalog.js';
import { redditHealth } from './health.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const subreddit = process.env.SUBREDDIT || 'fragranceswap';
const root = process.cwd();
const catalogFile = join(root, 'data', 'fra_cleaned.csv');
const store = new Store(process.env.STORE_FILE || join(root, 'data', 'store.json'));
export const redditPollInterval = (value) => Math.max(Number(value) || 90_000, 90_000);
const intervalMs = redditPollInterval(process.env.POLL_INTERVAL_MS);
const redditSource = process.env.REDDIT_SOURCE || 'rss';
const sessionSource = ['html', 'json'].includes(redditSource) ? new (redditSource === 'json' ? RedditJsonSource : RedditHtmlSource)({
  subreddit,
  cookieFile: process.env.REDDIT_HTML_COOKIE_FILE || 'data/reddit-session.txt',
  userAgent: process.env.REDDIT_USER_AGENT || 'node:scentinel:v0.1.0 (fragrance listing monitor)',
  getState: () => store.data.redditHtml,
  saveState: (state) => store.transact((data) => { data.redditHtml = state; }),
}) : null;
const feed = process.env.REDDIT_RSS_URL || `https://www.reddit.com/r/${subreddit}/new/.rss`;
const redditRssUser = process.env.REDDIT_RSS_USER;
const redditRssToken = process.env.REDDIT_RSS_TOKEN;
const redditUserAgent = process.env.REDDIT_USER_AGENT || 'node:scentinel:v0.1.0 (RSS monitor)';
const redditRequestSpacingMs = 90_000;
const port = Number(process.env.PORT || 0);


const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const decodeXml = (value) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => entity[0] !== '#' ? ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] || _) : String.fromCodePoint(entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)));
const tag = (xml, name) => decodeXml((new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml) || [, ''])[1]).replace(/<\/?(?:p|div|br|li|tr|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '\n').replace(/<\/?(?:del|s|strike)(?:\s[^>]*)?>/gi, '~~').replace(/<[^>]+>/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
const atomPosts = (atom) => [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => { const entry = match[1]; const url = /<link[^>]+href="([^"]+)"/i.exec(entry)?.[1] || ''; return { id: tag(entry, 'id') || url, title: tag(entry, 'title'), selftext: tag(entry, 'content'), permalink: url.replace('https://www.reddit.com', ''), publishedAt: Date.parse(tag(entry, 'published') || tag(entry, 'updated')) || Date.now() }; }).filter((post) => post.id && post.permalink);
const redditCookies = new Map();
let nextRedditRequestAt = 0;
function validateRedditConfiguration() {
  if (!['rss', 'html', 'json'].includes(redditSource)) throw new Error('REDDIT_SOURCE must be json, html or rss.');
  if (sessionSource) return;
  if (Boolean(redditRssUser) !== Boolean(redditRssToken)) throw new Error('Private Reddit RSS configuration is incomplete. Set REDDIT_RSS_USER and REDDIT_RSS_TOKEN together.');
}
function redditResponseError(response, retryAfterMs = 0) {
  const error = new Error(`Reddit RSS request failed: ${response.status}`);
  error.status = response.status;
  error.retryAfter = response.headers.get('retry-after');
  error.retryAfterMs = retryAfterMs;
  return error;
}
const isRedditUrl = (url) => url.hostname === 'reddit.com' || url.hostname.endsWith('.reddit.com');
function redditFeedUrl() {
  const url = new URL(feed);
  if (redditRssUser && redditRssToken) {
    if (!isRedditUrl(url)) throw new Error('Private Reddit RSS credentials can only be sent to a reddit.com feed URL.');
    url.searchParams.set('user', redditRssUser);
    url.searchParams.set('feed', redditRssToken);
  }
  return url;
}
function rememberRedditCookies(headers) {
  const values = headers.getSetCookie?.() || (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) redditCookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}
async function rateLimitedRedditFetch(url, options) {
  const delay = nextRedditRequestAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  nextRedditRequestAt = Date.now() + redditRequestSpacingMs;
  return fetchWithTimeout(url, options);
}
async function fetchRedditPosts() {
  validateRedditConfiguration();
  if (sessionSource) return sessionSource.fetchPosts(Object.values(store.data.listings));
  let url = redditFeedUrl();
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headers = { accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.1', 'user-agent': redditUserAgent };
    if (isRedditUrl(url) && redditCookies.size) headers.cookie = [...redditCookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await rateLimitedRedditFetch(url, { headers, redirect: 'manual' });
    if (isRedditUrl(url)) rememberRedditCookies(response.headers);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Reddit RSS redirect did not include a location.');
      const redirectedUrl = new URL(location, url);
      if (redditRssToken && !isRedditUrl(redirectedUrl)) throw new Error('Reddit RSS refused to forward private feed credentials outside reddit.com.');
      url = redirectedUrl;
      continue;
    }
    if (!response.ok) {
      const error = redditResponseError(response, response.status === 403 ? 15 * 60_000 : 0);
      if (response.status === 403 && !redditRssToken) error.message += '; set REDDIT_RSS_USER and REDDIT_RSS_TOKEN from a private Reddit RSS feed';
      else if (response.status === 403) error.message += '; private RSS credentials were sent, so Reddit is blocking or throttling this connection';
      throw error;
    }
    return atomPosts(await response.text());
  }
  throw new Error('Reddit RSS request exceeded the redirect limit.');
}

const phrasePattern = (phrase) => new RegExp(`(^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?= |$)`);
async function loadCatalog() {
  if (!existsSync(catalogFile)) throw new Error('Missing data/fra_cleaned.csv fragrance catalog.');
  const [, ...rows] = (await readFile(catalogFile, 'utf8')).trim().split(/\r?\n/);
  return { count: rows.length, ...createCatalog(rows.map((row) => { const columns = row.split(';'); return { product: columns[1], brand: columns[2] }; })) };
}
const catalog = await loadCatalog();

const fetchWithTimeout = (url, options = {}, ms = 20_000) => fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
const api = createTelegramApi(token, fetchWithTimeout);
const send = (chatId, text, options = {}) => api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...options });
const mainMenu = { inline_keyboard: [[{ text: '✨ Today’s deals', callback_data: 'm:deals' }, { text: '🔔 My watches', callback_data: 'm:list' }], [{ text: '➕ Create a watch', callback_data: 'm:add' }, { text: '❔ Help', callback_data: 'm:help' }]] };
const menuOptions = (options = {}) => ({ ...options, reply_markup: options.reply_markup || mainMenu });
const sendResult = (chatId, result) => send(chatId, result.text || result, menuOptions(result.options));
const helpText = '<b>HOW SCENTINEL WORKS</b>\n\nI alert you when a listing matches your fragrance and optional price, size, or fill requirements.\n\n<b>Quick start</b>\n<code>/add aventus absolu under $180 min 90ml</code>\n\n<b>Aliases</b>\n<code>/alias blue ridge = south slope</code>\nTreats both names as one watch.\n\n<b>Commands</b>\n/add — create a watch\n/list — view watches\n/alias — add an alternate name\n/unalias — remove an alternate name\n/find — newest listings\n/stats — market value\n/deals — best opportunities\n/stop — remove every watch';

const noise = /\b(?:wts|price|shipped|shipping|obo|f&f|g&s|paypal|sold|available|bottle|full presentation|retail|conus|usa|partial|tester|bnib|nib|sealed|sprayed|remaining|fill|level|see pics?|photos?|lot|bundle)\b/gi;
function listingFromLine(post, line, index) {
  const price = /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/.exec(line); if (!price) return null;
  const cents = Math.round(Number(price[1].replaceAll(',', '')) * 100); if (cents < 500 || cents > 500000) return null;
  // Multiple independent prices on one row cannot be assigned safely.
  if ([...line.matchAll(/\$\s?\d/g)].length > 1) return null;
  const size = /(\d+(?:\.\d+)?)\s*(ml|oz)\b/i.exec(line); let sizeMl = size ? Math.round(Number(size[1]) * (size[2].toLowerCase() === 'oz' ? 29.5735 : 1)) : null;
  const fill = /(?:^|\s)(\d{1,3})\s*%/.exec(line); let fillPct = fill ? Math.min(Number(fill[1]), 100) : /\b(?:full|sealed|bnib|nib)\b/i.test(line) ? 100 : null;
  const fraction = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*ml\b/i.exec(line);
  if (fraction && Number(fraction[2]) > 0 && Number(fraction[1]) <= Number(fraction[2])) { sizeMl = Number(fraction[2]); fillPct = Number(fraction[1]) / sizeMl * 100; }
  // Preserve Markdown link labels and variant words, but exclude link URLs and
  // structured sale details from the name used for alerts and watch matching.
  const cleanName = (text) => normalize(text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/gi, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+\]|\$\s?\d{1,5}(?:,\d{3})*(?:\.\d{2})?|\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\s*ml\b|\b\d+(?:\.\d+)?\s*(?:ml|oz)\b|\b\d{1,3}\s*%/gi, ' ').replace(noise, ' ').replace(/[|•·—–_*~-]+/g, ' '));
  // Text after a named item's price can contain unrelated trade requests.
  // Price-first rows use their following text only when no name precedes it.
  const beforePrice = cleanName(line.slice(0, price.index));
  const name = /[a-z]/.test(fold(beforePrice)) ? beforePrice : cleanName(line.slice(price.index + price[0].length));
  const matched = catalog.match(name); const fragrance = matched?.key || name; if (fold(name).length < 3) return null;
  const effectiveMl = sizeMl && fillPct != null ? sizeMl * fillPct / 100 : sizeMl;
  return { id: `${post.id}:${index}`, postId: post.id, permalink: `https://www.reddit.com${post.permalink}`, name, fragrance, brand: matched?.brand || null, cents, sizeMl, fillPct, effectiveMl, normalizedCentsPerMl: effectiveMl ? Math.round(cents / effectiveMl) : null, isDecant: /\b(?:decants?|samples?|splits?)\b/i.test(`${post.title} ${line}`), condition: /\b(?:sealed|bnib|nib)\b/i.test(line) ? 'sealed' : /\btester\b/i.test(line) ? 'tester' : fillPct && fillPct < 100 ? 'partial' : 'unknown', status: (/\b(?:sold|gone)\b/i.test(line) || /~~[^~]*\$[^~]*~~/.test(line)) ? 'sold' : 'available', raw: line, recordedAt: post.publishedAt, firstSeenAt: Date.now(), seller: null };
}
function listingsFromPost(post) { return `${post.title}\n${post.selftext}`.split(/\n+/).flatMap((line, index) => { const listing = listingFromLine(post, line.trim(), index); return listing ? [listing] : []; }); }
const listingLabel = (listing) => `${listing.sizeMl ? `${listing.sizeMl}ml` : 'size unknown'}${listing.fillPct ? ` · ${listing.fillPct}% full` : ''}${listing.normalizedCentsPerMl ? ` · ${formatUsd(listing.normalizedCentsPerMl)}/ml` : ''}`;
const alertText = (listing, watch) => `<a href="${escapeHtml(listing.permalink)}">${escapeHtml(watch.displayName || watch.query)}</a>\nPrice: ${formatUsd(listing.cents)}\nVolume: ${listing.sizeMl ? `${listing.sizeMl} ml` : 'unknown'}\nFilled: ${listing.fillPct == null ? 'unknown' : `${listing.fillPct}%`}`;
const containsPhrase = (text, phrase) => phrasePattern(phrase).test(fold(text));
const listingIsDisplayable = (listing) => {
  if (listing.name != null) return /[a-z]/.test(fold(listing.name));
  const name = fold(listing.fragrance);
  if (!/[a-z]/.test(name)) return false;
  if (!listing.brand) return true;
  const brand = fold(listing.brand);
  const product = name.startsWith(`${brand} `) ? name.slice(brand.length + 1) : name;
  const words = new Set(fold(listing.raw || '').split(' '));
  return product.split(' ').every((word) => words.has(word));
};

function statsFor(query) { const fragrance = catalog.match(query)?.key || normalize(query); const market = valuationFor(store.listingsFor(fragrance)); if (!market.medianCentsPerMl) return `Not enough comparable active listings for “${escapeHtml(fragrance)}” yet (${market.sampleSize}/5).`; return `<b>${escapeHtml(fragrance.toUpperCase())}</b>\n\n30-day normalized market\n${market.sampleSize} comparable listings · ${market.confidence} confidence\nMedian: <b>${formatUsd(market.medianCentsPerMl)}/ml</b>\nTypical range: ${formatUsd(market.lowCentsPerMl)}–${formatUsd(market.highCentsPerMl)}/ml`; }
export function dealsForToday() {
  const now = Date.now();
  const candidates = Object.values(store.data.listings).filter(listingIsDisplayable);
  const top = candidates.filter((listing) => listing.status === 'available' && !isDecantListing(listing) && listing.recordedAt >= now - 86400000 && listing.recordedAt <= now)
    .map((listing) => ({ listing, deal: dealFor(listing, candidates, now) }))
    .filter(({ deal }) => deal).sort((a, b) => b.deal.discount - a.deal.discount).slice(0, 10);
  if (!top.length) return 'No bottle deals at least 5% below the 30-day median in the last 24 hours. Each deal needs five comparable listings; decants are excluded.';
  return { text: `<b>TOP ${top.length} BOTTLE DEALS · LAST 24 HOURS</b>\n\n${top.map(({ listing, deal }, i) => `${i + 1}. <a href="${escapeHtml(listing.permalink)}">${escapeHtml(listing.fragrance.toUpperCase())}</a> <b>${formatUsd(listing.cents)}</b>\n${listingLabel(listing)}\n${deal.discount}% below median · ${deal.sampleSize} comps · ${deal.confidence} confidence`).join('\n\n')}`, options: { parse_mode: 'HTML' } };
}
export function findPosts(query) {
  if (fold(query).length < 2 || query.length > 80) return 'Use /find followed by a fragrance or brand name between 2 and 80 characters.';
  const matches = searchListings(Object.values(store.data.listings).filter(listingIsDisplayable), query);
  const listings = matches.slice(0, 5);
  if (!listings.length) return `No active indexed listings for “${query}” in the last 30 days. Try fewer words or a brand name. Only posts seen by this monitor are searchable.`;
  return { text: `<b>NEWEST LISTINGS · ${escapeHtml(query.toUpperCase())}</b>\nShowing ${listings.length} of ${matches.length} matches from the last 30 days.\n\n${listings.map((listing, i) => `${i + 1}. <a href="${escapeHtml(listing.permalink)}">${escapeHtml(listing.fragrance)}</a> · <b>${formatUsd(listing.cents)}</b>\n${listingLabel(listing)}${isDecantListing(listing) ? ' · decant/sample' : ''}`).join('\n\n')}`, options: { parse_mode: 'HTML' } };
}
const watchDescription = (watch) => `${watch.query}${watch.aliases?.length ? ` (also: ${watch.aliases.join(', ')})` : ''}${watch.maxCents ? ` · under ${formatUsd(watch.maxCents)}` : ''}${watch.minMl ? ` · ${watch.minMl}ml+` : ''}${watch.minFillPct ? ` · ${watch.minFillPct}%+` : ''}${watch.includeDecants ? ' · decants' : ''}`;
function watchesCard(chatId) { const watches = store.watches(chatId); if (!watches.length) return { text: '<b>YOUR WATCHES</b>\n\nNo watches yet. Create one with a fragrance and an optional price target.', options: { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ Create a watch', callback_data: 'm:add' }], [{ text: '✨ Browse today’s deals', callback_data: 'm:deals' }]] } } }; return { text: `<b>YOUR WATCHES · ${watches.length}</b>\n\n${watches.map((watch, index) => `${index + 1}. ${escapeHtml(watchDescription(watch))}`).join('\n')}\n\n<i>To remove a watch: <code>/remove fragrance name</code></i>`, options: { parse_mode: 'HTML' } }; }
const addCard = () => ({ text: '<b>CREATE A WATCH</b>\n\nSend a fragrance after <code>/add</code>. Add any filters you care about:\n\n<code>/add aventus absolu under $180 min 90ml min 85%</code>\n\nI’ll only notify you when all supplied conditions match. Use <code>include decants</code> to opt in to decants.', options: { parse_mode: 'HTML' } });

export async function command(chatId, input) {
  const raw = input.trim().replace(/^\/(\w+)(?:@\w+)?/, '$1'); const lower = raw.toLowerCase();
  if (lower === 'start') return { text: '<b>WELCOME TO SILLAGE</b>\n\nYour fragrance market desk for r/fragranceswap. I watch new listings, evaluate price per ml, and send the opportunities that match your rules.\n\nStart with a watch or explore today’s market.', options: { parse_mode: 'HTML' } };
  if (lower === 'help' || !raw) return { text: helpText, options: { parse_mode: 'HTML' } };
  if (lower === 'find') return 'Use /find followed by a fragrance or brand name, for example: /find absolu aventus';
  if (lower === 'stats') return 'Use /stats followed by a fragrance name, for example: /stats aventus';
  if (lower === 'add') return addCard();
  if (lower === 'list') return watchesCard(chatId);
  if (lower === 'stop') { await store.stop(chatId); return { text: '<b>WATCHES CLEARED</b>\n\nYou will not receive any more alerts until you create a new watch.', options: { parse_mode: 'HTML' } }; }
  if (lower === 'deals') return dealsForToday();
  const stats = /^stats\s+(.+)$/i.exec(raw); if (stats) return { text: statsFor(stats[1]), options: { parse_mode: 'HTML' } };
  const find = /^find\s+(.+)$/i.exec(raw); if (find) return findPosts(find[1]);
  const aliasMatch = /^(alias|unalias)\s+(.+?)\s*=\s*(.+)$/i.exec(raw); if (aliasMatch) { const query = normalize(aliasMatch[2]); const alias = normalize(aliasMatch[3]); if (query.length < 2 || alias.length < 2 || query.length > 80 || alias.length > 80) return { text: '<b>CHECK THE ALIAS FORMAT</b>\n\nUse: <code>/alias blue ridge = south slope</code>', options: { parse_mode: 'HTML' } }; const outcome = aliasMatch[1].toLowerCase() === 'alias' ? await store.addAlias(chatId, query, alias) : await store.removeAlias(chatId, query, alias); const messages = { added: `<b>ALIAS ADDED</b>\n\n${escapeHtml(alias)} will now match your ${escapeHtml(query)} watch.`, exists: `<b>ALIAS ALREADY ACTIVE</b>\n\n${escapeHtml(alias)} already belongs to ${escapeHtml(query)}.`, 'in-use': `<b>ALIAS ALREADY IN USE</b>\n\n${escapeHtml(alias)} belongs to another watch. Remove or consolidate that watch first.`, removed: `<b>ALIAS REMOVED</b>\n\n${escapeHtml(alias)} will no longer match ${escapeHtml(query)}.`, absent: `<b>ALIAS NOT FOUND</b>\n\n${escapeHtml(alias)} is not an alias for ${escapeHtml(query)}.`, missing: `<b>WATCH NOT FOUND</b>\n\nCreate ${escapeHtml(query)} first with <code>/add ${escapeHtml(query)}</code>.` }; return { text: messages[outcome], options: { parse_mode: 'HTML' } }; }
  const match = /^(add|remove|delete)\s+(.+)$/i.exec(raw); if (!match) return { text: `<b>I DIDN’T CATCH THAT</b>\n\n${helpText}`, options: { parse_mode: 'HTML' } };
  if (match[1].toLowerCase() === 'add') { try { const watch = parseWatch(match[2], catalog); return await store.addWatch(chatId, watch) ? { text: `<b>WATCH CREATED</b>\n\n🔔 ${escapeHtml(watchDescription(watch))}\n\nI’ll message you as soon as a matching sale is indexed.`, options: { parse_mode: 'HTML' } } : { text: `<b>ALREADY WATCHING</b>\n\n🔔 ${escapeHtml(watchDescription(watch))}`, options: { parse_mode: 'HTML' } }; } catch (error) { return { text: `<b>CHECK THE WATCH FORMAT</b>\n\n${escapeHtml(error.message)}\n\nTry: <code>/add aventus under $180 min 90ml</code>`, options: { parse_mode: 'HTML' } }; } }
  const query = normalize(match[2]); return await store.removeWatch(chatId, query) ? { text: `<b>WATCH REMOVED</b>\n\n${escapeHtml(query)} will no longer trigger alerts.`, options: { parse_mode: 'HTML' } } : { text: `<b>NO MATCHING WATCH</b>\n\nYou are not watching ${escapeHtml(query)}.`, options: { parse_mode: 'HTML' } };
}

let polling = false;
let nextRedditPollAt = 0;
let redditBackoffMs = 0;
let redditPollSucceeded = false;
let redditPollFailed = false;
export async function pollReddit() {
  if (polling || Date.now() < nextRedditPollAt) return; polling = true;
  try { const posts = await fetchRedditPosts(); redditBackoffMs = 0; nextRedditPollAt = 0; let alerts = 0;
    if (!redditPollSucceeded || redditPollFailed) {
      const detail = sessionSource && !posts.length ? `found ${store.data.redditHtml?.discoveryPostCount || 0} feed posts; ${store.data.redditHtml?.queue.length || 0} queued` : `received ${posts.length} complete post${posts.length === 1 ? '' : 's'}`;
      console.log(`Reddit ${redditSource} poll succeeded; ${detail}.`);
    }
    redditPollSucceeded = true; redditPollFailed = false;
    for (const post of posts) {
      if (sessionSource) {
        const listings = post.unavailable || !/\[wts\]/i.test(post.title) ? [] : listingsFromPost(post);
        await store.replacePostListings(post.id, listings);
        await sessionSource.acknowledgePost(post, listings.some((listing) => listing.status === 'available'));
      } else if (/\[wts\]/i.test(post.title)) await store.upsertListings(listingsFromPost(post));
    }
    // Retry undelivered alerts even when the listing has not changed or left the feed.
    for (const listing of Object.values(store.data.listings)) {
      if (listing.status !== 'available' || listing.recordedAt < Date.now() - 30 * 86400000 || !listingIsDisplayable(listing)) continue;
      for (const [chatId, watches] of Object.entries(store.data.subscriptions)) {
        const matching = watches.filter((watch) => listing.recordedAt >= watch.createdAt && watchMatches(watch, listing));
        const key = `${listing.id}:${chatId}`;
        if (!matching.length || store.notified(key) || matching.some((watch) => store.notified(`${listing.id}:${chatId}:${watch.id}`))) continue;
        try {
          const result = await send(chatId, alertText(listing, matching[0]), { parse_mode: 'HTML' });
          await store.markNotified(key, result.message_id);
          alerts++;
        } catch (error) {
          console.error(`Alert delivery failed: ${error.message}`);
        }
      }
    }
    await store.pollResult(true); if (alerts) console.log(`Sent ${alerts} alert${alerts === 1 ? '' : 's'}.`);
  } catch (error) { redditPollFailed = true; await store.pollResult(false); const serverDelay = error.status === 429 ? Number(error.retryAfter) * 1000 : 0; const rateLimited = error.status === 403 || error.status === 429; redditBackoffMs = rateLimited ? Math.min(Math.max(serverDelay, redditBackoffMs * 2, 15 * 60_000), 6 * 60 * 60_000) : Math.min(Math.max(Number(error.retryAfterMs) || 0, redditBackoffMs * 2, 30_000), 15 * 60_000); nextRedditPollAt = Date.now() + redditBackoffMs; const reason = error.status === 429 ? 'rate limited' : error.message; console.error(`Reddit poll error: ${reason}; retrying in ${Math.ceil(redditBackoffMs / 1000)} seconds.`); } finally { polling = false; }
}
function startRedditPolling() {
  const lastPollAt = Math.max(Number(store.data.metrics.lastPollAt) || 0, sessionSource ? Number(store.data.redditHtml?.lastRequestAt) || 0 : 0);
  const initialDelay = Math.max(intervalMs - (Date.now() - lastPollAt), 0);
  const loop = async () => {
    await pollReddit();
    setTimeout(loop, Math.max(intervalMs, nextRedditPollAt - Date.now()));
  };
  if (initialDelay) console.log(`Reddit polling resumes in ${Math.ceil(initialDelay / 1000)} seconds to preserve the configured interval.`);
  setTimeout(loop, initialDelay);
}
async function callback(callback) { const chatId = String(callback.message?.chat.id || ''); let result; if (callback.data === 'm:deals') result = dealsForToday(); else if (callback.data === 'm:list') result = watchesCard(chatId); else if (callback.data === 'm:add') result = addCard(); else if (callback.data === 'm:help') result = { text: helpText, options: { parse_mode: 'HTML' } }; else if (callback.data?.startsWith('w:')) result = await store.removeWatchById(chatId, callback.data.slice(2)) ? { text: '<b>WATCH REMOVED</b>\n\nYou will no longer receive alerts for that watch.', options: { parse_mode: 'HTML' } } : { text: 'That watch is no longer active.', options: { parse_mode: 'HTML' } }; else if (callback.data?.startsWith('s:')) result = { text: statsFor(callback.data.slice(2)), options: { parse_mode: 'HTML' } }; else return; await api('answerCallbackQuery', { callback_query_id: callback.id }); await sendResult(chatId, result); }
const telegramUpdateRetry = new TelegramUpdateRetry();
async function readUpdates() {
  let retryDelay = 500;
  try {
    const startedAt = Date.now();
    const updates = await api('getUpdates', { offset: store.data.botOffset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
    telegramUpdateRetry.success(Date.now() - startedAt);
    for (const update of updates) {
      if (update.message?.text) await sendResult(String(update.message.chat.id), await command(String(update.message.chat.id), update.message.text));
      if (update.callback_query) await callback(update.callback_query);
      await store.updateOffset(update.update_id + 1);
    }
  } catch (error) {
    const retry = telegramUpdateRetry.failure(error);
    retryDelay = retry.delay;
    if (retry.log) {
      console.error(`Telegram update error: ${error.message}; retrying in ${Math.ceil(retryDelay / 1000)} seconds.${retry.conflict ? ' Stop any other worker using this bot token, including workers on other computers.' : ''}`);
    }
  }
  setTimeout(readUpdates, retryDelay);
}
async function configureTelegram() { await api('setMyCommands', { commands: [{ command: 'add', description: 'Create an alert watch' }, { command: 'list', description: 'View your watches' }, { command: 'alias', description: 'Add an alternate watch name' }, { command: 'unalias', description: 'Remove an alternate name' }, { command: 'deals', description: 'Today’s best deals' }, { command: 'find', description: 'Find recent listings' }, { command: 'stats', description: 'Check market pricing' }, { command: 'stop', description: 'Remove all watches' }, { command: 'help', description: 'How Scentinel works' }] }); }
const dashboardPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sillage Market Desk</title><style>:root{--ink:#201914;--paper:#f4efe6;--orange:#ca542a;--muted:#76695e}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 82% 5%,#e8c19c,transparent 24rem),var(--paper);color:var(--ink);font:16px Georgia,serif}.wrap{max-width:1100px;margin:auto;padding:56px 28px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:23px}h1{font-size:clamp(3rem,9vw,7rem);letter-spacing:-.09em;line-height:.75;margin:0}header p{max-width:260px;color:var(--muted);margin:0}.eyebrow{font:600 11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--orange)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--ink);margin:42px 0}.stat{background:var(--paper);padding:20px}.stat b{display:block;font-size:2rem}.feed{border-top:1px solid #bcae9e}.row{display:grid;grid-template-columns:1.8fr 1fr 1fr 1fr;gap:16px;padding:18px 0;border-bottom:1px solid #bcae9e}.row a{color:var(--ink);font-weight:bold}.price{color:var(--orange);font-weight:bold}.meta{color:var(--muted);font:12px ui-monospace,monospace}.empty{padding:40px 0;color:var(--muted)}@media(max-width:640px){.wrap{padding:32px 18px}.stats{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}.row span:first-child{grid-column:1/-1}}</style><body><main class="wrap"><header><div><div class="eyebrow">Fragrance secondary market intelligence</div><h1>Sillage</h1></div><p>Active listings, normalized with condition and effective volume.</p></header><section class="stats"><div class="stat"><span class="eyebrow">Monitor state</span><b id="state">—</b></div><div class="stat"><span class="eyebrow">Indexed listings</span><b id="count">—</b></div><div class="stat"><span class="eyebrow">Alerts delivered</span><b id="alerts">—</b></div></section><div class="eyebrow">Newest active listings</div><section class="feed" id="feed"><div class="empty">Loading market tape…</div></section></main><script>const money=c=>'$'+(c/100).toLocaleString(),safe=v=>String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));Promise.all([fetch('/health').then(r=>r.json()),fetch('/api/listings').then(r=>r.json())]).then(([h,rows])=>{state.textContent=h.ok?'LIVE':'WAITING';count.textContent=rows.length;alerts.textContent=h.alertsSent||0;feed.innerHTML=rows.length?rows.map(x=>'<div class="row"><span><a href="'+safe(x.permalink)+'" target="_blank" rel="noreferrer">'+safe(x.fragrance).toUpperCase()+'</a><br><small class="meta">'+safe(x.condition||'unknown')+'</small></span><span class="price">'+money(x.cents)+'</span><span class="meta">'+(x.sizeMl?x.sizeMl+'ml':'size unknown')+(x.fillPct?' · '+x.fillPct+'%':'')+'</span><span class="meta">'+(x.normalizedCentsPerMl?money(x.normalizedCentsPerMl)+'/ml':'not normalized')+'</span></div>').join(''):'<div class="empty">No active listings have been indexed yet.</div>'})</script></body></html>`;
function startDashboard() { if (!port) return; createServer((request, response) => { const url = new URL(request.url, `http://${request.headers.host}`); const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }; if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return response.end(dashboardPage); } if (url.pathname === '/health') return json({ ...redditHealth({ source: redditSource, metrics: store.data.metrics, state: store.data.redditHtml, intervalMs }), catalogEntries: catalog.count }); if (url.pathname === '/api/listings') return json(Object.values(store.data.listings).filter((item) => item.status === 'available' && listingIsDisplayable(item)).sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 100)); if (url.pathname === '/api/market') { const fragrance = url.searchParams.get('fragrance'); return fragrance ? json({ fragrance, ...valuationFor(store.listingsFor(fragrance)) }) : json({ error: 'fragrance is required' }, 400); } response.writeHead(404); response.end('Not found'); }).listen(port, () => console.log(`Dashboard listening on :${port}`)); }

export { store, listingFromLine, listingsFromPost, atomPosts };
export const repairListingNames = (targetStore = store) => targetStore.migrateListingNames((listing) => listingFromLine({ id: listing.postId, title: '', permalink: '', publishedAt: listing.recordedAt }, listing.raw || '', 0));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and add your BotFather token.');
  validateRedditConfiguration();
  let releaseLock;
  try { releaseLock = acquireInstanceLock(store.file); }
  catch (error) { console.error(error.message); process.exit(1); }
  process.once('exit', releaseLock);
  const shutdown = () => { store.pending.finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await store.load();
  if (await repairListingNames()) console.log('Rebuilt stored listing names; watches and delivery history preserved.');
  if (sessionSource) await sessionSource.checkSession();
  console.log('Scentinel is running; catalog loaded and durable store ready.');
  console.log(`Reddit source: ${sessionSource ? `authenticated ${redditSource.toUpperCase()} (Terminal only)` : redditRssToken ? `private RSS for /u/${redditRssUser}` : 'public RSS (private feed credentials not loaded)'}.`);
  startDashboard();
  configureTelegram().catch((error) => console.error('Telegram command menu error:', error.message));
  readUpdates();
  startRedditPolling();
}
