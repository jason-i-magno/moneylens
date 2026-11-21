import { describe, it, expect } from 'vitest';
import {
  PROJECTION_DEFAULTS, cashFlowBaseline, monthlyPaycheckContribution, projectNetWorth, projectionLoans, projectionMilestones,
  resolveProjectionSettings,
} from './projection';

const still = { years: 2, investReturn: 0, cashReturn: 0, homeGrowth: 0, raise: 0, inflation: 0 };
const base = { month: '2026-01', accounts: [], loans: [], takeHome: 0, spending: 0, cashCushion: 0 };

describe('settings', () => {
  it('falls back to the defaults for anything missing or not a number, and keeps years in range', () => {
    expect(resolveProjectionSettings()).toEqual(PROJECTION_DEFAULTS);
    expect(resolveProjectionSettings({ investReturn: 5, raise: 'x', years: 400 })).toEqual({ ...PROJECTION_DEFAULTS, investReturn: 5, years: 50 });
    expect(resolveProjectionSettings({ years: 0 }).years).toBe(1);
  });
});

describe('cash flow from the data', () => {
  const tx = (date, name, amount, type, category) => ({ date, name, amount, type, category });
  const transactions = [
    tx('2025-12-15', 'ACME CORP PAYROLL', 4000, 'credit', 'salary'), // 13 months back: left out
    tx('2026-01-02', 'ACME CORP PAYROLL', 4000, 'credit', 'salary'),
    tx('2026-01-05', 'GROCER', 500, 'debit', 'groceries'),
    tx('2026-01-06', 'TEST SERVICER PAYMENT', 2000, 'debit', 'housing'),
    tx('2026-02-02', 'ACME CORP PAYROLL', 4000, 'credit', 'salary'),
    tx('2026-02-03', 'CARD PAYMENT', 900, 'debit', 'transfers'), // not spending
    tx('2026-02-06', 'TEST SERVICER PAYMENT', 2000, 'debit', 'housing'),
    tx('2027-01-02', 'ACME CORP PAYROLL', 9999, 'credit', 'salary'), // the current month: left out
  ];
  const loan = { status: 'active', paymentKeywords: ['test servicer'], startDate: '2025-06-01', scheduled: 2000 };

  it('averages the 12 full months before this one, months with data only, without mortgage payments in spending', () => {
    expect(cashFlowBaseline(transactions, [loan], '2027-01')).toEqual({ takeHome: 4000, spending: 250, mortgage: 2000, months: 2, estimatedMortgage: false });
  });

  it("takes an active loan's scheduled payment out of spending when it has no payment keywords", () => {
    const out = cashFlowBaseline(transactions, [{ ...loan, paymentKeywords: [] }], '2027-01');
    expect(out).toMatchObject({ spending: 250, mortgage: 2000, estimatedMortgage: true });
  });

  it('turns per-paycheck contributions into a monthly amount', () => {
    const account = { type: 'asset', paycheckKeywords: ['acme corp'], paycheckContribution: 300 };
    expect(monthlyPaycheckContribution(account, transactions, '2027-01', 2)).toBe(300);
    expect(monthlyPaycheckContribution(account, transactions, '2027-01', 0)).toBe(0);
  });

  it("gives each active loan today's balance, its latest escrow and its recent extra principal", () => {
    const loans = [
      { id: 'loan_1', label: 'Home', status: 'active', loanAmount: 300000, interestRate: 6, monthlyPI: 1800 },
      { id: 'loan_0', status: 'paid_off', loanAmount: 1 },
    ];
    const payments = [
      { loanId: 'loan_1', forMonth: '2026-01', escrow: 400, extraPrincipal: 100 },
      { loanId: 'loan_1', forMonth: '2026-02', escrow: 450, extraPrincipal: 300 },
    ];
    expect(projectionLoans(loans, payments, { loan_1: 295000 })).toEqual([
      { id: 'loan_1', name: 'Home', balance: 295000, rate: 6, payment: 1800, escrow: 450, extra: 200 },
    ]);
  });
});

