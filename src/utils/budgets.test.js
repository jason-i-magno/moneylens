import { describe, it, expect } from 'vitest';
import { monthSpending, budgetTotals, monthProgress, averageSpending } from './budgets';

const tx = (date, category, amount, type = 'debit') => ({ date, category, amount, type });

describe('monthSpending', () => {
  it('adds up the month\'s spending per category, without transfers or credits', () => {
    const transactions = [
      tx('2024-05-02', 'groceries', 40.1), tx('2024-05-20', 'groceries', 9.9), tx('2024-05-03', 'dining', 25),
      tx('2024-05-04', 'transfers', 500), tx('2024-05-05', 'refunds', 30, 'credit'), tx('2024-04-30', 'groceries', 99),
    ];
    expect(monthSpending(transactions, '2024-05')).toEqual({ groceries: 50, dining: 25 });
  });
});

describe('budgetTotals', () => {
  it('totals the budgets, the spending in budgeted categories, what is left, and unbudgeted spending', () => {
    const totals = budgetTotals({ groceries: 400, dining: 100 }, { groceries: 250.5, dining: 120, shopping: 60.25 });
    expect(totals).toEqual({ budgeted: 500, spent: 370.5, left: 129.5, unbudgeted: 60.25 });
    expect(budgetTotals({ dining: 100 }, { dining: 150 }).left).toBe(-50);
    expect(budgetTotals({}, { dining: 10 })).toEqual({ budgeted: 0, spent: 0, left: 0, unbudgeted: 10 });
  });
});

describe('monthProgress', () => {
  it('is the share of the month gone by, counting today', () => {
    expect(monthProgress('2024-06', '2024-06-03')).toBe(0.1);
    expect(monthProgress('2024-02', '2024-02-29')).toBe(1); // leap year
    expect(monthProgress('2024-05', '2024-06-03')).toBe(1);
    expect(monthProgress('2024-07', '2024-06-03')).toBe(0);
  });
});

describe('averageSpending', () => {
  it('averages the full months before the given month, in whole dollars', () => {
    const transactions = [
      tx('2024-02-10', 'groceries', 300), tx('2024-03-10', 'groceries', 200), tx('2024-04-10', 'groceries', 101),
      tx('2024-04-11', 'transfers', 999), tx('2024-05-01', 'groceries', 5000), // the month itself doesn't count
    ];
    expect(averageSpending(transactions, '2024-05', 3)).toEqual({ months: ['2024-02', '2024-03', '2024-04'], averages: { groceries: 200 } });
  });

  it('skips months before the first transaction', () => {
    const transactions = [tx('2024-03-15', 'dining', 90), tx('2024-04-15', 'dining', 31)];
    expect(averageSpending(transactions, '2024-05')).toEqual({ months: ['2024-03', '2024-04'], averages: { dining: 61 } });
    expect(averageSpending([], '2024-05')).toEqual({ months: [], averages: {} });
  });
});
