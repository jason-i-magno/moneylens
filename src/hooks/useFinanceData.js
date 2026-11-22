import { useState, useCallback, useEffect, useRef } from 'react';
import { createDefaultData, migrateData } from '../utils/migrate';
import { makeId } from '../utils/ids';
import { todayISO } from '../utils/dates';
import { applySyncResult, removePlaidItem as removeItem, setPlaidItemError as setItemError } from '../utils/plaidSync';
import { applyTransactionEdit } from '../utils/transactions';

const CONFLICT_NOTICE = 'This was changed in another window, so the latest is shown here. Your last change in this window wasn\u2019t saved.';

// store: from openStorage (src/utils/storage.js): this browser's storage or MoneyLens's server
export function useFinanceData(store) {
  const [data, setData] = useState(store.initialData);
  // What the store already has, so data that came from it isn't sent back
  const stored = useRef(store.initialData);
  const [saveState, setSaveState] = useState(store.state || { status: 'saved' });
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (data === stored.current) return;
    stored.current = data;
    store.save(data);
  }, [data, store]);

  useEffect(() => store.onState(setSaveState), [store]);

  // Data saved by another window replaces this one's
  useEffect(() => store.subscribe(({ data: next, reason }) => {
    stored.current = next;
    setData(next);
    if (reason === 'conflict') setNotice(CONFLICT_NOTICE);
  }), [store]);

  useEffect(() => {
    const warn = (e) => {
      if (!store.hasUnsaved()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [store]);

  // Replaces everything and resolves once it's saved (callers reload the page afterwards)
  const replaceData = useCallback(async (next, note) => {
    stored.current = next;
    setData(next);
    await store.save(next, note);
  }, [store]);

  const update = useCallback((updater) => {
    setData((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      return next;
    });
  }, []);

  // Subscriptions
  const addSubscription = useCallback((sub) => {
    const newSub = { ...sub, id: makeId('sub'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, subscriptions: [...d.subscriptions, newSub] }));
  }, [update]);

  const updateSubscription = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      subscriptions: d.subscriptions.map((s) => (s.id === id ? { ...s, ...changes } : s)),
    }));
  }, [update]);

  const deleteSubscription = useCallback((id) => {
    update((d) => ({ ...d, subscriptions: d.subscriptions.filter((s) => s.id !== id) }));
  }, [update]);

  // Transactions
  const addTransaction = useCallback((tx) => {
    const newTx = {
      ...tx,
      id: makeId('tx'),
      source: 'manual',
      createdAt: new Date().toISOString(),
    };
    update((d) => ({ ...d, transactions: [...d.transactions, newTx] }));
  }, [update]);

  // From the edit form; see applyTransactionEdit
  const updateTransaction = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      transactions: d.transactions.map((t) => (t.id === id ? applyTransactionEdit(t, changes) : t)),
    }));
  }, [update]);

  // changesById: { [txId]: { ...fields } }
  const updateTransactions = useCallback((changesById) => {
    update((d) => ({
      ...d,
      transactions: d.transactions.map((t) => (changesById[t.id] ? { ...t, ...changesById[t.id] } : t)),
    }));
  }, [update]);

  const deleteTransaction = useCallback((id) => {
    update((d) => ({ ...d, transactions: d.transactions.filter((t) => t.id !== id) }));
  }, [update]);

  // Each tx carries the profileId of the file it came from ('' for an unsaved manual mapping)
  const importTransactions = useCallback((txList) => {
    const batchId = makeId('tx');
    const importedAt = new Date().toISOString();
    const newTxs = txList.map((tx, i) => ({
      id: `${batchId}_${i}`,
      name: tx.description,
      amount: tx.amount,
      category: tx.category,
      type: tx.isDebit ? 'debit' : 'credit',
      isSubscription: tx.isSubscription || false,
      ...(tx.categorySetByUser && { categorySetByUser: true }), // picked in the import preview
      date: tx.date,
      source: 'csv_import',
      importedFrom: tx.profileId || 'manual',
      importedAt,
      createdAt: tx.date + 'T00:00:00Z',
    }));
    update((d) => ({ ...d, transactions: [...d.transactions, ...newTxs] }));
    return newTxs.length;
  }, [update]);

  // Budgets
  const setBudget = useCallback((categoryId, amount) => {
    update((d) => ({ ...d, budgets: { ...d.budgets, [categoryId]: amount } }));
  }, [update]);

  const deleteBudget = useCallback((categoryId) => {
    update((d) => {
      const budgets = { ...d.budgets };
      delete budgets[categoryId];
      return { ...d, budgets };
    });
  }, [update]);

  // Category Keywords — only overrides of the code defaults are stored
  const setKeywordOverrides = useCallback((added, removed) => {
    update((d) => ({ ...d, categoryKeywords: added, removedKeywords: removed }));
  }, [update]);

  // Bank Profiles
  const saveBankProfile = useCallback((id, profile) => {
    update((d) => ({ ...d, bankProfiles: { ...d.bankProfiles, [id]: profile } }));
  }, [update]);

  const deleteBankProfile = useCallback((id) => {
    update((d) => {
      const bankProfiles = { ...d.bankProfiles };
      delete bankProfiles[id];
      return { ...d, bankProfiles };
    });
  }, [update]);

  // Mortgage - Properties
  const addProperty = useCallback((prop) => {
    const newProp = { ...prop, id: makeId('prop'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, mortgages: { ...d.mortgages, properties: [...d.mortgages.properties, newProp] } }));
    return newProp.id;
  }, [update]);

  const updateProperty = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      mortgages: { ...d.mortgages, properties: d.mortgages.properties.map((p) => (p.id === id ? { ...p, ...changes } : p)) },
    }));
  }, [update]);

  // A property's tax appeal details (property.tax), merged so quick edits don't overwrite each other
  const updatePropertyTax = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      mortgages: { ...d.mortgages, properties: d.mortgages.properties.map((p) => (p.id === id ? { ...p, tax: { ...p.tax, ...changes } } : p)) },
    }));
  }, [update]);

  const deleteProperty = useCallback((id) => {
    update((d) => ({
      ...d,
      mortgages: {
        ...d.mortgages,
        properties: d.mortgages.properties.filter((p) => p.id !== id),
        loans: d.mortgages.loans.map((l) => (l.propertyId === id ? { ...l, propertyId: '' } : l)),
      },
    }));
  }, [update]);

  // Mortgage - Loans
  const addLoan = useCallback((loan) => {
    const newLoan = { ...loan, id: makeId('loan'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, mortgages: { ...d.mortgages, loans: [...d.mortgages.loans, newLoan] } }));
    return newLoan.id;
  }, [update]);

  const updateLoan = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      mortgages: { ...d.mortgages, loans: d.mortgages.loans.map((l) => (l.id === id ? { ...l, ...changes } : l)) },
    }));
  }, [update]);

  const deleteLoan = useCallback((id) => {
    update((d) => ({
      ...d,
      mortgages: {
        ...d.mortgages,
        loans: d.mortgages.loans.filter((l) => l.id !== id),
        payments: d.mortgages.payments.filter((p) => p.loanId !== id),
      },
    }));
  }, [update]);

  // Mortgage - Payments
  const addMortgagePayment = useCallback((payment) => {
    const newPay = { ...payment, id: makeId('mpay'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, mortgages: { ...d.mortgages, payments: [...d.mortgages.payments, newPay] } }));
  }, [update]);

  const deleteMortgagePayment = useCallback((id) => {
    update((d) => ({ ...d, mortgages: { ...d.mortgages, payments: d.mortgages.payments.filter((p) => p.id !== id) } }));
  }, [update]);

  // Each payment carries its own loanId
  const importMortgagePayments = useCallback((paymentsList) => {
    const batchId = makeId('mpay');
    const createdAt = new Date().toISOString();
    const newPays = paymentsList.map((p, i) => ({
      ...p,
      id: `${batchId}_${i}`,
      source: p.source || 'pdf_import',
      createdAt,
    }));
    update((d) => ({ ...d, mortgages: { ...d.mortgages, payments: [...d.mortgages.payments, ...newPays] } }));
    return newPays.length;
  }, [update]);

  const importMortgageData = useCallback((mortgageJson) => {
    const { properties = [], loans = [], payments = [] } = mortgageJson;
    update((d) => ({ ...d, mortgages: { properties, loans, payments } }));
  }, [update]);

  // Net Worth - Accounts
  const addAccount = useCallback((acct) => {
    const newAcct = { ...acct, id: makeId('acct'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, netWorth: { ...d.netWorth, accounts: [...d.netWorth.accounts, newAcct] } }));
    return newAcct.id;
  }, [update]);

  const updateAccount = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      netWorth: { ...d.netWorth, accounts: d.netWorth.accounts.map((a) => (a.id === id ? { ...a, ...changes } : a)) },
    }));
  }, [update]);

  const deleteAccount = useCallback((id) => {
    update((d) => ({
      ...d,
      netWorth: {
        ...d.netWorth,
        accounts: d.netWorth.accounts.filter((a) => a.id !== id),
        snapshots: d.netWorth.snapshots.filter((s) => s.accountId !== id),
      },
    }));
  }, [update]);

  // Net Worth - Snapshots
  const addSnapshots = useCallback((snapList) => {
    const batchId = makeId('snap');
    const createdAt = new Date().toISOString();
    const newSnaps = snapList.map((s, i) => ({ ...s, id: `${batchId}_${i}`, createdAt }));
    update((d) => ({ ...d, netWorth: { ...d.netWorth, snapshots: [...d.netWorth.snapshots, ...newSnaps] } }));
  }, [update]);

  // A balance history for one account: each date replaces that account's balance on the same date
  const importSnapshots = useCallback((accountId, balances, source) => {
    const batchId = makeId('snap');
    const createdAt = new Date().toISOString();
    const dates = new Set(balances.map((b) => b.date));
    const newSnaps = balances.map((b, i) => ({ accountId, date: b.date, balance: b.balance, source, id: `${batchId}_${i}`, createdAt }));
    update((d) => ({
      ...d,
      netWorth: {
        ...d.netWorth,
        snapshots: [...d.netWorth.snapshots.filter((s) => s.accountId !== accountId || !dates.has(s.date)), ...newSnaps],
      },
    }));
  }, [update]);

  // Net Worth projection settings: changes merge into data.netWorth.projection; undefined removes one
  // (back to its default or the figure worked out from the data)
  const setProjectionSettings = useCallback((changes) => {
    update((d) => {
      const projection = { ...(d.netWorth.projection || {}), ...changes };
      for (const key of Object.keys(projection)) if (projection[key] === undefined || projection[key] === null) delete projection[key];
      return { ...d, netWorth: { ...d.netWorth, projection } };
    });
  }, [update]);

  const deleteSnapshot = useCallback((id) => {
    update((d) => ({ ...d, netWorth: { ...d.netWorth, snapshots: d.netWorth.snapshots.filter((s) => s.id !== id) } }));
  }, [update]);

  // HSA receipt vault (data.hsa.receipts; absent until the first receipt). The files live on the local server.
  const addReceipt = useCallback((receipt) => {
    const newReceipt = { ...receipt, id: makeId('rcpt'), createdAt: new Date().toISOString() };
    update((d) => ({ ...d, hsa: { ...d.hsa, receipts: [...(d.hsa?.receipts || []), newReceipt] } }));
    return newReceipt.id;
  }, [update]);

  const updateReceipt = useCallback((id, changes) => {
    update((d) => ({
      ...d,
      hsa: { ...d.hsa, receipts: (d.hsa?.receipts || []).map((r) => (r.id === id ? { ...r, ...changes } : r)) },
    }));
  }, [update]);

  const deleteReceipt = useCallback((id) => {
    update((d) => ({ ...d, hsa: { ...d.hsa, receipts: (d.hsa?.receipts || []).filter((r) => r.id !== id) } }));
  }, [update]);

  // Bank Sync (Plaid). Items hold each connection's account mapping and sync cursor;
  // the access tokens stay on the local server.
  const savePlaidItem = useCallback((item) => {
    update((d) => ({
      ...d,
      plaid: { ...d.plaid, items: [...d.plaid.items.filter((i) => i.itemId !== item.itemId), item] },
    }));
  }, [update]);

  // IDs and times are made out here: React may run the updater twice
  const applyPlaidSync = useCallback((itemId, result) => {
    const options = {
      ids: { tx: makeId('tx'), acct: makeId('acct'), snap: makeId('snap') },
      now: new Date().toISOString(),
      today: todayISO(),
    };
    update((d) => applySyncResult(d, itemId, result, options));
  }, [update]);

  const setPlaidItemError = useCallback((itemId, error) => {
    update((d) => setItemError(d, itemId, error));
  }, [update]);

  const removePlaidItem = useCallback((itemId, options) => {
    update((d) => removeItem(d, itemId, options));
  }, [update]);

  // Data management
  const exportData = useCallback(() => {
    return JSON.stringify(data, null, 2);
  }, [data]);

  // Resolves false when jsonStr isn't a backup; rejects when the new data couldn't be saved
  const importData = useCallback(async (jsonStr) => {
    let imported;
    try {
      imported = JSON.parse(jsonStr);
    } catch {
      return false;
    }
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return false;
    await replaceData(migrateData(imported), 'Imported a backup');
    return true;
  }, [replaceData]);

  const resetData = useCallback(() => replaceData(createDefaultData(), 'Reset all data'), [replaceData]);

  // Server only: an earlier version becomes the latest (itself a new version, so it can be undone too)
  const restoreVersion = useCallback(async (rev, note) => {
    const version = await store.loadVersion(rev);
    await replaceData(version.data, note);
  }, [store, replaceData]);

  // Local only, while the server's database is empty
  const moveToServer = useCallback(() => store.moveToServer(data), [store, data]);

  return {
    data,
    storage: store,
    saveState,
    notice,
    dismissNotice: () => setNotice(null),
    restoreVersion,
    moveToServer,
    addSubscription,
    updateSubscription,
    deleteSubscription,
    addTransaction,
    updateTransaction,
    updateTransactions,
    deleteTransaction,
    importTransactions,
    setBudget,
    deleteBudget,
    setKeywordOverrides,
    saveBankProfile,
    deleteBankProfile,
    addProperty,
    updateProperty,
    updatePropertyTax,
    deleteProperty,
    addLoan,
    updateLoan,
    deleteLoan,
    addMortgagePayment,
    deleteMortgagePayment,
    importMortgagePayments,
    importMortgageData,
    addAccount,
    updateAccount,
    deleteAccount,
    addSnapshots,
    importSnapshots,
    deleteSnapshot,
    setProjectionSettings,
    addReceipt,
    updateReceipt,
    deleteReceipt,
    savePlaidItem,
    applyPlaidSync,
    setPlaidItemError,
    removePlaidItem,
    exportData,
    importData,
    resetData,
  };
}
