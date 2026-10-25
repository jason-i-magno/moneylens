import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyTransactionEdit, isIncome, isSpending, sumByCategory } from './transactions';
import { addDays, addMonths, daysBetween, todayISO, getMonthOptions } from './dates';
import { detectDateFormat, parseDate } from './csvParser';
import { findDuplicates } from './duplicateDetector';
import { makeId } from './ids';

describe('income and spending rules', () => {
  const paycheck = { type: 'credit', category: 'other', amount: 3000 };
  const cardPaymentReceived = { type: 'credit', category: 'transfers', amount: 1500 };
  const cardPaymentSent = { type: 'debit', category: 'transfers', amount: 1500 };
  const groceries = { type: 'debit', category: 'groceries', amount: 80 };
  const manual = { category: 'dining', amount: 20 }; // manual entries have no type

  it('transfers are neither income nor spending', () => {
    expect([paycheck, cardPaymentReceived].filter(isIncome)).toEqual([paycheck]);
    expect([cardPaymentSent, groceries, manual].filter(isSpending)).toEqual([groceries, manual]);
  });

  it('sums by category, rounded to cents', () => {
    expect(sumByCategory([
      { category: 'dining', amount: 0.1 },
      { category: 'dining', amount: 0.2 },
    ])).toEqual({ dining: 0.3 });
  });

  it('marks a category changed in the edit form as set by the user', () => {
    const imported = { id: 'tx_1', source: 'csv_import', name: 'CHECK', category: 'other', amount: 50 };
    expect(applyTransactionEdit(imported, { name: 'CHECK', category: 'housing' })).toMatchObject({ category: 'housing', categorySetByUser: true });
    expect(applyTransactionEdit(imported, { name: 'CHECK 101', category: 'other' })).not.toHaveProperty('categorySetByUser');
    expect(applyTransactionEdit({ ...imported, source: 'manual' }, { category: 'housing' })).not.toHaveProperty('categorySetByUser');
  });
});

describe('dates', () => {
  afterEach(() => vi.useRealTimers());

  it('todayISO uses the local calendar date, not UTC', () => {
    // 19:30 local on Mar 14 is already Mar 15 in UTC when west of UTC (tests run at UTC−10)
    vi.useFakeTimers();
    const localEvening = new Date(2026, 2, 14, 19, 30);
    vi.setSystemTime(localEvening);
    expect(todayISO()).toBe('2026-03-14');
  });

  it('adds days and months across boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(daysBetween('2026-03-09', '2026-03-07')).toBe(-2);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // spans the US DST change
  });

  it('lists months newest first and always includes the current month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 10));
    expect(getMonthOptions([{ date: '2026-01-03' }, { date: '2026-03-09' }, {}])).toEqual(['2026-05', '2026-03', '2026-01']);
  });
});

describe('detectDateFormat', () => {
  it.each([
    [['03/05/2026', '12/31/2026'], 'MM/DD/YYYY'],
    [['03/05/2026', '25/12/2026'], 'DD/MM/YYYY'],
    [['2026-03-05', '2026-12-31'], 'YYYY-MM-DD'],
    [['03-05-2026'], 'MM-DD-YYYY'],
    [['', '2026-03-05', undefined], 'YYYY-MM-DD'],
  ])('%j → %s', (samples, expected) => {
    expect(detectDateFormat(samples)).toBe(expected);
  });

  it('parses with the detected format', () => {
    expect(parseDate('25/12/2026', 'DD/MM/YYYY')).toBe('2026-12-25');
    expect(parseDate('garbage', 'MM/DD/YYYY')).toBeNull();
  });
});

describe('findDuplicates', () => {
  it('matches on date + amount + description, case-insensitively', () => {
    const existing = [{ date: '2026-01-02', amount: 42.5, name: 'Whole Foods' }, { date: '2026-01-02', amount: 1 }];
    const [dup, fresh] = findDuplicates([
      { date: '2026-01-02', amount: 42.5, description: 'WHOLE FOODS' },
      { date: '2026-01-03', amount: 42.5, description: 'WHOLE FOODS' },
    ], existing);
    expect(dup.isDuplicate).toBe(true);
    expect(fresh.isDuplicate).toBe(false);
  });
});

describe('makeId', () => {
  it('never repeats, even within one millisecond', () => {
    const ids = Array.from({ length: 500 }, () => makeId('tx'));
    expect(new Set(ids).size).toBe(500);
    expect(ids[0]).toMatch(/^tx_\d+(_\d+)?$/);
  });
});
