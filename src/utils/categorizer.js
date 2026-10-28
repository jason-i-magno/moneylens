import { DEFAULT_CATEGORY_KEYWORDS, DEFAULT_SUBSCRIPTION_KEYWORDS } from '../constants/defaultKeywords';
import { CATEGORIES, CATEGORY_MAP, isIncomeCategory } from '../constants/categories';
import { mapPlaidCategory } from '../constants/plaidCategories';

const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Keyword must start at a word boundary: 'rent' matches "RENT PMT" but not "PARENT" or "CURRENT".
// A space matches any run of whitespace, since banks pad descriptions ("IRS  TREAS 310").
export function keywordRegex(keyword) {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(keyword.toLowerCase()).replace(/ +/g, '\\s+')}`, 'i');
}

// A comma-separated keyword field: "a, b, ,c" → ['a', 'b', 'c'], or undefined when empty so the field is left out
export function parseKeywordList(text) {
  const list = text.split(',').map((k) => k.trim()).filter(Boolean);
  return list.length ? list : undefined;
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

// Money in takes income categories (and Transfers), money out the spending ones
const fitsDirection = (category, isCredit) => category === 'transfers' || isIncomeCategory(category) === isCredit;

// The longest keyword of a category that fits the direction; for money in, also the longest of any
// category, because a store's keyword on a credit means a refund of a purchase
function matchCategory(description, matchers, isCredit) {
  const fitting = matchers.find((m) => fitsDirection(m.category, isCredit) && m.regex.test(description))?.category || null;
  const refund = !fitting && isCredit && matchers.some((m) => m.regex.test(description));
  return { fitting, refund };
}

// A category that fits the direction: an unknown or store category on a credit becomes Other Income
// or Refunds, and an income category on a debit becomes Other
function fitToDirection(category, isCredit) {
  if (category && fitsDirection(category, isCredit)) return category;
  if (!isCredit) return 'other';
  return category && category !== 'other' ? 'refunds' : 'other_income';
}

// For a debit (money out)
export function categorizeTransaction(description, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  return matchCategory(description, compileMatchers(keywords), false).fitting || 'other';
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

// A row is money in when `isCredit` is set (stored and synced rows) or `isDebit` is false (CSV rows).
// Order: the bank's own category, a keyword of the right direction, then `fallbackCategory` (optional,
// per row: Plaid's category). On money in, a store keyword makes it a refund, unless the fallback
// already says income or transfer.
export function categorizeBatch(transactions, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  const matchers = compileMatchers(keywords);
  return transactions.map((tx) => {
    const isCredit = tx.isCredit ?? tx.isDebit === false;
    const { fitting, refund } = matchCategory(tx.description, matchers, isCredit);
    let category = normalizeBankCategory(tx.category) || fitting;
    if (!category) category = refund && !fitsDirection(tx.fallbackCategory, true) ? 'refunds' : tx.fallbackCategory;
    return { ...tx, category: fitToDirection(category, isCredit), isSubscription: isSubscription(tx.description) };
  });
}

// Category and subscription flag for stored transactions (CSV or Bank Sync). Plaid's merchant
// name is matched too, and when no keyword matches, a transfer between the user's own synced
// accounts stays a transfer and anything else gets Plaid's own category.
export function recategorizeStored(transactions, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  return categorizeBatch(
    transactions.map((tx) => ({
      description: [tx.name, tx.merchantName].filter(Boolean).join(' '),
      category: null,
      isCredit: tx.type === 'credit',
      fallbackCategory: tx.pairedTransfer ? 'transfers' : mapPlaidCategory(tx.plaidCategory),
    })),
    keywords
  ).map(({ category, isSubscription }) => ({ category, isSubscription }));
}

// What Re-categorize would change: imported and synced transactions whose category or subscription
// flag differs from what the keywords give now. Categories the user set by hand are left out.
export function proposeRecategorization(transactions, keywords = DEFAULT_CATEGORY_KEYWORDS) {
  const candidates = transactions.filter((tx) => (tx.source === 'csv_import' || tx.source === 'plaid') && !tx.categorySetByUser);
  return recategorizeStored(candidates, keywords)
    .map((r, i) => ({ tx: candidates[i], category: r.category, isSubscription: r.isSubscription }))
    .filter(({ tx, category, isSubscription }) => tx.category !== category || !!tx.isSubscription !== isSubscription);
}
