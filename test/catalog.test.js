import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../src/catalog.js';

const catalog = createCatalog([
  { product: 'l-eau-de-l-eau', brand: 'diptyque' },
  { product: 'l-eau-d-issey-pour-homme', brand: 'issey-miyake' },
  { product: 'chanel-no-46', brand: 'chanel' },
  { product: '4-montabaco-intensivo', brand: 'ormonde-jayne' },
  { product: 'montabaco', brand: 'ormonde-jayne' },
  { product: 'egoiste-platinum', brand: 'chanel' },
  { product: 'layton', brand: 'parfums-de-marly' },
]);

test('catalog matches require short words, numbers, and repeated words too', () => {
  assert.equal(catalog.match('L’eau d’Issey'), null);
  assert.equal(catalog.match('L’eau'), null);
  assert.equal(catalog.match('L’eau de l’eau').key, 'l eau de l eau');
  assert.equal(catalog.match('Issey Miyake L’eau d’Issey Pour Homme').brand, 'issey miyake');
  assert.equal(catalog.match('Chanel Superleggera'), null);
  assert.equal(catalog.match('Chanel No 46').key, 'chanel no 46');
  assert.equal(catalog.match('Ormonde Jayne Montabaco Intensivo').key, 'montabaco');
});

test('catalog retains reordered names and brand abbreviations', () => {
  assert.equal(catalog.match('Chanel Platinum Egoiste').key, 'egoiste platinum');
  assert.equal(catalog.match('PDM Layton').brand, 'parfums de marly');
});

test('duplicate catalog rows do not make an otherwise unique name ambiguous', () => {
  const duplicates = createCatalog([{ product: 'layton', brand: 'parfums-de-marly' }, { product: 'layton', brand: 'parfums-de-marly' }]);
  assert.equal(duplicates.match('Layton').key, 'layton');
});
