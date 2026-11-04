import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyTransactionEdit, isIncome, isSpending, sumByCategory } from './transactions';
import { addDays, addMonths, daysBetween, todayISO, getMonthOptions } from './dates';
import { detectDateFormat, parseDate } from './csvParser';
import { findDuplicates } from './duplicateDetector';
import { makeId } from './ids';
import {
  generateAmortization, extrapolateFromBalance, amortizationRows, trajectoryStart, compareExtraPayments, averageExtraPrincipal,
  loanServicers, servicerOn,
} from './mortgageCalculations';

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

describe('generateAmortization', () => {
  it('puts the first payment in the month after the loan starts and the last on the maturity date', () => {
    // 1-year loan at 12% a year: 1% a month
    const schedule = generateAmortization(12000, 12, 1, '2023-11-01');
    expect(schedule.map((r) => r.date)).toEqual(['2023-12', '2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06', '2024-07', '2024-08', '2024-09', '2024-10', '2024-11']);
    expect(schedule[0]).toMatchObject({ paymentNumber: 1, interest: 120, principal: 946.19, balance: 11053.81 });
    expect(schedule.at(-1).balance).toBe(0);
  });
});

describe('amortizationRows', () => {
  it('lines up the schedule, the actual payments and the new trajectory by month', () => {
    // Same 1-year loan; the first payment had 1000 of extra principal, so minimum payments finish it early
    const schedule = generateAmortization(12000, 12, 1, '2023-11-01');
    const payments = [{ forMonth: '2023-12', principal: 946.19, extraPrincipal: 1000, interest: 120, balanceAfter: 10053.81 }];
    const trajectory = extrapolateFromBalance(10053.81, 12, 1066.19, '2024-01');
    expect(trajectory[0]).toEqual({ date: '2024-01', principal: 965.65, interest: 100.54, balance: 9088.16 });

    const rows = amortizationRows(schedule, payments, trajectory);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ date: '2023-12', balance: 11053.81, actualPrincipal: 1946.19, actualBalance: 10053.81, hasActual: true, trajectoryBalance: null, hasTrajectory: false });
    expect(rows[1]).toMatchObject({ date: '2024-01', hasActual: false, trajectoryPrincipal: 965.65, trajectoryInterest: 100.54, trajectoryBalance: 9088.16, hasTrajectory: true });
    const lastTrajectory = rows.findLast((r) => r.hasTrajectory);
    expect(lastTrajectory.trajectoryBalance).toBe(0);
    expect(lastTrajectory.date < '2024-11').toBe(true);
    expect(rows.at(-1)).toMatchObject({ date: '2024-11', balance: 0, trajectoryBalance: null });
    expect(rows.some((r) => r.hasWithExtra)).toBe(false);
  });

  it('adds the trajectory with extra payments, which ends sooner', () => {
    const schedule = generateAmortization(12000, 12, 1, '2023-11-01');
    const payments = [{ forMonth: '2023-12', principal: 946.19, extraPrincipal: 1000, interest: 120, balanceAfter: 10053.81 }];
    const trajectory = extrapolateFromBalance(10053.81, 12, 1066.19, '2024-01');
    const withExtra = extrapolateFromBalance(10053.81, 12, 1066.19, '2024-01', { extraMonthly: 1000 });
    const rows = amortizationRows(schedule, payments, trajectory, withExtra);
    expect(rows[0]).toMatchObject({ date: '2023-12', hasActual: true, withExtraBalance: null, hasWithExtra: false });
    expect(rows[1]).toMatchObject({ date: '2024-01', trajectoryBalance: 9088.16, withExtraPrincipal: 1965.65, withExtraInterest: 100.54, withExtraBalance: 8088.16, hasWithExtra: true });
    const lastWithExtra = rows.findLast((r) => r.hasWithExtra);
    expect(lastWithExtra.withExtraBalance).toBe(0);
    expect(lastWithExtra.date < rows.findLast((r) => r.hasTrajectory).date).toBe(true);
  });

  it('adds trajectory months past the original maturity for a loan behind schedule', () => {
    const schedule = [
      { paymentNumber: 1, date: '2023-01', principal: 10, interest: 1, balance: 90 },
      { paymentNumber: 2, date: '2023-02', principal: 10, interest: 1, balance: 80 },
    ];
    const rows = amortizationRows(schedule, [{ forMonth: '2023-01', principal: 5, interest: 1, balanceAfter: 95 }], [
      { date: '2023-02', principal: 5, interest: 1, balance: 90 },
      { date: '2023-03', principal: 5, interest: 1, balance: 85 },
    ]);
    expect(rows.map((r) => [r.paymentNumber, r.date, r.balance, r.actualPrincipal, r.trajectoryBalance])).toEqual([
      [1, '2023-01', 90, 5, null],
      [2, '2023-02', 80, null, 90],
      [3, '2023-03', null, null, 85],
    ]);
    expect(amortizationRows(schedule, [])).toHaveLength(2); // no trajectory (a paid-off loan)
  });
});

