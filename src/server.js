import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const token = process.env.TELEGRAM_BOT_TOKEN;
const subreddit = 'fragranceswap';
const dataFile = join(process.cwd(), 'data', 'store.json');
const redditInterval = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const redditFeed = process.env.REDDIT_RSS_URL || `https://www.reddit.com/r/${subreddit}/new/.rss`;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required. Copy .env.example to .env and add your BotFather token.');

class Store {
  constructor() { this.data = { subscriptions: {}, notified: [], botOffset: 0 }; }
  async load() {
    await mkdir(join(process.cwd(), 'data'), { recursive: true });
    if (existsSync(dataFile)) this.data = JSON.parse(await readFile(dataFile, 'utf8'));
    this.data.subscriptions ||= {}; this.data.notified ||= []; this.data.botOffset ||= 0;
  }
  async save() { const temp = `${dataFile}.tmp`; await writeFile(temp, JSON.stringify(this.data, null, 2)); await rename(temp, dataFile); }
  phrases(chatId) { return this.data.subscriptions[chatId] || []; }
  async add(chatId, query) { const current = this.phrases(chatId); if (current.includes(query)) return false; this.data.subscriptions[chatId] = [...current, query]; await this.save(); return true; }
  async remove(chatId, query) { const current = this.phrases(chatId); const next = current.filter((item) => item !== query); if (!next.length) delete this.data.subscriptions[chatId]; else this.data.subscriptions[chatId] = next; await this.save(); return next.length !== current.length; }
  async stop(chatId) { delete this.data.subscriptions[chatId]; await this.save(); }
  seen(key) { return this.data.notified.includes(key); }
  async mark(key) { this.data.notified = [...this.data.notified, key].slice(-5000); await this.save(); }
}

const store = new Store();
const normalize = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const api = async (method, body = {}) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || response.status}`);
  return data.result;
};
const send = (chatId, text, options = {}) => api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...options });
const helpText = 'Available commands:\n\n/add <fragrance> — create an alert\n/list — see your alerts\n/remove <fragrance> — delete one alert\n/stop — remove all alerts\n/test — preview an alert\n/help — show this list';
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const decodeXml = (value) => value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (entity[0] !== '#') return named[entity.toLowerCase()] || _;
  return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10));
});
const tag = (xml, name) => decodeXml((new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml) || [, ''])[1])
  .replace(/<\/?(?:p|div|br|li|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\n[ \t]+/g, '\n');
const atomPosts = (atom) => [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => {
  const entry = match[1]; const link = /<link[^>]+href="([^"]+)"/i.exec(entry)?.[1] || '';
  return { id: tag(entry, 'id') || link, title: tag(entry, 'title'), selftext: tag(entry, 'content'), permalink: link.replace('https://www.reddit.com', '') };
}).filter((post) => post.id && post.permalink);
const priceFor = (post, query) => {
  const blocks = `${post.title}\n\n${post.selftext}`.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const phraseIndex = block.toLowerCase().indexOf(query);
    if (phraseIndex < 0) continue;
    const prices = [...block.matchAll(/\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/g)];
    if (!prices.length) continue;
    const closest = prices.reduce((best, candidate) => Math.abs((candidate.index ?? 0) - phraseIndex) < Math.abs((best.index ?? 0) - phraseIndex) ? candidate : best);
    return `$${closest[1]}`;
  }
  return null;
};

async function command(chatId, input) {
  const raw = input.trim().replace(/^\/(\w+)(?:@\w+)?/, '$1');
  const lower = raw.toLowerCase();
  if (lower === 'start') return 'Welcome to Sillage. I watch new r/fragranceswap posts and send links when your fragrance appears.\n\nTry /add aventus absolu\n\nCommands: /list, /remove <phrase>, /stop, /help';
  if (lower === 'help' || !raw) return helpText;
  if (lower === 'test') return { text: '🧪 <a href="https://www.reddit.com/r/fragranceswap/">AVENTUS ABSOLU</a> POSTED FOR <b>$180</b>', options: { parse_mode: 'HTML' } };
  if (lower === 'list') { const items = store.phrases(chatId); return items.length ? `Watching:\n${items.map((item) => `• ${item}`).join('\n')}` : 'No alerts yet. Try /add aventus absolu'; }
  if (lower === 'stop') { await store.stop(chatId); return 'All alerts removed. Send /add <fragrance> whenever you want to start again.'; }
  const match = /^(add|remove|delete)\s+(.+)$/i.exec(raw);
  if (!match) return `I did not recognize that command.\n\n${helpText}`;
  const query = normalize(match[2]);
  if (query.length < 2 || query.length > 80) return 'Use a fragrance phrase between 2 and 80 characters.';
  if (match[1].toLowerCase() === 'add') return await store.add(chatId, query) ? `Watching “${query}”. I will message you when it appears in r/fragranceswap.` : `Already watching “${query}”.`;
  return await store.remove(chatId, query) ? `Removed “${query}”.` : `You were not watching “${query}”.`;
}

async function readUpdates() {
  try {
    const updates = await api('getUpdates', { offset: store.data.botOffset, timeout: 25, allowed_updates: ['message'] });
    for (const update of updates) {
      store.data.botOffset = update.update_id + 1;
      const message = update.message;
      if (message?.text) { const result = await command(String(message.chat.id), message.text); await send(message.chat.id, result.text || result, result.options); }
    }
    if (updates.length) await store.save();
  } catch (error) { console.error('Telegram update error:', error.message); }
  setTimeout(readUpdates, 500);
}

async function pollReddit() {
  try {
    const response = await fetch(redditFeed, { headers: { accept: 'application/atom+xml', 'user-agent': 'SillageTelegramBot/0.1 (personal keyword monitor)' } });
    if (!response.ok) throw new Error(`Reddit RSS request failed: ${response.status}`);
    const posts = atomPosts(await response.text()); let alerts = 0;
    for (const post of posts) {
      const content = `${post.title}\n${post.selftext}`.toLowerCase();
      const normalizedTitle = post.title.toLowerCase();
      const isForSale = normalizedTitle.includes('[wts]') && !normalizedTitle.includes('decant');
      for (const [chatId, queries] of Object.entries(store.data.subscriptions)) for (const query of queries) {
        const key = `${post.id}:${chatId}:${query}`;
        if (isForSale && content.includes(query) && !store.seen(key)) {
          const price = priceFor(post, query);
          const link = `https://www.reddit.com${post.permalink}`;
          const priceText = price ? ` POSTED FOR <b>${escapeHtml(price)}</b>` : ' POSTED';
          await send(chatId, `🧪 <a href="${escapeHtml(link)}">${escapeHtml(query.toUpperCase())}</a>${priceText}`, { parse_mode: 'HTML' });
          await store.mark(key); alerts += 1;
        }
      }
    }
    if (alerts) console.log(`Sent ${alerts} alert${alerts === 1 ? '' : 's'}.`);
  } catch (error) { console.error('Reddit poll error:', error.message); }
}

await store.load();
console.log('Sillage Telegram monitor is running. Press Ctrl+C to stop.');
readUpdates();
pollReddit();
if (redditInterval > 0) setInterval(pollReddit, redditInterval);
