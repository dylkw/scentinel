// Reads ordinary Old Reddit HTML. No JSON endpoints, browser, or remote collector.
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ignoredTags = new Set(['script', 'style', 'template', 'noscript']);
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', hellip: '…', dollar: '$', percnt: '%' };
function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? original;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '�';
  });
}
function parse(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 8_000_000) throw new Error('Reddit HTML was missing or too large.');
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  let ignored = null;
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+|</gi)) {
    const token = match[0];
    if (ignored) { if (new RegExp(`^<\\/${ignored}\\s*>$`, 'i').test(token)) ignored = null; continue; }
    if (token.startsWith('<!')) continue;
    const closing = /^<\/([a-z][\w:-]*)/i.exec(token);
    if (closing) {
      const index = stack.findLastIndex((node) => node.tag === closing[1].toLowerCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const opening = /^<([a-z][\w:-]*)/i.exec(token);
    if (!opening) { stack.at(-1).children.push(decode(token)); continue; }
    const tag = opening[1].toLowerCase();
    if (ignoredTags.has(tag)) { ignored = tag; continue; }
    const attrs = {};
    const raw = token.slice(opening[0].length, -1);
    for (const attribute of raw.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = attribute[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!voidTags.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}
const hasClass = (node, value) => (node.attrs.class || '').split(/\s+/).includes(value);
function all(root, predicate, skipNestedPosts = false) {
  const result = [];
  function walk(node) {
    if (typeof node === 'string') return;
    if (predicate(node)) result.push(node);
    if (skipNestedPosts && node !== root && hasClass(node, 'thing')) return;
    for (const child of node.children) walk(child);
  }
  walk(root);
  return result;
}
function text(node, table = false) {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ');
  if (['button', 'input', 'textarea', 'select'].includes(node.tag)) return '';
  if (node.tag === 'br') return '\n';
  const withinTable = table || node.tag === 'table';
  const value = node.children.map((child) => text(child, withinTable)).join('');
  if (['del', 's', 'strike'].includes(node.tag)) return `~~${value}~~`;
  if (['td', 'th'].includes(node.tag)) return ` ${value.trim()} `;
  if (node.tag === 'tr' || (!withinTable && ['p', 'div', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.tag))) return `\n${value}\n`;
  return value;
}
const cleanText = (node) => text(node).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function postIdentity(node) {
  const fullname = node.attrs['data-fullname'];
  if (/^t3_[a-z0-9]+$/i.test(fullname || '')) return fullname;
  // Old Reddit strips fullname/ID attributes from deleted post wrappers.
  // An explicit deleted wrapper still provides its canonical permalink.
  if (!fullname && hasClass(node, 'deleted') && node.attrs['data-permalink']) {
    const url = new URL(node.attrs['data-permalink'], 'https://old.reddit.com');
    const match = /^\/r\/[a-z0-9_]+\/comments\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname);
    if (url.protocol === 'https:' && ['old.reddit.com', 'www.reddit.com', 'reddit.com'].includes(url.hostname) && !url.username && !url.password && !url.port && match) return `t3_${match[1]}`;
  }
  return null;
}

function page(html) {
  const root = parse(html);
  const posts = all(root, (node) => hasClass(node, 'thing') && hasClass(node, 'link') && postIdentity(node));
  if (!posts.length) {
    const challenge = all(root, (node) => node.tag === 'input' && node.attrs.name === 'js_challenge').length || /blocked by network security|prove your humanity|verify you are human/i.test(cleanText(root));
    const title = all(root, (node) => node.tag === 'title')[0];
    const login = Boolean(title && /welcome to reddit|log in|sign in/i.test(cleanText(title)) && all(root, (node) => node.tag === 'auth-flow-manager' || (node.tag === 'form' && /\/login(?:\/|$|\?)/i.test(node.attrs.action || ''))).length);
    const error = new Error(challenge ? 'Reddit returned an access challenge. HTML collection is unavailable.' : login ? 'Reddit returned a login page. Renew the saved session.' : 'Reddit returned no readable post elements for this page.');
    error.needsAttention = Boolean(challenge || login);
    throw error;
  }
  return posts;
}
function metadata(node, subreddit) {
  if (!/^[a-z0-9_]+$/i.test(subreddit)) throw new Error('Invalid subreddit.');
  const id = postIdentity(node);
  if (node.attrs['data-subreddit']?.toLowerCase() !== subreddit.toLowerCase()) return null;
  const titleNode = all(node, (item) => item.tag === 'a' && hasClass(item, 'title'), true)[0];
  const comments = all(node, (item) => item.tag === 'a' && hasClass(item, 'comments'), true)[0];
  const href = node.attrs['data-permalink'] || comments?.attrs.href || titleNode?.attrs.href;
  if (!href || !titleNode) throw new Error('Reddit post metadata was incomplete.');
  const url = new URL(href, 'https://old.reddit.com');
  const pattern = new RegExp(`^/r/${subreddit}/comments/${id.slice(3)}(?:/|$)`, 'i');
  if (!['old.reddit.com', 'www.reddit.com', 'reddit.com'].includes(url.hostname) || url.protocol !== 'https:' || url.username || url.password || url.port || !pattern.test(url.pathname)) throw new Error('Reddit post link did not match its ID and subreddit.');
  const timestamp = Number(node.attrs['data-timestamp']);
  const time = all(node, (item) => item.tag === 'time' && item.attrs.datetime, true)[0];
  const publishedAt = timestamp > 0 ? timestamp : Date.parse(time?.attrs.datetime);
  const title = cleanText(titleNode);
  if (!title || !Number.isFinite(publishedAt) || publishedAt < 1_100_000_000_000 || publishedAt > Date.now() + 300_000) throw new Error('Reddit post title or publication time was invalid.');
  return { id, title, permalink: url.pathname, publishedAt };
}
export function parseOldRedditListing(html, subreddit) {
  const posts = page(html).map((node) => metadata(node, subreddit)).filter(Boolean);
  if (!posts.length) throw new Error('No posts from the requested subreddit were returned.');
  return [...new Map(posts.map((post) => [post.id, post])).values()];
}
export function parseOldRedditPost(html, subreddit, postId) {
  const node = page(html).find((item) => postIdentity(item) === postId);
  if (!node) throw new Error('Reddit did not return the requested post.');
  const post = metadata(node, subreddit);
  if (!post) throw new Error('Reddit returned a post from another subreddit.');
  const body = all(node, (item) => hasClass(item, 'usertext-body'), true)[0];
  const markdown = body && all(body, (item) => hasClass(item, 'md'))[0];
  const deleted = hasClass(node, 'deleted');
  const selftext = markdown ? cleanText(markdown) : deleted ? '[deleted]' : '';
  const flair = all(node, (item) => hasClass(item, 'linkflairlabel'), true)[0];
  const unavailable = deleted || /^\[(?:removed|deleted)\]$/i.test(selftext) || Boolean(flair && /^sold$/i.test(cleanText(flair)));
  if ((!markdown || !selftext) && !deleted) throw new Error('The complete text body could not be verified. No listing update will be applied.');
  return { ...post, selftext, unavailable };
}
