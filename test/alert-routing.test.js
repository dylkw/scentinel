import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command, listingFromLine, pollReddit, repairListingNames, store } from '../src/server.js';
import { Store } from '../src/store.js';
import { watchMatches } from '../src/domain.js';

test('saved user queries route only their own fragrances; overlapping and shared watches deliver once per chat', async () => {
  const original = { data: store.data, save: store.save, fetch: globalThis.fetch, now: Date.now };
  let clock = Date.now();
  const sent = [];
  store.data = new Store('unused').data;
  store.save = async () => {};
  Date.now = () => clock;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('/sendMessage')) return new Response('<feed></feed>');
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  const addListing = (id, raw) => {
    const listing = listingFromLine({ id, title: '[WTS] Bottles', permalink: '/r/fragranceswap/test', publishedAt: clock - 1000 }, raw, 0);
    assert.ok(listing, raw);
    store.data.listings[listing.id] = listing;
    return listing;
  };
  try {
    for (const [chatId, query] of [['owner', 'narciso rodriguez bleu noir'], ['friend', 'superleggera'], ['friend', 'chanel allure homme sport superleggera'], ['friend', 'ormonde jayne montabaco intensivo'], ['third', 'superleggera']]) {
      assert.match((await command(chatId, `/add ${query}`)).text, /WATCH CREATED/);
    }
    // Reproduce corrupt canonical values saved before the fix as well.
    store.data.subscriptions.owner[0].fragrance = 'narciso';
    clock += 2000;
    addListing('rose', 'Narciso Rodriguez Rose Musc -100ml - $60');
    addListing('bleu', 'Narciso Rodriguez Bleu Noir 100ml $60');
    addListing('variant', '[Chanel Allure Homme Sport Superleggera](https://imgur.com/a/test) 100ml $150');
    addListing('base', 'Chanel Allure Homme Sport EDT 100ml $70');
    addListing('montabaco', 'Ormonde Jayne Montabaco Intensivo 100ml $150');
    await pollReddit();
    assert.deepEqual(sent.map(({ chat_id, text }) => [chat_id, /href="[^"]+">([^<]+)/.exec(text)[1]]), [
      ['owner', 'narciso rodriguez bleu noir'],
      ['friend', 'superleggera'],
      ['third', 'superleggera'],
      ['friend', 'ormonde jayne montabaco intensivo'],
    ]);
    clock += 90_001;
    await pollReddit();
    assert.equal(sent.length, 4);
    await command('friend', '/stop');
    addListing('another-variant', 'Chanel AHS Superleggera 100ml $125');
    clock += 90_001;
    await pollReddit();
    assert.equal(sent.length, 5);
    assert.equal(sent.at(-1).chat_id, 'third');
    assert.equal(store.watches('owner').length, 1);
    await command('owner', '/add Montblanc Explorer under $50 min 90ml min 85%');
    await command('owner', '/alias montblanc explorer = mb explorer');
    await command('third', '/add MB Explorer');
    clock += 2000;
    addListing('explorer', 'MB Explorer tester 90/100ml $40 shipped, barely used');
    clock += 90_001;
    await pollReddit();
    assert.deepEqual(sent.slice(-2).map(({ chat_id, text, ...options }) => ({ chat_id, text, options })), [
      { chat_id: 'owner', text: '<a href="https://www.reddit.com/r/fragranceswap/test">Montblanc Explorer</a>\nPrice: $40\nVolume: 100 ml\nFilled: 90%', options: { disable_web_page_preview: true, parse_mode: 'HTML' } },
      { chat_id: 'third', text: '<a href="https://www.reddit.com/r/fragranceswap/test">MB Explorer</a>\nPrice: $40\nVolume: 100 ml\nFilled: 90%', options: { disable_web_page_preview: true, parse_mode: 'HTML' } },
    ]);
  } finally {
    store.data = original.data;
    store.save = original.save;
    globalThis.fetch = original.fetch;
    Date.now = original.now;
  }
});

