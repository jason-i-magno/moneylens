import { describe, it, expect } from 'vitest';
import { buildCategoryData, buildNetData } from './trends';
import { isIncome, isSpending } from './transactions';

const txs = [
  { date: '2026-01-05', type: 'debit', amount: 10.1, category: 'groceries' },
  { date: '2026-01-05', type: 'debit', amount: 0.2, category: 'dining' },
  { date: '2026-01-20', type: 'debit', amount: 30, category: 'groceries' },
  { date: '2026-02-03', type: 'debit', amount: 5, category: 'dining' },
  { date: '2026-01-15', type: 'credit', amount: 100, category: 'salary' },
  { date: '2026-02-15', type: 'credit', amount: 100, category: 'salary' },
  { date: '2026-02-16', type: 'debit', amount: 500, category: 'transfers' }, // neither income nor spending
];
const pick = (rows, ...keys) => rows.map((r) => [r.label, ...keys.map((k) => r[k])]);

describe('buildCategoryData', () => {
  it('totals each month on its own', () => {
    expect(pick(buildCategoryData(txs, isSpending, { groupBy: 'monthly' }), 'total', 'groceries', 'dining')).toEqual([
      ['2026-01', 40.3, 40.1, 0.2],
      ['2026-02', 5, 0, 5],
    ]);
  });

  it('keeps a running total when cumulative', () => {
    expect(pick(buildCategoryData(txs, isSpending, { groupBy: 'monthly', cumulative: true }), 'total', 'groceries', 'dining')).toEqual([
      ['2026-01', 40.3, 40.1, 0.2],
      ['2026-02', 45.3, 40.1, 5.2],
    ]);
  });

  it('groups by day, either way', () => {
    expect(pick(buildCategoryData(txs, isSpending, { groupBy: 'daily' }), 'total')).toEqual([
      ['2026-01-05', 10.3], ['2026-01-20', 30], ['2026-02-03', 5],
    ]);
    expect(pick(buildCategoryData(txs, isSpending, { groupBy: 'daily', cumulative: true }), 'total')).toEqual([
      ['2026-01-05', 10.3], ['2026-01-20', 40.3], ['2026-02-03', 45.3],
    ]);
  });

  it('works for income too', () => {
    expect(pick(buildCategoryData(txs, isIncome, { groupBy: 'monthly', cumulative: true }), 'salary')).toEqual([
      ['2026-01', 100], ['2026-02', 200],
    ]);
  });
});

describe('buildNetData', () => {
  it('nets income against spending, leaving transfers out', () => {
    expect(pick(buildNetData(txs, { groupBy: 'monthly' }), 'income', 'spending', 'net')).toEqual([
      ['2026-01', 100, 40.3, 59.7],
      ['2026-02', 100, 5, 95],
    ]);
    expect(pick(buildNetData(txs, { groupBy: 'monthly', cumulative: true }), 'income', 'spending', 'net')).toEqual([
      ['2026-01', 100, 40.3, 59.7],
      ['2026-02', 200, 45.3, 154.7],
    ]);
  });
});
