import { describe, it, expect } from 'vitest';
import { migrateData, dedupeIds, SCHEMA_VERSION } from './migrate';

const v1 = () => ({
  monthlyIncome: 5000,
  subscriptions: [],
  transactions: [{ id: 'tx_1', name: 'A' }, { id: 'tx_1', name: 'B' }],
  budgets: { dining: 300 },
  bankProfiles: {},
  // Snapshot of the defaults from first launch, plus one keyword the user added
  categoryKeywords: {
    transport: ['gas', 'uber', 'auto'],
    food: ['grocery', 'uber eats'],
    utilities: ['internet', 'electric'],
    subscriptions: ['subscription', 'membership'],
    groceries: ['corner market'],
  },
  mortgages: { properties: [], loans: [], payments: [{ id: 'mpay_1' }, { id: 'mpay_1' }] },
  netWorth: {
    accounts: [
      { id: 'acct_9', name: 'American Express', linkedBankProfile: 'amex_credit' },
      { id: 'acct_9', name: 'US Bank Checking', linkedBankProfile: 'usbank_checking' },
      { id: 'acct_9', name: 'Discover', linkedBankProfile: 'discover_credit' },
    ],
    snapshots: [{ id: 'snap_1', accountId: 'acct_9' }, { id: 'snap_1', accountId: 'acct_9' }],
  },
});

describe('migrateData v1 → v2', () => {
  it('keeps only user-added keywords from the stored snapshot', () => {
    const data = migrateData(v1());
    expect(data.categoryKeywords).toEqual({ groceries: ['corner market'] });
    expect(data.removedKeywords).toEqual({});
  });

  it('gives every record a unique ID', () => {
    const data = migrateData(v1());
    for (const list of [data.transactions, data.mortgages.payments, data.netWorth.accounts, data.netWorth.snapshots]) {
      expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    }
  });

  it('lets the US Bank account keep a shared account ID (and its snapshots)', () => {
    const { accounts } = migrateData(v1()).netWorth;
    expect(accounts.find((a) => a.id === 'acct_9').name).toBe('US Bank Checking');
    expect(accounts.map((a) => a.name)).toEqual(['American Express', 'US Bank Checking', 'Discover']);
  });

  it('drops the retired monthlyIncome field and stamps the version', () => {
    const data = migrateData(v1());
    expect(data).not.toHaveProperty('monthlyIncome');
    expect(data.version).toBe(SCHEMA_VERSION);
    expect(data.budgets).toEqual({ dining: 300 });
  });

  it('leaves current-version data alone', () => {
    const current = migrateData(v1());
    expect(migrateData(current)).toEqual(current);
  });

  it('fills in sections missing from partial data', () => {
    const data = migrateData({ transactions: [] });
    expect(data.mortgages).toEqual({ properties: [], loans: [], payments: [] });
    expect(data.netWorth).toEqual({ accounts: [], snapshots: [] });
  });
});

describe('dedupeIds', () => {
  it('renames later duplicates without colliding with existing IDs', () => {
    const result = dedupeIds([{ id: 'x' }, { id: 'x' }, { id: 'x_1' }]);
    expect(result.map((r) => r.id)).toEqual(['x', 'x_2', 'x_1']);
  });
});
