import { DEFAULT_CATEGORY_KEYWORDS } from '../constants/defaultKeywords';
import { CATEGORY_MAP } from '../constants/categories';

export const SCHEMA_VERSION = 3;

export function createDefaultData() {
  return {
    version: SCHEMA_VERSION,
    subscriptions: [],
    transactions: [],
    budgets: {},
    bankProfiles: {},
    categoryKeywords: {}, // user-added keywords per category (merged with code defaults)
    removedKeywords: {}, // code-default keywords the user turned off, per category
    mortgages: { properties: [], loans: [], payments: [] },
    netWorth: { accounts: [], snapshots: [] },
    plaid: { items: [] }, // Bank Sync connections: account mapping + cursor (access tokens stay on the local server)
  };
}

// Keywords that used to be category defaults but no longer are
const RETIRED_DEFAULT_KEYWORDS = ['discover', 'auto', 'subscription', 'membership', 'annual fee', 'monthly fee'];

// v1 stored a full copy of the defaults from first launch, which shadowed later default changes.
// Keep only keywords the user actually added; drop categories that no longer exist (e.g. 'food').
function extractUserKeywords(stored = {}) {
  const known = new Set([
    ...Object.values(DEFAULT_CATEGORY_KEYWORDS).flat(),
    ...RETIRED_DEFAULT_KEYWORDS,
  ].map((k) => k.toLowerCase()));

  const added = {};
  for (const [category, terms] of Object.entries(stored)) {
    if (!CATEGORY_MAP[category] || !Array.isArray(terms)) continue;
    const userTerms = terms.filter((t) => !known.has(t.toLowerCase()));
    if (userTerms.length) added[category] = userTerms;
  }
  return added;
}

// Records created in a loop within one millisecond could share an ID. Rename the extras;
// `isPreferred` picks which record in a collision keeps the original ID (and thus its references).
export function dedupeIds(items, isPreferred = () => false) {
  const keepers = new Map();
  for (const item of items) if (isPreferred(item) && !keepers.has(item.id)) keepers.set(item.id, item);
  for (const item of items) if (!keepers.has(item.id)) keepers.set(item.id, item);

  const used = new Set(items.map((i) => i.id));
  return items.map((item) => {
    if (keepers.get(item.id) === item) return item;
    let n = 1;
    while (used.has(`${item.id}_${n}`)) n++;
    const id = `${item.id}_${n}`;
    used.add(id);
    return { ...item, id };
  });
}

export function migrateData(raw) {
  const base = createDefaultData();
  const data = {
    ...base,
    ...raw,
    mortgages: { ...base.mortgages, ...raw.mortgages },
    netWorth: { ...base.netWorth, ...raw.netWorth },
    plaid: { ...base.plaid, ...raw.plaid }, // v2 → v3 added `plaid`; this fills it in
  };

  if ((raw.version || 1) < 2) {
    data.categoryKeywords = extractUserKeywords(raw.categoryKeywords);
    data.removedKeywords = {};
    delete data.monthlyIncome; // replaced by income derived from credit transactions

    data.transactions = dedupeIds(data.transactions);
    data.subscriptions = dedupeIds(data.subscriptions);
    data.mortgages = {
      properties: dedupeIds(data.mortgages.properties),
      loans: dedupeIds(data.mortgages.loans),
      payments: dedupeIds(data.mortgages.payments),
    };
    data.netWorth = {
      // Accounts auto-created together on import could share an ID and therefore share snapshots.
      // Statement PDFs (the main snapshot source) are US Bank only, so that account keeps them.
      accounts: dedupeIds(data.netWorth.accounts, (a) => a.linkedBankProfile === 'usbank_checking'),
      snapshots: dedupeIds(data.netWorth.snapshots),
    };
  }

  data.version = SCHEMA_VERSION;
  return data;
}
