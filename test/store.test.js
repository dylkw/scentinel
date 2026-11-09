import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('a watch can be removed by its Telegram callback identifier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sillage-store-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  await store.addWatch('42', { id: 'watch-1', query: 'aventus', maxCents: null, minMl: null, minFillPct: null });
  assert.equal(await store.removeWatchById('42', 'watch-1'), true);
  assert.deepEqual(store.watches('42'), []);
});

test('alternate names belong to one watch and cannot be reused by another', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-store-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  await store.addWatch('42', { id: 'watch-1', query: 'blue ridge', aliases: [], maxCents: null, minMl: null, minFillPct: null });
  await store.addWatch('42', { id: 'watch-2', query: 'mountain air', aliases: [], maxCents: null, minMl: null, minFillPct: null });
  assert.equal(await store.addAlias('42', 'blue ridge', 'south slope'), 'added');
  assert.equal(await store.addAlias('42', 'mountain air', 'south slope'), 'in-use');
  assert.deepEqual(store.watches('42')[0].aliases, ['south slope']);
});

test('price edits update an existing listing and migrate legacy notification IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-store-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  store.data.listings['post:1:10000'] = { id: 'post:1:10000', postId: 'post', cents: 10000, firstSeenAt: 10 };
  store.data.notifications['post:1:10000:chat:watch'] = { sentAt: 20 };
  await store.upsertListings([{ id: 'post:1', postId: 'post', cents: 9000, sizeMl: 100, firstSeenAt: 30 }]);
  assert.equal(Object.keys(store.data.listings).length, 1);
  assert.equal(store.data.listings['post:1'].cents, 9000);
  assert.equal(store.data.listings['post:1'].firstSeenAt, 10);
  assert.equal(store.notified('post:1:chat:watch'), true);
  await store.upsertListings([{ ...store.data.listings['post:1'], sizeMl: 50 }]);
  assert.equal(store.data.listings['post:1'].sizeMl, 50);
});

test('failed transactions roll back and subsequent writes recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-store-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  const save = store.save;
  store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.updateOffset(42), /disk full/);
  assert.equal(store.data.botOffset, 0);
  store.save = save;
  await Promise.all([store.updateOffset(1), store.updateOffset(2)]);
  const reloaded = new Store(store.file);
  await reloaded.load();
  assert.equal(reloaded.data.botOffset, 2);
});

test('complete HTML snapshots retain delivered identities across line and price changes and retire missing rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-html-store-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  const bottle = { id: 't3_post:1', postId: 't3_post', fragrance: 'aventus', sizeMl: 100, cents: 10000, fillPct: 90, raw: 'Aventus 100ml $100 90%', status: 'available', firstSeenAt: 10 };
  store.data.listings[bottle.id] = bottle;
  store.data.listings['t3_post:2'] = { ...bottle, id: 't3_post:2', fragrance: 'sauvage' };
  store.data.notifications['t3_post:1:chat'] = { sentAt: 20 };
  await store.replacePostListings('t3_post', [{ ...bottle, id: 't3_post:8', cents: 9000, raw: 'Aventus 100ml $90 90%', firstSeenAt: 30 }]);
  assert.equal(store.data.listings['t3_post:1'].cents, 9000);
  assert.equal(store.data.listings['t3_post:1'].firstSeenAt, 10);
  assert.equal(store.notified('t3_post:1:chat'), true);
  assert.equal(store.data.listings['t3_post:2'].status, 'removed');
  await store.replacePostListings('t3_post', []);
  assert.equal(store.data.listings['t3_post:1'].status, 'removed');
});

test('identical repeated bottles retain IDs on snapshot replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scentinel-html-replay-'));
  const store = new Store(join(directory, 'store.json'));
  await store.load();
  const listing = { postId: 't3_same', fragrance: 'aventus', sizeMl: 100, cents: 10000, raw: 'Aventus 100ml $100', status: 'available' };
  await store.replacePostListings('t3_same', [listing, listing]);
  const ids = Object.keys(store.data.listings);
  await store.replacePostListings('t3_same', [listing, listing]);
  assert.deepEqual(Object.keys(store.data.listings), ids);
});
