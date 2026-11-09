import test from 'node:test';
import assert from 'node:assert/strict';
import { dealFor, parseWatch, valuationFor, watchMatches } from '../src/domain.js';
import { fold } from '../src/domain.js';

test('fold preserves uppercase letters while normalizing', () => {
  assert.equal(fold('Rose + Honey'), 'rose honey');
});

const catalog = { match: (value) => /aventus/i.test(value) ? { key: 'creed aventus' } : null };

test('a watch parses its price, size, fill, and decant filters', () => {
  const watch = parseWatch('Aventus under $180 min 100ml min 85% include decants', catalog);
  assert.equal(watch.fragrance, 'creed aventus');
  assert.equal(watch.displayName, 'Aventus');
  assert.equal(watch.query, 'aventus');
  assert.equal(watch.maxCents, 18000);
  assert.equal(watch.minMl, 100);
  assert.equal(watch.minFillPct, 85);
  assert.equal(watch.includeDecants, true);
});

test('a watch rejects listings that fail a structured constraint', () => {
  const watch = parseWatch('aventus under $180 min 100ml min 85%', catalog);
  const listing = { fragrance: 'creed aventus', brand: 'creed', raw: 'Aventus', cents: 17500, sizeMl: 100, fillPct: 80, isDecant: false };
  assert.equal(watchMatches(watch, listing), false);
  assert.equal(watchMatches(watch, { ...listing, fillPct: 90 }), true);
});

test('a watch excludes decants unless explicitly enabled', () => {
  const watch = parseWatch('aventus', catalog);
  const listing = { fragrance: 'creed aventus', brand: 'creed', raw: 'Aventus 10ml $25', cents: 2500, sizeMl: 10, fillPct: 100, isDecant: true };
  assert.equal(watchMatches(watch, listing), false);
  assert.equal(watchMatches(parseWatch('aventus include decants', catalog), listing), true);
});

test('a watch does not match another fragrance merely mentioned in the listing row', () => {
  const watch = parseWatch('aventus absolu', catalog);
  const listing = { fragrance: 'green irish tweed', brand: 'creed', raw: 'Creed Absolu Aventus $12 · Creed Green Irish Tweed $8', cents: 800, sizeMl: 2, fillPct: null, isDecant: false };
  assert.equal(watchMatches(watch, listing), false);
});

test('a watch does not match a fragrance only because its letters appear inside another word', () => {
  const watch = parseWatch('aventus', catalog);
  const listing = { fragrance: 'aventus cologne', brand: 'creed', raw: 'Aventus Cologne 100ml $100', cents: 10000, sizeMl: 100, fillPct: 100, isDecant: false };
  assert.equal(watchMatches(watch, listing), true);
  assert.equal(watchMatches(watch, { ...listing, fragrance: 'adventurous perfume', raw: 'Adventurous perfume 100ml $100' }), false);
});

test('an alternate watch name matches the same listing', () => {
  const watch = { ...parseWatch('blue ridge', catalog), aliases: ['south slope'] };
  const listing = { fragrance: 'south slope', brand: 'example', raw: 'South Slope 100ml $100', cents: 10000, sizeMl: 100, fillPct: 100, isDecant: false };
  assert.equal(watchMatches(watch, listing), true);
});

test('a legacy catalog guess cannot broaden a watch to other fragrances from the same brand', () => {
  const watch = { query: 'narciso rodriguez bleu noir', fragrance: 'narciso' };
  const listing = { fragrance: 'rose musc', name: 'narciso rodriguez rose musc', brand: 'narciso rodriguez' };
  assert.equal(watchMatches(watch, listing), false);
  assert.equal(watchMatches(watch, { ...listing, name: 'narciso rodriguez bleu noir' }), true);
  assert.equal(watchMatches({ query: 'l’eau d’issey', fragrance: 'l eau de l eau' }, { fragrance: 'l eau de l eau', brand: 'diptyque' }), false);
});

test('source names retain variant requirements even when the catalog only knows the base fragrance', () => {
  const watch = { query: 'allure homme sport superleggera', fragrance: 'allure homme sport' };
  const listing = { fragrance: 'allure homme sport', name: 'chanel allure homme sport superleggera', brand: 'chanel' };
  assert.equal(watchMatches(watch, listing), true);
  assert.equal(watchMatches(watch, { ...listing, name: 'chanel allure homme sport edt' }), false);
  assert.equal(watchMatches({ ...watch, query: 'superleggera' }, listing), true);
  assert.equal(watchMatches(watch, { ...listing, name: 'chanel ahs superleggera' }), true);
});

test('watch names accept reordered words, abbreviations, accents and apostrophe spacing', () => {
  for (const [query, name] of [['platinum egoiste', 'Égoïste Platinum'], ['pdm layton', 'Parfums de Marly Layton'], ['terre d’hermes', 'Terre Dhermès'], ['l’eau d’issey', "L' Eau D' Issey Pour Homme"]]) {
    assert.equal(watchMatches({ query }, { name }), true, query);
  }
});

test('empty or punctuation-only watch names never match every listing', () => {
  for (const query of ['', '**', '!!']) {
    assert.equal(watchMatches({ query }, { fragrance: 'aventus' }), false);
    assert.throws(() => parseWatch(query, catalog));
  }
});

test('valuation excludes IQR outliers and produces a confidence level', () => {
  const now = Date.now();
  const listings = [150, 155, 160, 165, 170, 175, 180, 185, 190, 600].map((normalizedCentsPerMl, index) => ({ id: String(index), status: 'available', normalizedCentsPerMl, recordedAt: now }));
  const value = valuationFor(listings, now);
  assert.equal(value.confidence, 'medium');
  assert.equal(value.medianCentsPerMl, 170);
  assert.equal(value.sampleSize, 9);
});

test('deals are measured against normalized comparables', () => {
  const now = Date.now();
  const comparables = [150, 155, 160, 165, 170, 175, 180, 185].map((normalizedCentsPerMl, index) => ({ id: String(index), status: 'available', normalizedCentsPerMl, recordedAt: now }));
  const deal = dealFor({ id: 'new', normalizedCentsPerMl: 120, recordedAt: now }, comparables);
  assert.equal(deal.discount, 29);
  assert.equal(deal.confidence, 'medium');
});

test('watch constraints reject impossible values', () => {
  for (const query of ['aventus min 101%', 'aventus min 0%', 'aventus under $0', 'aventus min 0ml']) assert.throws(() => parseWatch(query, catalog));
});

test('market excludes decants, expired and future observations', () => {
  const now = Date.now();
  const listings = [0, 1, 2, 3, 4].map((id) => ({ id, status: 'available', normalizedCentsPerMl: 200, recordedAt: now }));
  const excluded = [{ isDecant: true }, { raw: 'sample 2ml' }, { recordedAt: now + 1000 }, { recordedAt: now - 31 * 86400000 }].map((overrides) => ({ ...listings[0], normalizedCentsPerMl: 10, ...overrides }));
  assert.equal(valuationFor([...listings, ...excluded], now).sampleSize, 5);
});
