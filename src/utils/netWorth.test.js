import { describe, it, expect } from 'vitest';
import { buildBalanceTimeline, buildNetWorthHistory, balanceEffect } from './netWorth';

const tx = (date, amount, type, importedFrom = 'bank') => ({ date, amount, type, importedFrom });

describe('balanceEffect', () => {
  it('credits grow assets, debits grow liabilities', () => {
    expect(balanceEffect(tx('2026-01-01', 100, 'credit'), 'asset')).toBe(100);
    expect(balanceEffect(tx('2026-01-01', 100, 'debit'), 'asset')).toBe(-100);
    expect(balanceEffect(tx('2026-01-01', 100, 'debit'), 'liability')).toBe(100);
    expect(balanceEffect(tx('2026-01-01', 100, 'credit'), 'liability')).toBe(-100);
  });
});

describe('buildBalanceTimeline', () => {
  const checking = { id: 'a1', type: 'asset', linkedBankProfile: 'bank' };
  const card = { id: 'c1', type: 'liability', linkedBankProfile: 'card' };

  it('returns nothing without a snapshot', () => {
    expect(buildBalanceTimeline(checking, [], [tx('2026-01-05', 10, 'debit')])).toEqual([]);
  });

  it('projects a checking account forward and backward from snapshots', () => {
    const snapshots = [{ accountId: 'a1', date: '2026-01-10', balance: 1000 }];
    const txs = [
      tx('2026-01-05', 200, 'debit'),
      tx('2026-01-10', 50, 'debit'), // already reflected in the end-of-day snapshot
      tx('2026-01-12', 500, 'credit'),
      tx('2026-01-15', 100, 'debit'),
      tx('2026-01-12', 999, 'credit', 'other_bank'), // different account — ignored
    ];
    expect(buildBalanceTimeline(checking, snapshots, txs)).toEqual([
      { date: '2026-01-05', balance: 1050 }, // end of Jan 5: 1000 + 50 (undo Jan 10)
      { date: '2026-01-10', balance: 1000 },
      { date: '2026-01-12', balance: 1500 },
      { date: '2026-01-15', balance: 1400 },
    ]);
  });

  it('moves a credit card balance up with charges and down with payments', () => {
    const snapshots = [{ accountId: 'c1', date: '2026-03-31', balance: 1500 }];
    const txs = [
      tx('2026-04-02', 100, 'debit', 'card'),
      tx('2026-04-05', 1500, 'credit', 'card'),
    ];
    expect(buildBalanceTimeline(card, snapshots, txs)).toEqual([
      { date: '2026-03-31', balance: 1500 },
      { date: '2026-04-02', balance: 1600 },
      { date: '2026-04-05', balance: 100 },
    ]);
  });

  it('fills gaps between snapshots and lets each snapshot reset the running balance', () => {
    const snapshots = [
      { accountId: 'a1', date: '2026-01-31', balance: 1000 },
      { accountId: 'a1', date: '2026-02-28', balance: 2000 },
    ];
    const txs = [tx('2026-02-10', 300, 'credit'), tx('2026-03-03', 100, 'debit')];
    expect(buildBalanceTimeline(checking, snapshots, txs)).toEqual([
      { date: '2026-01-31', balance: 1000 },
      { date: '2026-02-10', balance: 1300 },
      { date: '2026-02-28', balance: 2000 },
      { date: '2026-03-03', balance: 1900 },
    ]);
  });

  it('uses only snapshots for accounts without a linked bank profile', () => {
    const savings = { id: 's1', type: 'asset' };
    const snapshots = [{ accountId: 's1', date: '2026-01-31', balance: 5000 }];
    expect(buildBalanceTimeline(savings, snapshots, [tx('2026-02-01', 1, 'debit')])).toEqual([
      { date: '2026-01-31', balance: 5000 },
    ]);
  });
});

