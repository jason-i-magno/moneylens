import { describe, it, expect } from 'vitest';
import {
  applySyncResult, buildPlaidItem, defaultTargets, plaidSourceOptions, removePlaidItem, setPlaidItemError,
} from './plaidSync';
import { recategorizeStored } from './categorizer';
import { mapPlaidCategory } from '../constants/plaidCategories';
import { createDefaultData } from './migrate';

const checking = { id: 'acc_chk', name: 'Checking', mask: '0000', type: 'depository', subtype: 'checking' };
const savings = { id: 'acc_sav', name: 'Savings', mask: '1111', type: 'depository', subtype: 'savings' };
const card = { id: 'acc_card', name: 'Card', mask: '2222', type: 'credit', subtype: 'credit card' };
const loan = { id: 'acc_loan', name: 'Mortgage', mask: '3333', type: 'loan', subtype: 'mortgage' };

const OPTS = { ids: { tx: 'tx_100', acct: 'acct_100', snap: 'snap_100' }, now: '2026-03-10T12:00:00.000Z', today: '2026-03-10' };

const ptx = (id, overrides = {}) => ({
  id, accountId: 'acc_chk', date: '2026-03-05', amount: 20, name: 'CORNER SHOP', merchantName: null, category: null, ...overrides,
});

const result = (overrides = {}) => ({
  fromCursor: '', nextCursor: 'cursor-1', updateStatus: 'HISTORICAL_UPDATE_COMPLETE',
  added: [], modified: [], removed: [], accounts: [], ...overrides,
});

function dataWith(item, extra = {}) {
  return { ...createDefaultData(), ...extra, plaid: { items: [item] } };
}

function item(targets, transactions = [], accounts = [checking, card, loan]) {
  return buildPlaidItem({ itemId: 'item_1', institutionName: 'Test Bank', env: 'production' }, accounts, targets, transactions);
}

const own = { acc_chk: 'plaid_acc_chk', acc_card: 'plaid_acc_card', acc_loan: null };

describe('defaultTargets', () => {
  it('continues a built-in bank profile when exactly one account fits', () => {
    const targets = defaultTargets([checking, savings, loan], { institutionName: 'U.S. Bank', env: 'production' });
    expect(targets).toEqual({ acc_chk: 'usbank_checking', acc_sav: 'plaid_acc_sav', acc_loan: null });
  });

  it('lets the user choose when two accounts fit, or the profile is taken', () => {
    const card2 = { ...card, id: 'acc_card2' };
    expect(defaultTargets([card, card2], { institutionName: 'American Express', env: 'production' }))
      .toEqual({ acc_card: 'plaid_acc_card', acc_card2: 'plaid_acc_card2' });
    expect(defaultTargets([card], { institutionName: 'Discover', env: 'production', takenTargets: new Set(['discover_credit']) }))
      .toEqual({ acc_card: 'plaid_acc_card' });
  });

  it('never merges sandbox data into a real bank profile', () => {
    expect(defaultTargets([card], { institutionName: 'American Express', env: 'sandbox' })).toEqual({ acc_card: 'plaid_acc_card' });
  });

  it('does not match a bank whose name merely contains the letters', () => {
    expect(defaultTargets([checking], { institutionName: 'Plus Bank', env: 'production' })).toEqual({ acc_chk: 'plaid_acc_chk' });
  });
});

describe('buildPlaidItem', () => {
  it('starts each account after the latest CSV-imported transaction of its source', () => {
    const txs = [
      { importedFrom: 'usbank_checking', source: 'csv_import', date: '2026-03-04' },
      { importedFrom: 'usbank_checking', source: 'csv_import', date: '2026-02-01' },
      { importedFrom: 'amex_credit', source: 'csv_import', date: '2026-03-09' },
    ];
    const built = item({ acc_chk: 'usbank_checking', acc_card: 'plaid_acc_card', acc_loan: null }, txs);
    expect(built.accounts.map((a) => [a.target, a.startDate])).toEqual([
      ['usbank_checking', '2026-03-04'], ['plaid_acc_card', null], [null, null],
    ]);
    expect(built).toMatchObject({ itemId: 'item_1', cursor: '', lastSyncAt: null });
  });
});

