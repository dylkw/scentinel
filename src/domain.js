const DAY = 24 * 60 * 60 * 1000;

export const normalize = (text = '') => text.trim().toLowerCase().replace(/\s+/g, ' ');
// Lowercase before removing non-letters. Doing it afterwards discarded every
// uppercase character (for example, "Rose" became "ose").
export const fold = (value = '') => normalize(value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[-_/]+/g, ' ').replace(/[^a-z0-9 ]/g, ' '));
export const formatUsd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export const parseWatch = (input, catalog) => {
  const raw = normalize(input);
  const max = /(?:under|below|max)\s*\$?(\d+(?:\.\d{1,2})?)/i.exec(raw);
  const minMl = /(?:at least|min)\s*(\d+(?:\.\d+)?)\s*ml/i.exec(raw);
  const minFill = /(?:at least|min)\s*(\d{1,3})\s*%/i.exec(raw);
  const includeDecants = /\b(?:include|with) decants?\b/i.test(raw);
  const displayName = input
    .replace(/(?:under|below|max)\s*\$?\d+(?:\.\d{1,2})?/gi, '')
    .replace(/(?:at least|min)\s*\d+(?:\.\d+)?\s*ml/gi, '')
    .replace(/(?:at least|min)\s*\d{1,3}\s*%/gi, '')
    .replace(/\b(?:include|with) decants?\b/gi, '')
    .replace(/\s+/g, ' ').trim();
  const query = normalize(displayName);
  if (query.length < 2 || query.length > 80 || !searchWords(query).length) throw new Error('Use a fragrance phrase between 2 and 80 characters containing letters or numbers.');
  if (max && Number(max[1]) <= 0) throw new Error('Maximum price must be positive.');
  if (minMl && Number(minMl[1]) <= 0) throw new Error('Minimum volume must be positive.');
  if (minFill && (Number(minFill[1]) < 1 || Number(minFill[1]) > 100)) throw new Error('Minimum fill must be between 1 and 100%.');
  return { id: crypto.randomUUID(), query, displayName, fragrance: catalog.match(query)?.key || query, aliases: [], maxCents: max ? Math.round(Number(max[1]) * 100) : null, minMl: minMl ? Number(minMl[1]) : null, minFillPct: minFill ? Number(minFill[1]) : null, includeDecants, createdAt: Date.now() };
};

export const watchMatches = (watch, listing) => {
  // The user's complete query is authoritative. A catalog fallback may have
  // dropped a variant (Superleggera) or resolved a brand to a different perfume.
  // Use only the isolated source name, never a whole row or post's raw text.
  const haystack = new Set(searchWords(`${listing.name ?? listing.fragrance} ${listing.brand || ''}`));
  const matchesName = (name) => {
    const words = searchWords(name);
    return words.length > 0 && words.every((word) => haystack.has(word));
  };
  if (![watch.query, ...(watch.aliases || [])].some(matchesName)) return false;
  if (!watch.includeDecants && isDecantListing(listing)) return false;
  if (watch.maxCents && listing.cents > watch.maxCents) return false;
  if (watch.minMl && (!listing.sizeMl || listing.sizeMl < watch.minMl)) return false;
  if (watch.minFillPct && (!listing.fillPct || listing.fillPct < watch.minFillPct)) return false;
  return true;
};

const median = (values) => {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
};

export const valuationFor = (listings, now = Date.now()) => {
  const eligible = listings.filter((listing) => listing.status === 'available' && !isDecantListing(listing) && Number.isFinite(listing.normalizedCentsPerMl) && listing.normalizedCentsPerMl > 0 && listing.recordedAt <= now && listing.recordedAt >= now - 30 * DAY);
  const prices = eligible.map((listing) => listing.normalizedCentsPerMl).sort((a, b) => a - b);
  if (prices.length < 5) return { sampleSize: prices.length, confidence: 'low', medianCentsPerMl: null, lowCentsPerMl: null, highCentsPerMl: null };
  const q1 = median(prices.slice(0, Math.floor(prices.length / 2)));
  const q3 = median(prices.slice(Math.ceil(prices.length / 2)));
  const iqr = q3 - q1;
  const trimmed = prices.filter((price) => price >= q1 - 1.5 * iqr && price <= q3 + 1.5 * iqr);
  if (trimmed.length < 5) return { sampleSize: trimmed.length, confidence: 'low', medianCentsPerMl: null, lowCentsPerMl: null, highCentsPerMl: null };
  const center = median(trimmed);
  return {
    sampleSize: trimmed.length,
    confidence: trimmed.length >= 15 ? 'high' : trimmed.length >= 8 ? 'medium' : 'low',
    medianCentsPerMl: center,
    lowCentsPerMl: Math.round(q1),
    highCentsPerMl: Math.round(q3),
  };
};

export const dealFor = (listing, comparables, now = Date.now()) => {
  if (isDecantListing(listing) || (listing.status && listing.status !== 'available')) return null;
  const valuation = valuationFor(comparables.filter((item) => item.id !== listing.id && item.fragrance === listing.fragrance && (!listing.postId || item.postId !== listing.postId)), now);
  if (!listing.normalizedCentsPerMl || !valuation.medianCentsPerMl) return null;
  const discount = Math.round((1 - listing.normalizedCentsPerMl / valuation.medianCentsPerMl) * 100);
  return discount >= 5 ? { ...valuation, discount } : null;
};

// Inspect raw text as well so previously indexed decants remain excluded.
export const isDecantListing = (listing) => Boolean(listing.isDecant) || /\b(?:decants?|samples?|splits?)\b/i.test(listing.raw || '');

const brandAliases = { mfk: 'maison francis kurkdjian', pdm: 'parfums de marly', jpg: 'jean paul gaultier', ysl: 'yves saint laurent', mm: 'maison margiela', ahs: 'allure homme sport' };
const searchWords = (value) => fold(value).replace(/\b([ld]) (?=[a-z])/g, '$1').split(' ').flatMap((word) => (brandAliases[word] || word).split(' ')).filter(Boolean);
export const searchListings = (listings, query, now = Date.now()) => {
  const words = searchWords(query);
  if (!words.length) return [];
  return listings.filter((listing) => {
    if (listing.status !== 'available' || listing.recordedAt < now - 30 * DAY || listing.recordedAt > now) return false;
    const haystack = new Set(searchWords(`${listing.name ?? listing.fragrance} ${listing.brand || ''}`));
    return words.every((word) => haystack.has(word));
  }).sort((a, b) => b.recordedAt - a.recordedAt);
};
