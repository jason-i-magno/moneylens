// Bank Sync (Plaid): pure functions that turn a sync result from the local server into app data.
// Each Plaid account has a `target` — the `importedFrom` value its transactions get — which is
// either a bank profile ID (continuing that bank's CSV history) or its own `plaid_<accountId>`.
import { PLAID_INSTITUTION_PATTERNS, PROFILE_ACCOUNT_MAP } from '../constants/bankProfiles';
import { getEffectiveKeywords, recategorizeStored } from './categorizer';
import { daysBetween } from './dates';
import { roundCents } from './transactions';

export const plaidSourceId = (accountId) => `plaid_${accountId}`;
const isPlaidSource = (target) => typeof target === 'string' && target.startsWith('plaid_');

export const describePlaidAccount = (account) => `${account.name}${account.mask ? ` ••${account.mask}` : ''}`;

// Institution + account, without repeating a bank that already names its accounts after itself
function plaidAccountLabel(institutionName, account) {
  const label = describePlaidAccount(account);
  if (!institutionName || label.toLowerCase().startsWith(institutionName.toLowerCase())) return label;
  return `${institutionName} ${label}`;
}

const NET_WORTH_KIND = {
  depository: { type: 'asset', category: 'bank' },
  credit: { type: 'liability', category: 'debt' },
  loan: { type: 'liability', category: 'debt' },
  investment: { type: 'asset', category: 'investment' },
};

// Loan and investment accounts aren't synced unless the user opts in: a loan's payments would
// count as income, and mortgages are already tracked on the Mortgage page.
const SYNCED_BY_DEFAULT = new Set(['depository', 'credit']);

// Default "Sync into" choice per account of a newly connected bank.
// Sandbox data is fake, so it always gets its own sources and never joins a real bank's history.
export function defaultTargets(accounts, { institutionName, env, takenTargets = new Set() }) {
  const targets = {};
  for (const acct of accounts) {
    targets[acct.id] = SYNCED_BY_DEFAULT.has(acct.type) ? plaidSourceId(acct.id) : null;
  }
  if (env !== 'production') return targets;

  for (const p of PLAID_INSTITUTION_PATTERNS) {
    if (!p.institution.test(institutionName || '') || takenTargets.has(p.profileId)) continue;
    const matches = accounts.filter((a) => a.type === p.accountType && (!p.subtype || a.subtype === p.subtype));
    if (matches.length === 1) targets[matches[0].id] = p.profileId; // two candidates: let the user pick
  }
  return targets;
}

// Latest date already imported (by CSV) into a source; Bank Sync adds what comes after it
export function latestImportedDate(transactions, target) {
  let latest = null;
  for (const tx of transactions) {
    if (tx.importedFrom === target && tx.source !== 'plaid' && (!latest || tx.date > latest)) latest = tx.date;
  }
  return latest;
}

// Earliest date imported by CSV into a source; Bank Sync adds the older history before it
export function earliestImportedDate(transactions, target) {
  let earliest = null;
  for (const tx of transactions) {
    if (tx.importedFrom === target && tx.source !== 'plaid' && (!earliest || tx.date < earliest)) earliest = tx.date;
  }
  return earliest;
}

export function buildPlaidItem({ itemId, institutionName, env }, accounts, targets, transactions) {
  return {
    itemId,
    institutionName,
    env,
    cursor: '',
    lastSyncAt: null,
    lastError: null,
    lastSummary: null,
    historyStatus: null,
    accounts: accounts.map((a) => {
      const target = targets[a.id] || null;
      return {
        id: a.id,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        target,
        startDate: target ? latestImportedDate(transactions, target) : null,
      };
    }),
  };
}

const sameDayKey = (importedFrom, date, type, amount) => `${importedFrom}|${date}|${type}|${amount}`;

function toFields(ptx) {
  return {
    name: ptx.name,
    amount: roundCents(Math.abs(ptx.amount)),
    type: ptx.amount > 0 ? 'debit' : 'credit',
    date: ptx.date,
    ...(ptx.merchantName && { merchantName: ptx.merchantName }),
    ...(ptx.category && { plaidCategory: ptx.category }),
  };
}

const PAIR_WINDOW_DAYS = 3;

// Only uncategorized transfers and rows already marked as transfers are paired, so a category set by
// a keyword or by the user is never overridden.
const UNCATEGORIZED = new Set(['other', 'other_income']);
const canPair = (tx) => !tx.pairedTransfer && !tx.categorySetByUser
  && (tx.category === 'transfers' || (UNCATEGORIZED.has(tx.category) && Boolean(tx.plaidCategory?.startsWith('TRANSFER_'))));