describe('projecting', () => {
  it("stays where it starts with nothing saved and nothing growing; debts and held accounts don't move", () => {
    const start = { ...base, accounts: [{ id: 'a', kind: 'cash', balance: 1000 }, { id: 'c', kind: 'flat', balance: 500, monthly: 99 }, { id: 'd', kind: 'debt', balance: 300 }] };
    const { points } = projectNetWorth(start, still);
    expect(points).toHaveLength(25);
    expect(points[0]).toMatchObject({ month: '2026-01', netWorth: 1200, owed: 300, other: 500 });
    expect(points[24]).toMatchObject({ month: '2028-01', netWorth: 1200 });
  });

  it('compounds each kind at its own rate, and contributions rise with raises', () => {
    const start = { ...base, accounts: [{ id: 'i', kind: 'invest', balance: 1000 }, { id: 'h', kind: 'home', balance: 1000 }, { id: 'k', kind: 'invest', balance: 0, monthly: 100 }] };
    const { points } = projectNetWorth(start, { ...still, years: 1, investReturn: 12, homeGrowth: 3, raise: 12 });
    expect(points[12].home).toBeCloseTo(1030, 6);
    // 1000 grows 12%; 12 contributions of 100 x (1.12)^(m/12), each growing for the months left
    const g = 1.12 ** (1 / 12);
    let k = 0;
    for (let m = 1; m <= 12; m++) k = k * g + 100 * g ** m;
    expect(points[12].invested).toBeCloseTo(1120 + k, 6);
  });

  it('saves what take-home pay leaves after spending: cash up to the cushion, then invested', () => {
    const start = { ...base, accounts: [{ id: 'a', kind: 'cash', balance: 500 }], takeHome: 3000, spending: 2000, cashCushion: 2000 };
    const { points } = projectNetWorth(start, { ...still, years: 1, investReturn: 0 });
    expect(points[1]).toMatchObject({ cash: 1500, invested: 0 });
    expect(points[2]).toMatchObject({ cash: 2000, invested: 500 });
    expect(points[12]).toMatchObject({ cash: 2000, invested: 10500, netWorth: 12500 });
  });

  it('pays a loan down on its schedule, then saves its payment', () => {
    // 12,000 at 0%: 1,000 a month, 200 of it extra, pays it off in 10 months
    const start = { ...base, loans: [{ id: 'l', balance: 12000, rate: 0, payment: 1000, extra: 200, escrow: 0 }], takeHome: 1500, spending: 300 };
    const { points, payoffs } = projectNetWorth(start, still);
    expect(payoffs).toEqual({ l: '2026-11' });
    expect(points[10].owed).toBe(0);
    expect(points[10].netWorth).toBe(0); // owed 12,000 at the start; every payment was the saving
    expect(points[11].netWorth - points[10].netWorth).toBe(1200);
  });

  it('matches the standard amortization formula for a loan with interest', () => {
    const r = 0.06 / 12;
    const payment = (100000 * r) / (1 - (1 + r) ** -120);
    const start = { ...base, loans: [{ id: 'l', balance: 100000, rate: 6, payment, extra: 0, escrow: 0 }], takeHome: payment };
    const { points, payoffs } = projectNetWorth(start, { ...still, years: 11 });
    expect(payoffs.l).toBe('2036-01');
    expect(points[60].owed).toBeCloseTo(100000 * (1 + r) ** 60 - payment * (((1 + r) ** 60 - 1) / r), 4);
  });

  it('keeps paying escrow after the loan is paid off, and takes a shortfall out of cash', () => {
    const start = { ...base, accounts: [{ id: 'a', kind: 'cash', balance: 1000 }], loans: [{ id: 'l', balance: 0, rate: 5, payment: 900, extra: 0, escrow: 100 }], takeHome: 0, spending: 50 };
    const { points } = projectNetWorth(start, { ...still, years: 1 });
    expect(points[12].cash).toBe(1000 - 12 * 150);
  });
});

describe('milestones', () => {
  it('finds the first month each round amount above the start is reached', () => {
    const points = [300e3, 420e3, 510e3, 990e3, 1.2e6].map((netWorth, i) => ({ month: `2030-0${i + 1}`, netWorth }));
    expect(projectionMilestones(points)).toEqual([
      { amount: 500e3, month: '2030-03' },
      { amount: 1e6, month: '2030-05' },
    ]);
  });
});
