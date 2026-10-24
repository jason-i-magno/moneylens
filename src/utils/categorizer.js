import { DEFAULT_CATEGORY_KEYWORDS, DEFAULT_SUBSCRIPTION_KEYWORDS } from '../constants/defaultKeywords';
import { CATEGORIES, CATEGORY_MAP } from '../constants/categories';
import { mapPlaidCategory } from '../constants/plaidCategories';

const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keyword must start at a word boundary: 'rent' matches "RENT PMT" but not "PARENT" or "CURRENT"
function keywordRegex(keyword) {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(keyword.toLowerCase())}`, 'i');
}

// Effective keywords = code defaults − user removals + user additions.
// Only the user's overrides are stored, so improvements to the defaults reach existing data.
export function getEffectiveKeywords(added = {}, removed = {}) {
  const ids = new Set([...Object.keys(DEFAULT_CATEGORY_KEYWORDS), ...Object.keys(added)]);
  const result = {};
  for (const id of CATEGORIES.map((c) => c.id)) {
    if (!ids.has(id)) continue;
    const removedSet = new Set((removed[id] || []).map((k) => k.toLowerCase()));
    const defaults = (DEFAULT_CATEGORY_KEYWORDS[id] || []).filter((k) => !removedSet.has(k.toLowerCase()));
    result[id] = [...new Set([...defaults, ...(added[id] || [])])];
  }
  return result;
}

// Inverse of getEffectiveKeywords: turn an edited full keyword map back into overrides
export function diffKeywords(edited) {
  const added = {};
  const removed = {};
  for (const id of Object.keys({ ...DEFAULT_CATEGORY_KEYWORDS, ...edited })) {
    if (!CATEGORY_MAP[id]) continue;
    const defaults = DEFAULT_CATEGORY_KEYWORDS[id] || [];
    const current = edited[id] || [];
    const defaultSet = new Set(defaults.map((k) => k.toLowerCase()));
    const currentSet = new Set(current.map((k) => k.toLowerCase()));
    const extra = current.filter((k) => !defaultSet.has(k.toLowerCase()));
    const missing = defaults.filter((k) => !currentSet.has(k.toLowerCase()));
    if (extra.length) added[id] = extra;
    if (missing.length) removed[id] = missing;
  }
  return { added, removed };
}

// Longest keyword wins so specific rules beat generic ones ('uber eats' over 'uber',
// 'internet payment - thank you' over 'internet'). Ties go to the category listed first.
function compileMatchers(keywords) {
  const matchers = [];
  for (const [category, terms] of Object.entries(keywords)) {
    if (!CATEGORY_MAP[category]) continue;
    for (const term of terms) {
      if (!term.trim()) continue;
      matchers.push({ category, length: term.length, order: CATEGORY_ORDER[category], regex: keywordRegex(term) });
    }
  }
  return matchers.sort((a, b) => b.length - a.length || a.order - b.order);
}

function matchCategory(description, matchers, fallback = 'other') {
  return matchers.find((m) => m.regex.test(description))?.category || fallback;
}

export function categorizeTransaction(description, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  return matchCategory(description, compileMatchers(keywords));
}

export function isSubscription(description, keywords = DEFAULT_SUBSCRIPTION_KEYWORDS) {
  return keywords.some((term) => keywordRegex(term).test(description));
}

// A bank-provided category is kept only if it maps to one of ours (by id or display name)
function normalizeBankCategory(raw) {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  return CATEGORIES.find((c) => c.id === lower || c.name.toLowerCase() === lower)?.id || null;
}

// `fallbackCategory` (optional, per row) replaces 'other' when no keyword matches
export function categorizeBatch(transactions, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  const matchers = compileMatchers(keywords);
  return transactions.map((tx) => ({
    ...tx,
    category: normalizeBankCategory(tx.category) || matchCategory(tx.description, matchers, tx.fallbackCategory || 'other'),
    isSubscription: isSubscription(tx.description),
  }));
}

// Category and subscription flag for stored transactions (CSV or Bank Sync). Plaid's merchant
// name is matched too, and when no keyword matches, a transfer between the user's own synced
// accounts stays a transfer and anything else gets Plaid's own category.
export function recategorizeStored(transactions, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  return categorizeBatch(
    transactions.map((tx) => ({
      description: [tx.name, tx.merchantName].filter(Boolean).join(' '),
      category: null,
      fallbackCategory: tx.pairedTransfer ? 'transfers' : mapPlaidCategory(tx.plaidCategory),
    })),
    keywords
  ).map(({ category, isSubscription }) => ({ category, isSubscription }));
}