// A move between two accounts of one connection (checking → savings) appears in both. Plaid often
// labels a side as a generic account transfer, which stays uncategorized and would count as income or
// spending. Pairs a debit with a same-amount credit in another of the accounts, closest dates first,
// and makes both transfers. `pairedTransfer` keeps them paired through re-categorizing.
function pairOwnTransfers(transactions, accountIds) {
  const debitsByAmount = new Map();
  const credits = [];
  transactions.forEach((tx, i) => {
    if (tx.source !== 'plaid' || !accountIds.has(tx.plaidAccountId) || !canPair(tx)) return;
    if (tx.type === 'credit') credits.push(i);
    else debitsByAmount.set(tx.amount, [...(debitsByAmount.get(tx.amount) || []), i]);
  });

  const candidates = [];
  for (const c of credits) {
    const credit = transactions[c];
    for (const d of debitsByAmount.get(credit.amount) || []) {
      const debit = transactions[d];
      const gap = Math.abs(daysBetween(debit.date, credit.date));
      if (debit.plaidAccountId !== credit.plaidAccountId && gap <= PAIR_WINDOW_DAYS) candidates.push({ d, c, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);

  const paired = new Set();
  for (const { d, c } of candidates) {
    if (paired.has(d) || paired.has(c)) continue;
    paired.add(d);
    paired.add(c);
  }
  return {
    transactions: paired.size
      ? transactions.map((tx, i) => (paired.has(i) ? { ...tx, category: 'transfers', pairedTransfer: true } : tx))
      : transactions,
    pairs: paired.size / 2,
  };
}

// Applies one sync result. Returns `data` unchanged when the result is stale (the item's cursor has
// moved on, e.g. the same sync ran twice), which makes applying a result idempotent.
// `ids` = { tx, acct, snap } prefixes from makeId; records get `_N` appended.
export function applySyncResult(data, itemId, result, { ids, now, today }) {
  const item = data.plaid.items.find((i) => i.itemId === itemId);
  if (!item || item.cursor !== result.fromCursor) return data;

  const accountsById = new Map(item.accounts.map((a) => [a.id, a]));
  const summary = { added: 0, updated: 0, removed: 0, skipped: 0, paired: 0, balances: 0 };

  const removedIds = new Set(result.removed);
  let transactions = data.transactions.filter((tx) => !(tx.plaidTransactionId && removedIds.has(tx.plaidTransactionId)));
  summary.removed = data.transactions.length - transactions.length;

  const indexByPlaidId = new Map();
  transactions.forEach((tx, i) => {
    if (tx.plaidTransactionId) indexByPlaidId.set(tx.plaidTransactionId, i);
  });

  // An account continuing CSV history: the CSVs cover its first CSV date through `startDate` (the last).
  // Rows inside are already imported and rows before it are older history to add. The two edge days may
  // be only partly covered, so their rows are matched one-for-one against the CSV rows.
  const csvFirst = new Map(); // account id → first CSV date
  const csvOnEdgeDays = new Map();
  for (const acct of item.accounts) {
    if (!acct.target || !acct.startDate) continue;
    const first = earliestImportedDate(transactions, acct.target) || acct.startDate;
    csvFirst.set(acct.id, first);
    for (const tx of transactions) {
      if (tx.importedFrom !== acct.target || tx.source === 'plaid' || (tx.date !== first && tx.date !== acct.startDate)) continue;
      const key = sameDayKey(tx.importedFrom, tx.date, tx.type || 'debit', tx.amount);
      csvOnEdgeDays.set(key, (csvOnEdgeDays.get(key) || 0) + 1);
    }
  }

  const updates = new Map(); // transaction index → changed fields (the user's category is kept)
  const fresh = new Map(); // plaid transaction id → { ptx, acct, fields }
  for (const ptx of [...result.added, ...result.modified]) {
    const acct = accountsById.get(ptx.accountId);
    if (!acct?.target) continue;
    const fields = toFields(ptx);

    const existing = indexByPlaidId.get(ptx.id);
    if (existing !== undefined) {
      updates.set(existing, fields);
      continue;
    }
    if (fresh.has(ptx.id)) {
      fresh.set(ptx.id, { ...fresh.get(ptx.id), fields });
      continue;
    }
    const first = csvFirst.get(acct.id);
    if (first && fields.date > first && fields.date < acct.startDate) {
      summary.skipped++;
      continue;
    }
    if (first && (fields.date === first || fields.date === acct.startDate)) {
      const key = sameDayKey(acct.target, fields.date, fields.type, fields.amount);
      const left = csvOnEdgeDays.get(key) || 0;
      if (left > 0) {
        csvOnEdgeDays.set(key, left - 1);
        summary.skipped++;
        continue;
      }
    }
    fresh.set(ptx.id, { ptx, acct, fields });
  }

  transactions = transactions.map((tx, i) => (updates.has(i) ? { ...tx, ...updates.get(i) } : tx));
  summary.updated = updates.size;

  const keywords = getEffectiveKeywords(data.categoryKeywords, data.removedKeywords);
  const freshList = [...fresh.values()];
  const categorized = recategorizeStored(freshList.map((f) => f.fields), keywords);
  const newTxs = freshList.map(({ ptx, acct, fields }, i) => ({
    id: `${ids.tx}_${i}`,
    ...fields,
    category: categorized[i].category,
    isSubscription: categorized[i].isSubscription,
    source: 'plaid',
    importedFrom: acct.target,
    plaidTransactionId: ptx.id,
    plaidAccountId: ptx.accountId,
    importedAt: now,
    createdAt: `${fields.date}T00:00:00Z`,
  }));
  summary.added = newTxs.length;

  // Earlier syncs' rows take part too: the other side of a transfer can post a day later
  const syncedAccountIds = new Set(item.accounts.filter((a) => a.target).map((a) => a.id));
  const { transactions: allTransactions, pairs } = pairOwnTransfers([...transactions, ...newTxs], syncedAccountIds);
  summary.paired = pairs;

  // Balances become today's snapshot on the Net Worth account linked to the same source
  let nwAccounts = data.netWorth.accounts;
  let snapshots = data.netWorth.snapshots;
  let acctCount = 0;
  let snapCount = 0;
  for (const pa of result.accounts) {
    const acct = accountsById.get(pa.id);
    if (!acct?.target || pa.balance == null) continue;

    let nwAccount = nwAccounts.find((a) => a.linkedBankProfile === acct.target);
    if (!nwAccount) {
      const kind = PROFILE_ACCOUNT_MAP[acct.target] || NET_WORTH_KIND[pa.type] || NET_WORTH_KIND.depository;
      nwAccount = {
        name: PROFILE_ACCOUNT_MAP[acct.target]?.name || plaidAccountLabel(item.institutionName, pa),
        type: kind.type,
        category: kind.category,
        linkedBankProfile: acct.target,
        id: `${ids.acct}_${acctCount++}`,
        createdAt: now,
      };
      nwAccounts = [...nwAccounts, nwAccount];
    }

    const sameDay = snapshots.find((s) => s.accountId === nwAccount.id && s.date === today);
    if (sameDay && sameDay.source !== 'plaid') continue; // a balance the user entered wins
    const balance = roundCents(pa.balance);
    snapshots = sameDay
      ? snapshots.map((s) => (s === sameDay ? { ...s, balance } : s))
      : [...snapshots, { id: `${ids.snap}_${snapCount++}`, accountId: nwAccount.id, date: today, balance, source: 'plaid', createdAt: now }];
    summary.balances++;
  }

  const items = data.plaid.items.map((i) => (i.itemId === itemId
    ? { ...i, cursor: result.nextCursor, lastSyncAt: now, lastError: null, lastSummary: summary, historyStatus: result.updateStatus || null }
    : i));

  return {
    ...data,
    transactions: allTransactions,
    netWorth: { ...data.netWorth, accounts: nwAccounts, snapshots },
    plaid: { ...data.plaid, items },
  };
}

export function setPlaidItemError(data, itemId, error) {
  const items = data.plaid.items.map((i) => (i.itemId === itemId ? { ...i, lastError: error } : i));
  return { ...data, plaid: { ...data.plaid, items } };
}

// Forgets a connection's account mapping. With deleteSyncedData it also deletes the transactions it
// synced and the Net Worth accounts it created (with their balances); accounts that belong to a
// bank profile, like US Bank Checking, are kept.
export function removePlaidItem(data, itemId, { deleteSyncedData = false } = {}) {
  const item = data.plaid.items.find((i) => i.itemId === itemId);
  if (!item) return data;
  const items = data.plaid.items.filter((i) => i.itemId !== itemId);
  if (!deleteSyncedData) return { ...data, plaid: { ...data.plaid, items } };

  const plaidAccountIds = new Set(item.accounts.map((a) => a.id));
  const ownSources = new Set(item.accounts.map((a) => a.target).filter(isPlaidSource));
  const droppedAccounts = new Set(data.netWorth.accounts.filter((a) => ownSources.has(a.linkedBankProfile)).map((a) => a.id));

  return {
    ...data,
    transactions: data.transactions.filter((tx) => !(tx.source === 'plaid' && plaidAccountIds.has(tx.plaidAccountId))),
    netWorth: {
      ...data.netWorth,
      accounts: data.netWorth.accounts.filter((a) => !droppedAccounts.has(a.id)),
      snapshots: data.netWorth.snapshots.filter((s) => !droppedAccounts.has(s.accountId)),
    },
    plaid: { ...data.plaid, items },
  };
}

// Bank Sync sources as [id, { name }] pairs, for "Linked Bank Profile" pickers next to real profiles
export function plaidSourceOptions(plaid) {
  return plaid.items.flatMap((item) => item.accounts
    .filter((a) => isPlaidSource(a.target))
    .map((a) => [a.target, { name: `${plaidAccountLabel(item.institutionName, a)} (Bank Sync)` }]));
}