describe('extra payments', () => {
  // 12000 at 12% a year (1% a month); 1066.19 pays it off in 12 months
  const loan = { loanAmount: 12000, interestRate: 12, monthlyPI: 1066.19, startDate: '2023-12-01' };

  it('compares minimum payments with extra each month and a one-time extra', () => {
    const c = compareExtraPayments(loan, [], { extraMonthly: 100, oneTime: { month: '2024-02', amount: 1000 } });
    expect(c.start).toEqual({ month: '2024-01', balance: 12000 });
    expect(c.base).toMatchObject({ months: 12, payoffMonth: '2024-12', interest: 794.23 });
    expect(c.withExtra.timeline.slice(0, 2)).toEqual([
      { date: '2024-01', principal: 1046.19, interest: 120, balance: 10953.81 },
      { date: '2024-02', principal: 2056.65, interest: 109.54, balance: 8897.16 },
    ]);
    expect(c.withExtra.timeline.at(-1)).toEqual({ date: '2024-10', principal: 1126.6, interest: 11.27, balance: 0 });
    expect(c.withExtra).toMatchObject({ months: 10, payoffMonth: '2024-10', interest: 633.58 });
    expect(c).toMatchObject({ monthsSaved: 2, interestSaved: 160.65 });
    expect(compareExtraPayments(loan, [])).toMatchObject({ monthsSaved: 0, interestSaved: 0 });
  });

  it('starts from the latest payment, and reports no payoff when the payment never pays it off', () => {
    const payments = [{ forMonth: '2024-03', balanceAfter: 8000 }, { forMonth: '2024-02', balanceAfter: 9000 }];
    expect(trajectoryStart(loan, payments)).toEqual({ month: '2024-04', balance: 8000 });
    expect(compareExtraPayments({ ...loan, monthlyPI: 100 }, []).base).toMatchObject({ months: 360, payoffMonth: null });
  });

  it('averages the extra principal of the latest payments', () => {
    const payments = [
      { forMonth: '2024-03', extraPrincipal: 600 }, { forMonth: '2024-01' }, { forMonth: '2024-02', extraPrincipal: 300 },
    ];
    expect(averageExtraPrincipal(payments, 2)).toBe(450);
    expect(averageExtraPrincipal(payments)).toBe(300);
    expect(averageExtraPrincipal([])).toBe(0);
  });
});

describe('servicing transfers', () => {
  const loan = {
    servicer: 'Third', servicerType: 'valon', loanNumber: '3',
    pastServicers: [{ servicer: 'Second', until: '2023-11-01' }, { servicer: 'First', loanNumber: '1', until: '2023-02-01' }],
  };

  it('lists the servicers oldest first, ending with the current one', () => {
    expect(loanServicers(loan).map((s) => s.servicer)).toEqual(['First', 'Second', 'Third']);
    expect(loanServicers({ servicer: 'Only' })).toEqual([{ servicer: 'Only', servicerType: undefined, loanNumber: undefined, until: null }]);
  });

  it('finds who serviced the loan on a date (a transfer date belongs to the new servicer)', () => {
    expect(['2023-01-31', '2023-02-01', '2023-10-31', '2023-11-01', undefined].map((d) => servicerOn(loan, d).servicer))
      .toEqual(['First', 'Second', 'Second', 'Third', 'Third']);
  });
});
