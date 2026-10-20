import { describe, it, expect } from 'vitest';
import { buildBalanceTimeline, balanceEffect } from './netWorth';

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