describe('applySyncResult', () => {
  it('adds transactions with Plaid sign convention, categories and source', () => {
    const data = dataWith(item(own));
    const next = applySyncResult(data, 'item_1', result({
      added: [
        ptx('p1', { amount: 42.5, name: 'WHOLE FOODS #1234' }),
        ptx('p2', { amount: -1500, name: 'EMPLOYER PAYROLL', category: 'INCOME_WAGES' }),
        ptx('p3', { accountId: 'acc_card', amount: 30, name: 'SHELL OIL 5555', category: 'TRANSPORTATION_GAS' }),
        ptx('p4', { amount: 15.49, name: 'SQ *HK 4421', merchantName: 'Netflix' }),
        ptx('p5', { amount: 5, name: 'STARBUCKS 99', category: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' }),
      ],
    }), OPTS);

    expect(next.transactions.map((t) => [t.plaidTransactionId, t.type, t.amount, t.category, t.isSubscription])).toEqual([
      ['p1', 'debit', 42.5, 'groceries', false],
      ['p2', 'credit', 1500, 'other', false],
      ['p3', 'debit', 30, 'transport', false], // no keyword: Plaid's category fills in
      ['p4', 'debit', 15.49, 'entertainment', true], // keyword found in the merchant name
      ['p5', 'debit', 5, 'dining', false], // a keyword beats Plaid's category
    ]);
    expect(next.transactions[0]).toEqual({
      id: 'tx_100_0', name: 'WHOLE FOODS #1234', amount: 42.5, type: 'debit', date: '2026-03-05',
      category: 'groceries', isSubscription: false, source: 'plaid', importedFrom: 'plaid_acc_chk',
      plaidTransactionId: 'p1', plaidAccountId: 'acc_chk', importedAt: OPTS.now, createdAt: '2026-03-05T00:00:00Z',
    });
    expect(next.plaid.items[0]).toMatchObject({
      cursor: 'cursor-1', lastSyncAt: OPTS.now, lastError: null, historyStatus: 'HISTORICAL_UPDATE_COMPLETE',
      lastSummary: { added: 5, updated: 0, removed: 0, skipped: 0, balances: 0 },
    });
  });

  it('ignores accounts that are not synced', () => {
    const next = applySyncResult(dataWith(item(own)), 'item_1', result({
      added: [ptx('p1', { accountId: 'acc_loan' })],
      accounts: [{ ...loan, balance: 250000 }],
    }), OPTS);
    expect(next.transactions).toEqual([]);
    expect(next.netWorth.accounts).toEqual([]);
  });

  it('is idempotent: a result for an old cursor changes nothing', () => {
    const once = applySyncResult(dataWith(item(own)), 'item_1', result({ added: [ptx('p1')] }), OPTS);
    expect(applySyncResult(once, 'item_1', result({ added: [ptx('p1')] }), OPTS)).toBe(once);
    expect(once.transactions).toHaveLength(1);
  });

  it('updates modified transactions but keeps the category the user chose', () => {
    let data = applySyncResult(dataWith(item(own)), 'item_1', result({ added: [ptx('p1')] }), OPTS);
    data = { ...data, transactions: data.transactions.map((t) => ({ ...t, category: 'health' })) };
    const next = applySyncResult(data, 'item_1', result({
      fromCursor: 'cursor-1', nextCursor: 'cursor-2', modified: [ptx('p1', { amount: 25, date: '2026-03-06' })],
    }), OPTS);
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0]).toMatchObject({ amount: 25, date: '2026-03-06', category: 'health' });
    expect(next.plaid.items[0].lastSummary).toMatchObject({ added: 0, updated: 1 });
  });

  it('deletes transactions Plaid removed', () => {
    const data = applySyncResult(dataWith(item(own)), 'item_1', result({ added: [ptx('p1'), ptx('p2')] }), OPTS);
    const next = applySyncResult(data, 'item_1', result({ fromCursor: 'cursor-1', nextCursor: 'cursor-2', removed: ['p1', 'unknown'] }), OPTS);
    expect(next.transactions.map((t) => t.plaidTransactionId)).toEqual(['p2']);
    expect(next.plaid.items[0].lastSummary.removed).toBe(1);
  });

  it('skips what CSV imports already cover', () => {
    const csv = [
      { id: 'tx_1', importedFrom: 'usbank_checking', source: 'csv_import', type: 'debit', date: '2026-03-04', amount: 20, name: 'CORNER SHOP' },
      { id: 'tx_2', importedFrom: 'usbank_checking', source: 'csv_import', type: 'debit', date: '2026-03-04', amount: 20, name: 'CORNER SHOP' },
      { id: 'tx_3', importedFrom: 'usbank_checking', source: 'csv_import', type: 'debit', date: '2026-03-01', amount: 9, name: 'OLD' },
    ];
    const targets = { acc_chk: 'usbank_checking', acc_card: null, acc_loan: null };
    const data = dataWith(item(targets, csv), { transactions: csv });
    const next = applySyncResult(data, 'item_1', result({
      added: [
        ptx('old', { date: '2026-03-01', amount: 9 }), // before the start date
        ptx('dup1', { date: '2026-03-04' }), ptx('dup2', { date: '2026-03-04' }), // both already in the CSV
        ptx('extra', { date: '2026-03-04' }), // a third identical charge the CSV didn't have
        ptx('other', { date: '2026-03-04', amount: 7 }), // same day, different amount
        ptx('new', { date: '2026-03-05' }),
      ],
    }), OPTS);
    const synced = next.transactions.filter((t) => t.source === 'plaid');
    expect(synced.map((t) => t.plaidTransactionId)).toEqual(['extra', 'other', 'new']);
    expect(synced.every((t) => t.importedFrom === 'usbank_checking')).toBe(true);
    expect(next.plaid.items[0].lastSummary).toMatchObject({ added: 3, skipped: 3 });
  });

  it('records balances as snapshots on new or existing Net Worth accounts', () => {
    const targets = { acc_chk: 'usbank_checking', acc_card: 'plaid_acc_card', acc_loan: null };
    const existing = { id: 'acct_1', name: 'US Bank Checking', type: 'asset', category: 'bank', linkedBankProfile: 'usbank_checking' };
    const data = dataWith(item(targets), { netWorth: { accounts: [existing], snapshots: [] } });
    const next = applySyncResult(data, 'item_1', result({
      accounts: [{ ...checking, balance: 1234.567 }, { ...card, balance: 300 }, { ...loan, balance: 250000 }],
    }), OPTS);

    expect(next.netWorth.accounts).toEqual([
      existing,
      { id: 'acct_100_0', name: 'Test Bank Card ••2222', type: 'liability', category: 'debt', linkedBankProfile: 'plaid_acc_card', createdAt: OPTS.now },
    ]);
    expect(next.netWorth.snapshots.map((s) => [s.accountId, s.date, s.balance, s.source])).toEqual([
      ['acct_1', '2026-03-10', 1234.57, 'plaid'],
      ['acct_100_0', '2026-03-10', 300, 'plaid'],
    ]);

    // A later sync the same day replaces Plaid's snapshot instead of adding another
    const again = applySyncResult(next, 'item_1', result({
      fromCursor: 'cursor-1', nextCursor: 'cursor-2', accounts: [{ ...checking, balance: 1200 }],
    }), { ...OPTS, ids: { tx: 'tx_200', acct: 'acct_200', snap: 'snap_200' } });
    expect(again.netWorth.snapshots.filter((s) => s.accountId === 'acct_1').map((s) => s.balance)).toEqual([1200]);
  });

  it('never overwrites a balance the user entered for the same day', () => {
    const existing = { id: 'acct_1', name: 'X', type: 'asset', category: 'bank', linkedBankProfile: 'plaid_acc_chk' };
    const manual = { id: 'snap_1', accountId: 'acct_1', date: '2026-03-10', balance: 999, source: 'manual' };
    const data = dataWith(item(own), { netWorth: { accounts: [existing], snapshots: [manual] } });
    const next = applySyncResult(data, 'item_1', result({ accounts: [{ ...checking, balance: 1000 }] }), OPTS);
    expect(next.netWorth.snapshots).toEqual([manual]);
  });
});

