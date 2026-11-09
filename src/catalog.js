import { fold } from './domain.js';

const brandAliases = { mfk: 'maison francis kurkdjian', pdm: 'parfums de marly', jpg: 'jean paul gaultier', ysl: 'yves saint laurent', adg: 'giorgio armani', mm: 'maison margiela' };
const countsFor = (text) => {
  const counts = new Map();
  for (const word of text.split(' ').filter(Boolean)) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
};
const contains = (text, phrase) => ` ${text} `.includes(` ${phrase} `);

export function createCatalog(rows) {
  const products = new Map();
  const brands = new Map(Object.entries(brandAliases));
  for (const { product: sourceProduct, brand: sourceBrand } of rows) {
    const product = fold(sourceProduct);
    const brand = fold(sourceBrand);
    if (product.length < 4 || !brand) continue;
    const entries = products.get(product) || [];
    if (!entries.some((entry) => entry.brand === brand)) entries.push({ product, brand });
    products.set(product, entries);
    brands.set(brand, brand);
  }

  // Index by one required word so matching a row needn't scan every product.
  // Keep short words and their counts: "l eau de l eau" needs all five words.
  const index = (names) => {
    const byWord = new Map();
    for (const name of names) {
      const counts = countsFor(name);
      const anchor = [...counts.keys()].sort((a, b) => b.length - a.length)[0];
      const entries = byWord.get(anchor) || [];
      entries.push({ name, counts });
      byWord.set(anchor, entries);
    }
    return (words) => [...words.keys()].flatMap((word) => byWord.get(word) || [])
      .filter((entry) => [...entry.counts].every(([word, count]) => (words.get(word) || 0) >= count))
      .sort((a, b) => b.name.length - a.name.length);
  };
  const productCandidates = index(products.keys());
  const brandCandidates = index(brands.keys());
  return {
    match(value) {
      const text = fold(value);
      const words = countsFor(text);
      const mentioned = new Set(brandCandidates(words).filter(({ name }) => contains(text, name)).map(({ name }) => brands.get(name)));
      for (const { name } of productCandidates(words)) {
        const entries = products.get(name);
        const chosen = entries.filter((entry) => mentioned.has(entry.brand));
        const entry = chosen.length === 1 ? chosen[0] : entries.length === 1 && !mentioned.size ? entries[0] : null;
        if (entry) return { key: entries.length === 1 ? entry.product : `${entry.brand} ${entry.product}`, ...entry };
      }
      return null;
    },
  };
}
