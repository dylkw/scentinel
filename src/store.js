import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const initial = () => ({ version: 2, subscriptions: {}, listings: {}, notifications: {}, botOffset: 0, metrics: { startedAt: Date.now(), polls: 0, pollFailures: 0, lastPollAt: null, lastSuccessAt: null, alertsSent: 0 } });

export class Store {
  constructor(file) { this.file = file; this.data = initial(); this.pending = Promise.resolve(); }
  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) this.data = { ...initial(), ...JSON.parse(await readFile(this.file, 'utf8')) };
    this.data.subscriptions ||= {}; this.data.listings ||= {}; this.data.notifications ||= {}; this.data.metrics = { ...initial().metrics, ...this.data.metrics };
    for (const [chatId, watches] of Object.entries(this.data.subscriptions)) this.data.subscriptions[chatId] = watches.map((watch) => typeof watch === 'string' ? { id: crypto.randomUUID(), query: watch, fragrance: watch, aliases: [], maxCents: null, minMl: null, minFillPct: null, includeDecants: false, createdAt: Date.now() } : { ...watch, aliases: watch.aliases || [], createdAt: watch.createdAt || Date.now(), includeDecants: Boolean(watch.includeDecants) });
  }
  async transact(fn) {
    const operation = this.pending.then(async () => { const previous = this.data; this.data = structuredClone(previous); try { const value = await fn(this.data); await this.save(); return value; } catch (error) { this.data = previous; throw error; } });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async save() { const temp = `${this.file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); await rename(temp, this.file); }
  watches(chatId) { return this.data.subscriptions[chatId] || []; }
  async addWatch(chatId, watch) { return this.transact((data) => { const current = data.subscriptions[chatId] || []; if (current.some((item) => item.query === watch.query && item.maxCents === watch.maxCents && item.minMl === watch.minMl && item.minFillPct === watch.minFillPct && Boolean(item.includeDecants) === Boolean(watch.includeDecants))) return false; data.subscriptions[chatId] = [...current, watch]; return true; }); }
  async removeWatch(chatId, query) { return this.transact((data) => { const old = data.subscriptions[chatId] || []; const next = old.filter((watch) => watch.query !== query); if (next.length) data.subscriptions[chatId] = next; else delete data.subscriptions[chatId]; return next.length !== old.length; }); }
  async removeWatchById(chatId, id) { return this.transact((data) => { const old = data.subscriptions[chatId] || []; const next = old.filter((watch) => watch.id !== id); if (next.length) data.subscriptions[chatId] = next; else delete data.subscriptions[chatId]; return next.length !== old.length; }); }
  async addAlias(chatId, query, alias) { return this.transact((data) => { const watches = data.subscriptions[chatId] || []; const watch = watches.find((item) => item.query === query); if (!watch) return 'missing'; if (watch.query === alias || watch.aliases.includes(alias)) return 'exists'; if (watches.some((item) => item.query === alias || item.aliases.includes(alias))) return 'in-use'; watch.aliases = [...watch.aliases, alias]; return 'added'; }); }
  async removeAlias(chatId, query, alias) { return this.transact((data) => { const watch = (data.subscriptions[chatId] || []).find((item) => item.query === query); if (!watch) return 'missing'; const before = watch.aliases.length; watch.aliases = watch.aliases.filter((item) => item !== alias); return watch.aliases.length === before ? 'absent' : 'removed'; }); }
  async stop(chatId) { return this.transact((data) => { delete data.subscriptions[chatId]; }); }
  async migrateListingNames(parseListing) {
    if (this.data.listingNamesVersion === 2) return false;
    return this.transact((data) => {
      for (const [id, listing] of Object.entries(data.listings)) {
        const parsed = parseListing(listing);
        // Keep delivery identities and lifecycle state. Ambiguous legacy rows
        // cannot safely supply a name for matching and must no longer alert.
        data.listings[id] = parsed
          ? { ...listing, name: parsed.name, fragrance: parsed.fragrance, brand: parsed.brand }
          : { ...listing, status: listing.status === 'available' ? 'removed' : listing.status };
      }
      data.listingNamesVersion = 2;
      return true;
    });
  }
  listingsFor(fragrance) { return Object.values(this.data.listings).filter((listing) => listing.fragrance === fragrance); }
  async upsertListings(listings) { return this.transact((data) => { let inserted = 0; const changed = []; for (const listing of listings) { let previous = data.listings[listing.id];
      // Migrate the former price-dependent identity when a post is seen again.
      if (!previous) { const legacyId = Object.keys(data.listings).find((id) => id.startsWith(`${listing.id}:`) && data.listings[id].postId === listing.postId); if (legacyId) { previous = data.listings[legacyId]; delete data.listings[legacyId]; for (const key of Object.keys(data.notifications)) if (key.startsWith(`${legacyId}:`)) { data.notifications[`${listing.id}${key.slice(legacyId.length)}`] = data.notifications[key]; delete data.notifications[key]; } data.listings[listing.id] = { ...previous, id: listing.id }; } }
 if (!previous) { data.listings[listing.id] = listing; inserted++; changed.push(listing); } else if (['status', 'cents', 'sizeMl', 'fillPct', 'isDecant', 'name', 'fragrance', 'raw', 'normalizedCentsPerMl'].some((field) => previous[field] !== listing[field])) { data.listings[listing.id] = { ...previous, ...listing, firstSeenAt: previous.firstSeenAt }; changed.push(data.listings[listing.id]); } } return { inserted, changed }; }); }
  async replacePostListings(postId, listings) {
    return this.transact((data) => {
      const previous = Object.values(data.listings).filter((listing) => listing.postId === postId);
      const used = new Set();
      const comparable = (a, b) => a.fragrance === b.fragrance && a.sizeMl === b.sizeMl && Boolean(a.isDecant) === Boolean(b.isDecant);
      const raw = (listing) => String(listing.raw || '').replace(/~~/g, '').replace(/\s+/g, ' ').trim();
      for (const listing of listings) {
        const candidates = previous.filter((old) => !used.has(old.id) && comparable(old, listing));
        const exact = candidates.find((old) => raw(old) === raw(listing));
        const sameValue = candidates.find((old) => old.cents === listing.cents && old.fillPct === listing.fillPct);
        const old = exact || sameValue || candidates.sort((a, b) => Math.abs(a.cents - listing.cents) - Math.abs(b.cents - listing.cents))[0];
        const id = old?.id || `${postId}:html:${crypto.randomUUID()}`;
        used.add(id);
        data.listings[id] = { ...old, ...listing, id, firstSeenAt: old?.firstSeenAt ?? listing.firstSeenAt };
      }
      for (const old of previous) if (!used.has(old.id)) data.listings[old.id] = { ...old, status: 'removed' };
    });
  }
  notified(key) { return Boolean(this.data.notifications[key]); }
  async markNotified(key, messageId = null) { return this.transact((data) => { data.notifications[key] = { sentAt: Date.now(), messageId }; const keys = Object.keys(data.notifications); if (keys.length > 100000) for (const old of keys.slice(0, keys.length - 100000)) delete data.notifications[old]; data.metrics.alertsSent++; }); }
  async updateOffset(offset) { return this.transact((data) => { data.botOffset = offset; }); }
  async pollResult(ok) { return this.transact((data) => { data.metrics.polls++; data.metrics.lastPollAt = Date.now(); if (ok) data.metrics.lastSuccessAt = Date.now(); else data.metrics.pollFailures++; }); }
}
