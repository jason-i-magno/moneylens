import { describe, it, expect } from 'vitest';
import {
  PROJECTION_DEFAULTS, RAISE_TAKE_HOME_SHARE, cashFlowBaseline, describeChange, monthlyPaycheckContribution, projectNetWorth, projectionLoans, projectionMilestones,
  resolveChanges, resolveProjectionSettings,
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

describe('future changes', () => {
  const change = (id, month, kind, amount, extra = {}) => ({ id, month, kind, amount, ...extra });
  const saving = { ...base, takeHome: 3000, spending: 1000 };
  const savedBy = (points, m) => points[m].netWorth - points[0].netWorth;

  it('keeps only well-formed changes, in month order', () => {
    const list = [
      change('b', '2027-03', 'spending', 200),
      change('a', '2026-06', 'takeHome', -500, { enabled: false }),
      change('c', '2026-13', 'oneTime', 1),
      change('d', '2027-01', 'stopPaychecks'),
      change('e', '2027-01', 'oneTime', 'lots'),
      { month: '2027-01', kind: 'oneTime', amount: 5 },
      change('f', '2027-01', 'lottery', 5),
    ];
    expect(resolveChanges(list).map((c) => c.id)).toEqual(['a', 'd', 'b']);
    expect(resolveChanges(undefined)).toEqual([]);
  });

  it('changes take-home or spending from its month on', () => {
    const { points } = projectNetWorth({ ...saving, changes: [change('t', '2026-04', 'takeHome', -500), change('s', '2026-07', 'spending', 300)] }, { ...still, years: 1 });
    expect(savedBy(points, 2)).toBe(4000);
    expect(savedBy(points, 3)).toBe(5500); // April: 1,500
    expect(savedBy(points, 6)).toBe(9700); // 2 x 2,000 + 3 x 1,500, then July on: 1,200 a month
    expect(savedBy(points, 7)).toBe(10900);
  });

  it('grows a take-home change with raises and a spending change with inflation, like what they change', () => {
    const { points } = projectNetWorth({ ...base, takeHome: 1000, changes: [change('t', '2026-01', 'takeHome', 1000)] }, { ...still, years: 1, raise: 12 });
    const plain = projectNetWorth({ ...base, takeHome: 2000 }, { ...still, years: 1, raise: 12 }).points;
    expect(points[12].netWorth).toBeCloseTo(plain[12].netWorth, 6);
  });

  it('adds or takes a one-time amount in its month only, grown by inflation', () => {
    const { points } = projectNetWorth({ ...base, changes: [change('car', '2027-01', 'oneTime', -24000), change('gift', '2026-03', 'oneTime', 1000)] }, { ...still, years: 2, inflation: 10 });
    expect(savedBy(points, 1)).toBe(0);
    expect(savedBy(points, 2)).toBeCloseTo(1000 * 1.1 ** (2 / 12), 6);
    expect(savedBy(points, 13) - savedBy(points, 11)).toBeCloseTo(-24000 * 1.1, 6);
  });

  it('stops take-home and paycheck contributions when paychecks stop, and pays spending from savings', () => {
    const start = { ...saving, accounts: [{ id: 'k', kind: 'invest', balance: 0, monthly: 500 }], changes: [change('r', '2026-07', 'stopPaychecks')] };
    const { points } = projectNetWorth(start, { ...still, years: 1 });
    expect(points[5]).toMatchObject({ invested: 2500 + 5 * 2000, cash: 0 });
    // July on: no paychecks or contributions; 1,000 a month of spending comes out of the invested savings
    expect(points[12]).toMatchObject({ invested: 2500 + 10000 - 7000, cash: 0 });
  });

  it('takes a shortfall from cash savings first, then invested savings, then lets cash go below zero', () => {
    const start = { ...base, takeHome: 3000, spending: 1000, cashCushion: 1000, changes: [change('r', '2026-03', 'stopPaychecks')] };
    const { points } = projectNetWorth(start, { ...still, years: 1 });
    expect(points[1]).toMatchObject({ cash: 1000, invested: 1000 });
    expect(points[2]).toMatchObject({ cash: 0, invested: 1000 }); // March: 1,000 out of cash
    expect(points[3]).toMatchObject({ cash: 0, invested: 0 });
    expect(points[4]).toMatchObject({ cash: -1000, invested: 0 });
  });

  it('raises paycheck contributions by all of a pay raise and take-home by its taxed share, compounding', () => {
    const start = { ...base, takeHome: 4000, accounts: [{ id: 'k', kind: 'invest', balance: 0, monthly: 1000 }],
      changes: [change('p1', '2026-03', 'payRaise', 10), change('p2', '2026-05', 'payRaise', 10), change('t', '2026-05', 'takeHome', -200)] };
    const { points } = projectNetWorth(start, { ...still, years: 1 });
    const share = 0.1 * RAISE_TAKE_HOME_SHARE;
    const month = (m) => points[m].netWorth - points[m - 1].netWorth;
    expect(month(1)).toBeCloseTo(5000, 6);
    expect(month(2)).toBeCloseTo(4000 * (1 + share) + 1100, 6);
    // the take-home change is dollars, not scaled by the raises
    expect(month(4)).toBeCloseTo(4000 * (1 + share) ** 2 - 200 + 1210, 6);
    expect(describeChange(change('p', '2028-04', 'payRaise', 8))).toBe('Pay +8% from Apr 2028');
  });

  it('applies a change dated before today from the first month, and leaves out switched-off ones', () => {
    const { points } = projectNetWorth({ ...saving, changes: [change('old', '2020-01', 'spending', 500), change('off', '2026-01', 'takeHome', 9000, { enabled: false })] }, { ...still, years: 1 });
    expect(savedBy(points, 1)).toBe(1500);
  });
});

describe('account deposits and spending an account down', () => {
  const plan = (id, extra) => ({ id, month: '2026-03', ...extra });
  const fund = { id: 'edu', kind: 'invest', balance: 1000 };

  it('keeps only well-formed account changes', () => {
    const list = [
      plan('ok1', { kind: 'contribution', accountId: 'edu', amount: 500, every: 12, times: 3, match: 100 }),
      plan('ok2', { kind: 'spendAccount', accountId: 'edu', years: 4 }),
      plan('bad1', { kind: 'contribution', accountId: 'edu', amount: 500, every: 5 }),
      plan('bad2', { kind: 'contribution', amount: 500, every: 12 }),
      plan('bad3', { kind: 'contribution', accountId: 'edu', amount: 500, every: 12, times: 0 }),
      plan('bad4', { kind: 'spendAccount', accountId: 'edu', years: 0 }),
    ];
    expect(resolveChanges(list).map((c) => c.id)).toEqual(['ok1', 'ok2']);
  });

  it('deposits on schedule out of savings, a limited number of times, with a match from outside', () => {
    const start = { ...base, accounts: [fund], takeHome: 2000, spending: 1000,
      changes: [plan('d', { kind: 'contribution', accountId: 'edu', amount: 300, every: 6, times: 2, match: 50 })] };
    const { points } = projectNetWorth(start, { ...still, years: 2 });
    // Months 1 (Feb) nothing; 2 (Mar) first deposit; 8 (Sep) second; 14 (Mar) none: two times only
    expect(points[2].netWorth - points[1].netWorth).toBe(1000 + 150); // 1,000 saved a month, of which 300 deposited, plus the 150 match
    expect(points[8].netWorth - points[7].netWorth).toBe(1150);
    expect(points[14].netWorth - points[13].netWorth).toBe(1000);
  });

  it('grows deposits with inflation and leaves the money in savings for an account held as it is', () => {
    const grown = projectNetWorth({ ...base, accounts: [fund], changes: [plan('d', { kind: 'contribution', accountId: 'edu', amount: 100, every: 1 })] }, { ...still, years: 1, inflation: 12 }).points;
    const deposit = 100 * 1.12 ** (2 / 12);
    expect(grown[2].invested - grown[1].invested).toBeCloseTo(deposit, 6); // into the account...
    expect(grown[2].cash - grown[1].cash).toBeCloseTo(-deposit, 6); // ...out of savings (none here, so cash goes below zero)
    const held = projectNetWorth({ ...base, takeHome: 500, accounts: [{ ...fund, kind: 'flat' }], changes: [plan('d', { kind: 'contribution', accountId: 'edu', amount: 100, every: 1, match: 100 })] }, { ...still, years: 1 }).points;
    expect(held[12].other).toBe(1000);
    expect(held[12].netWorth - held[0].netWorth).toBe(12 * 500); // no match either
  });

  it('spends an account down evenly over the years given, then leaves it empty', () => {
    const start = { ...base, accounts: [{ ...fund, balance: 4800 }], changes: [plan('s', { kind: 'spendAccount', accountId: 'edu', years: 2 })] };
    const { points } = projectNetWorth(start, { ...still, years: 3 });
    expect(points[1].invested).toBe(4800);
    expect(points[2].invested).toBeCloseTo(4600, 6); // March: 1/24 of it
    expect(points[13].invested).toBeCloseTo(2400, 6); // half way
    expect(points[25].invested).toBeCloseTo(0, 6); // the 24th month
    expect(points[36].invested).toBe(0);
  });

  it('names the account in descriptions', () => {
    const nameOf = (id) => ({ edu: 'College Fund' })[id];
    expect(describeChange(plan('d', { kind: 'contribution', accountId: 'edu', amount: 500, every: 12, times: 3, match: 100 }), nameOf))
      .toBe('College Fund +$500 a year, matched 100%, 3 times from Mar 2026');
    expect(describeChange(plan('s', { kind: 'spendAccount', accountId: 'edu', years: 4 }), nameOf)).toBe('College Fund spent over 4 years from Mar 2026');
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
