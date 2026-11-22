import { describe, it, expect } from 'vitest';
import { missingReceipts, receiptTotals, suggestPayments } from './hsa';

const tx = (id, date, amount, category = 'health', extra = {}) => ({ id, date, amount, category, type: 'debit', name: `PAYMENT ${id}`, ...extra });

describe('receipt totals', () => {
  it('adds up what can still be reimbursed, what is unsure, and what has been reimbursed', () => {
    const receipts = [
      { id: 'a', amount: 45, eligible: 'yes' },
      { id: 'b', amount: 20.1, eligible: 'unsure' },
      { id: 'c', amount: 99, eligible: 'no' },
      { id: 'd', amount: 300, eligible: 'yes', reimbursedAt: '2026-06-01', reimbursedAmount: 250 },
      { id: 'e', amount: 10.2, eligible: 'yes', reimbursedAt: '2026-06-01' },
    ];
    expect(receiptTotals(receipts)).toEqual({ reimbursable: 65.1, unsure: 20.1, reimbursed: 260.2, count: 5 });
    expect(receiptTotals([])).toEqual({ reimbursable: 0, unsure: 0, reimbursed: 0, count: 0 });
  });
});

describe('suggested payments', () => {
  const transactions = [
    tx('t1', '2026-10-20', 45),
    tx('t2', '2026-10-05', 45, 'shopping'),
    tx('t3', '2026-09-20', 45), // a week and a half before the visit: too early
    tx('t4', '2027-05-01', 45), // more than six months after: too late
    tx('t5', '2026-10-03', 45.01),
    tx('t6', '2026-10-04', 45, 'health', { type: 'credit' }), // a refund, not a payment
    tx('t7', '2026-10-10', 45, 'transfers'),
    tx('t8', '2026-10-02', 45),
  ];
  const receipt = { id: 'r1', amount: 45, serviceDate: '2026-10-02' };

  it('offers same-amount payments around the service date, health ones first, closest first', () => {
    expect(suggestPayments(receipt, transactions, [receipt], '2026-11-21').map((t) => t.id)).toEqual(['t8', 't1', 't2']);
  });

  it('leaves out payments already linked to another receipt, but not to this one', () => {
    const others = [receipt, { id: 'r2', transactionId: 't8' }];
    expect(suggestPayments(receipt, transactions, others, '2026-11-21').map((t) => t.id)).toEqual(['t1', 't2']);
    const self = { ...receipt, transactionId: 't8' };
    expect(suggestPayments(self, transactions, [self], '2026-11-21')[0].id).toBe('t8');
  });

  it('without a service date, looks back two years from today, newest first; nothing for no amount', () => {
    const noDate = { id: 'r3', amount: 45 };
    expect(suggestPayments(noDate, transactions, [noDate], '2026-11-21').map((t) => t.id)).toEqual(['t1', 't8', 't3', 't2']);
    expect(suggestPayments({ id: 'r4', amount: 0 }, transactions, [], '2026-11-21')).toEqual([]);
  });
});

describe('missing receipts', () => {
  it('lists medical payments since a date that have no receipt, newest first', () => {
    const transactions = [
      tx('t1', '2026-03-01', 30),
      tx('t2', '2026-05-01', 60),
      tx('t3', '2026-07-01', 15, 'groceries'),
      tx('t4', '2026-08-01', 20, 'health', { type: 'credit' }),
      tx('t5', '2025-01-01', 80),
      tx('t6', '2026-09-01', 25),
    ];
    const receipts = [{ id: 'r', transactionId: 't2' }];
    expect(missingReceipts(transactions, receipts, '2026-01-01').map((t) => t.id)).toEqual(['t6', 't1']);
  });
});