describe('removePlaidItem', () => {
  const synced = () => {
    const targets = { acc_chk: 'usbank_checking', acc_card: 'plaid_acc_card', acc_loan: null };
    const existing = { id: 'acct_1', name: 'US Bank Checking', type: 'asset', category: 'bank', linkedBankProfile: 'usbank_checking' };
    const csv = { id: 'tx_1', importedFrom: 'usbank_checking', source: 'csv_import', type: 'debit', date: '2026-01-01', amount: 5, name: 'CSV' };
    const data = dataWith(item(targets, [csv]), { transactions: [csv], netWorth: { accounts: [existing], snapshots: [] } });
    return applySyncResult(data, 'item_1', result({
      added: [ptx('p1'), ptx('p2', { accountId: 'acc_card' })],
      accounts: [{ ...checking, balance: 100 }, { ...card, balance: 50 }],
    }), OPTS);
  };

  it('keeps synced data by default', () => {
    const next = removePlaidItem(synced(), 'item_1');
    expect(next.plaid.items).toEqual([]);
    expect(next.transactions).toHaveLength(3);
    expect(next.netWorth.accounts).toHaveLength(2);
  });

  it('can delete what the connection synced, keeping CSV data and profile accounts', () => {
    const next = removePlaidItem(synced(), 'item_1', { deleteSyncedData: true });
    expect(next.transactions.map((t) => t.id)).toEqual(['tx_1']);
    expect(next.netWorth.accounts.map((a) => a.id)).toEqual(['acct_1']);
    expect(next.netWorth.snapshots.map((s) => s.accountId)).toEqual(['acct_1']);
  });
});