describe('buildNetWorthHistory', () => {
  const checking = { id: 'acct_1', type: 'asset' };
  const card = { id: 'acct_2', type: 'liability' };
  const timelines = {
    acct_1: [
      { date: '2024-06-03', balance: 20000 },
      { date: '2024-06-13', balance: 125000 }, // closing money gathered
      { date: '2024-06-14', balance: 5000 }, // cash to close wired out
      { date: '2024-08-03', balance: 6000 },
    ],
    acct_2: [{ date: '2024-06-10', balance: 1000 }],
  };
  const mortgages = {
    properties: [{ id: 'prop_1', purchaseDate: '2024-06-14', purchasePrice: 520000, estimatedValue: 500000 }],
    loans: [{ id: 'loan_1', closingDate: '2024-06-14', startDate: '2024-07-01', loanAmount: 400000, status: 'paid_off', payoffDate: '2024-09-15' }],
    payments: [
      { loanId: 'loan_1', date: '2024-08-02', forMonth: '2024-08', balanceAfter: 399000 },
      { loanId: 'loan_1', forMonth: '2024-09', balanceAfter: 398000 }, // no payment date: the 1st of the month
    ],
  };
  const history = buildNetWorthHistory([checking, card], timelines, mortgages);
  const at = (date) => history.find((r) => r.date === date);

  it('adds the house and its mortgage on the closing day, not the start of the month', () => {
    expect(at('2024-06-10')).toEqual({ date: '2024-06-10', assets: 20000, liabilities: 1000, netWorth: 19000 });
    expect(at('2024-06-13').netWorth).toBe(124000);
    expect(at('2024-06-14')).toEqual({ date: '2024-06-14', assets: 505000, liabilities: 401000, netWorth: 104000 });
    expect(history.map((r) => r.date)).not.toContain('2024-06');
  });

  it('follows mortgage payments on their dates and a payoff', () => {
    expect(at('2024-08-02').liabilities).toBe(400000);
    expect(at('2024-08-02').netWorth).toBe(500000 + 5000 - 1000 - 399000);
    expect(at('2024-09-01').netWorth).toBe(500000 + 6000 - 1000 - 398000);
    expect(at('2024-09-15').liabilities).toBe(1000);
  });

  it('swaps the loans of a refinance on one day, never owing both', () => {
    const accounts = [{ id: 'acct_1', type: 'asset' }];
    const days = ['2024-11-01', '2024-11-04', '2024-11-06', '2024-11-08', '2024-11-12'].map((date) => ({ date, balance: 10000 }));
    const old = { id: 'loan_old', closingDate: '2024-01-10', loanAmount: 300000, status: 'paid_off', payoffDate: '2024-11-08' };
    const refi = { id: 'loan_new', closingDate: '2024-11-04', startDate: '2024-12-01', loanAmount: 290000, status: 'active', refinancesLoanId: 'loan_old' };
    const debt = (loans) => Object.fromEntries(buildNetWorthHistory(accounts, { acct_1: days }, { properties: [], loans, payments: [] })
      .filter((r) => r.date >= '2024-11-01').map((r) => [r.date, r.liabilities]));
    // Signed on the 4th, funded and the old loan paid off on the 8th
    expect(debt([old, refi])).toEqual({ '2024-11-01': 300000, '2024-11-04': 300000, '2024-11-06': 300000, '2024-11-08': 290000, '2024-11-12': 290000 });
    // Without a payoff date the old loan ends when the new one closes
    expect(debt([{ ...old, payoffDate: null }, refi])).toEqual({ '2024-11-01': 300000, '2024-11-04': 290000, '2024-11-06': 290000, '2024-11-08': 290000, '2024-11-12': 290000 });
  });

  it('counts a property without a purchase date from the start', () => {
    const rows = buildNetWorthHistory([checking], timelines, { properties: [{ estimatedValue: 300000 }], loans: [], payments: [] });
    expect(rows[0]).toEqual({ date: '2024-06-03', assets: 320000, liabilities: 0, netWorth: 320000 });
  });
});
