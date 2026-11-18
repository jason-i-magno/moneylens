import { describe, it, expect } from 'vitest';
import { parseBalanceHistory } from './csvParser';

describe('parseBalanceHistory', () => {
  it('reads a date and a balance per row, with or without a header', () => {
    expect(parseBalanceHistory('date,balance\n2026-01-31,1000\n2026-02-28,1250.50\n').balances).toEqual([
      { date: '2026-01-31', balance: 1000 }, { date: '2026-02-28', balance: 1250.5 },
    ]);
    expect(parseBalanceHistory('2026-02-28,1250.50\n2026-01-31,1000').balances).toEqual([
      { date: '2026-01-31', balance: 1000 }, { date: '2026-02-28', balance: 1250.5 },
    ]);
  });

  it('finds the columns by their headers and reads money and US dates', () => {
    const csv = 'Fund,Value,As of Date\nTotal,"$12,345.67",01/31/2026\nTotal,(25.00),2/28/2026\n';
    expect(parseBalanceHistory(csv).balances).toEqual([
      { date: '2026-01-31', balance: 12345.67 }, { date: '2026-02-28', balance: -25 },
    ]);
  });

  it('skips rows without a date and a balance, and keeps the last row for a repeated date', () => {
    const { balances, skipped } = parseBalanceHistory('Date,Balance\n2026-01-31,1000\nTotal,\n2026-02-28,n/a\n2026-01-31,1100\n');
    expect(balances).toEqual([{ date: '2026-01-31', balance: 1100 }]);
    expect(skipped).toEqual([{ row: 3, text: 'Total, ' }, { row: 4, text: '2026-02-28, n/a' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseBalanceHistory('')).toEqual({ balances: [], skipped: [] });
  });
});