describe('setPlaidItemError and plaidSourceOptions', () => {
  it('records an error on one item', () => {
    const next = setPlaidItemError(dataWith(item(own)), 'item_1', { code: 'ITEM_LOGIN_REQUIRED', message: 'Log in again' });
    expect(next.plaid.items[0].lastError.code).toBe('ITEM_LOGIN_REQUIRED');
  });

  it('lists only Bank Sync sources, labelled for pickers', () => {
    const targets = { acc_chk: 'usbank_checking', acc_card: 'plaid_acc_card', acc_loan: null };
    expect(plaidSourceOptions({ items: [item(targets)] })).toEqual([['plaid_acc_card', { name: 'Test Bank Card ••2222 (Bank Sync)' }]]);
  });
});

describe('Plaid categories', () => {
  it.each([
    ['FOOD_AND_DRINK_GROCERIES', 'groceries'],
    ['FOOD_AND_DRINK_RESTAURANT', 'dining'],
    ['LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', 'transfers'],
    ['TRANSFER_OUT_SAVINGS', 'transfers'],
    ['TRANSFER_IN_DEPOSIT', null], // could be income: left to keywords
    ['TRANSFER_OUT_ACCOUNT_TRANSFER', null],
    ['ENTERTAINMENT_CASINOS_AND_GAMBLING', 'betting'],
    ['MEDICAL_VETERINARY_SERVICES', 'other'],
    ['RENT_AND_UTILITIES_RENT', 'housing'],
    ['RENT_AND_UTILITIES_TELEPHONE', 'utilities'],
    [null, null],
  ])('%s → %s', (detailed, expected) => {
    expect(mapPlaidCategory(detailed)).toBe(expected);
  });

  it('recategorizeStored treats CSV rows exactly as before', () => {
    expect(recategorizeStored([{ name: 'WHOLE FOODS #1234' }, { name: 'MYSTERY' }])).toEqual([
      { category: 'groceries', isSubscription: false },
      { category: 'other', isSubscription: false },
    ]);
  });
});