test('startup repair persists complete source names without resetting watches, IDs, states or delivery history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-names-'));
  const target = new Store(join(directory, 'store.json'));
  await target.load();
  target.data.listingNamesVersion = 1;
  target.data.subscriptions = { owner: [{ id: 'watch', query: 'superleggera', fragrance: 'superleggera', createdAt: 10 }] };
  const old = { id: 'post:html:stable', postId: 'post', fragrance: 'allure homme sport', brand: 'chanel', raw: 'Chanel Allure Homme Sport Superleggera 100ml $150', status: 'sold', cents: 15000, firstSeenAt: 20, recordedAt: 15, isDecant: true };
  target.data.listings[old.id] = old;
  target.data.listings.ambiguous = { ...old, id: 'ambiguous', status: 'available', raw: 'Aventus $100 Sauvage $50' };
  target.data.listings.numbered = { ...old, id: 'numbered', status: 'available', fragrance: '4 montabaco intensivo', brand: 'ormonde jayne', raw: 'Ormonde Jayne Montabaco Intensivo 100ml $150' };
  target.data.notifications[`${old.id}:owner`] = { sentAt: 30, messageId: 42 };
  const history = structuredClone(target.data.notifications);
  const subscriptions = structuredClone(target.data.subscriptions);
  try {
    assert.equal(await repairListingNames(target), true);
    assert.equal(await repairListingNames(target), false);
    const reloaded = new Store(target.file);
    await reloaded.load();
    const listing = reloaded.data.listings[old.id];
    assert.equal(listing.name, 'chanel allure homme sport superleggera');
    for (const key of ['id', 'status', 'firstSeenAt', 'recordedAt', 'isDecant', 'cents']) assert.equal(listing[key], old[key], key);
    assert.equal(reloaded.data.listings.ambiguous.status, 'removed');
    assert.equal(reloaded.data.listings.numbered.name, 'ormonde jayne montabaco intensivo');
    assert.deepEqual(reloaded.data.notifications, history);
    assert.deepEqual(reloaded.data.subscriptions.owner.map(({ query, id }) => ({ query, id })), subscriptions.owner.map(({ query, id }) => ({ query, id })));
    assert.equal(reloaded.data.listingNamesVersion, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sale link URLs cannot trigger a watch and unsupported catalog variants retain their source name', () => {
  const post = { id: 'post', title: '[WTS]', permalink: '/test', publishedAt: Date.now() };
  const listing = listingFromLine(post, '[Chanel Allure Homme Sport Superleggera](https://example.com/aventus) 100ml $150', 0);
  assert.match(listing.name, /superleggera/);
  assert.doesNotMatch(listing.name, /aventus|example.com/);
});

test('fragrances requested in trade prose after the sale price cannot trigger an alert', () => {
  const post = { id: 'post', title: '[WTS]', permalink: '/test', publishedAt: Date.now() };
  const listing = listingFromLine(post, 'Creed Aventus 100ml $100 or trade for Amouage Reflection 45', 0);
  assert.equal(watchMatches({ query: 'amouage reflection' }, listing), false);
  assert.equal(watchMatches({ query: 'creed aventus' }, listing), true);
  assert.equal(listingFromLine(post, '$100 Creed Aventus 100ml', 0).name, 'creed aventus');
});

test('a clone comparison in seller notes cannot trigger a watch for the original fragrance', () => {
  const post = { id: 'post', title: '[WTS]', permalink: '/test', publishedAt: Date.now() };
  const listing = listingFromLine(post, 'Maison Alhambra Toro Pour Homme Glacé EDT (Terre d’Hermès EDT) 100ml $20', 0);
  assert.equal(watchMatches({ query: 'terre d’hermes', fragrance: 'terre d hermes' }, listing), false);
  assert.equal(watchMatches({ query: 'maison alhambra toro' }, listing), true);
  assert.doesNotMatch(listing.name, /hermès/);
});
