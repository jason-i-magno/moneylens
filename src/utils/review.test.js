import { describe, it, expect } from 'vitest';
import {
  buildMonthlyReview, expectedBills, merchantKey, netWorthChange, newRecurring, planComparison, priceIncreases, reviewFacts, unusualCharges,
} from './review';

let seq = 0;
const debit = (date, amount, name, category = 'shopping', extra = {}) => ({ id: `t${++seq}`, date, amount, name, category, type: 'debit', ...extra });
const credit = (date, amount, name, category = 'salary') => ({ id: `t${++seq}`, date, amount, name, category, type: 'credit' });
const monthly = (name, amount, day, months, category = 'utilities', extra = {}) =>
  months.map((m) => debit(`${m}-${String(day).padStart(2, '0')}`, typeof amount === 'function' ? amount(m) : amount, name, category, extra));
// An old row so the history is long enough for new-merchant and new-recurring checks
const OLD = debit('2025-01-15', 5, 'OLD COFFEE', 'dining');

describe('merchant key', () => {
  it('drops processor prefixes, store numbers and punctuation, keeping three words', () => {
    expect(merchantKey('SQ *CORNER BAKERY #12')).toBe('corner bakery');
    expect(merchantKey('TST* Demo Diner 0042 Springfield')).toBe('demo diner springfield');
    expect(merchantKey('PAYPAL *STREAMCO')).toBe('streamco');
    expect(merchantKey('DEMO MARKET 0390 0390 SPRINGFIELD XX')).toBe('demo market springfield');
    expect(merchantKey('Streamco P12C3456BE')).toBe('streamco');
    expect(merchantKey('Streamco USA')).toBe('streamco');
    expect(merchantKey('SHOPCO MKTPL*ZD8TC4AB2')).toBe('shopco');
    expect(merchantKey('Shopco.com*AB12CD')).toBe('shopco');
    expect(merchantKey('')).toBe('');
  });
});

describe('unusual charges', () => {
  const history = [OLD, ...monthly('DEMO GROCER', 60, 5, ['2026-06', '2026-07', '2026-08', '2026-09'], 'groceries')];

  it('flags a new merchant over $100 and a charge far above the usual, largest first, one per merchant', () => {
    const txs = [
      ...history,
      debit('2026-10-07', 180, 'DEMO GROCER', 'groceries'), // usual 60: three times as much
      debit('2026-10-09', 250, 'NEW FURNITURE CO'),
      debit('2026-10-12', 120, 'NEW FURNITURE CO'),
      debit('2026-10-14', 40, 'NEW BOOKSHOP'), // new but small
      debit('2026-10-15', 300, 'OWN TRANSFER', 'transfers'), // not spending
    ];
    expect(unusualCharges(txs, '2026-10')).toEqual([
      expect.objectContaining({ kind: 'new', name: 'NEW FURNITURE CO', amount: 250 }),
      expect.objectContaining({ kind: 'large', name: 'DEMO GROCER', amount: 180, usual: 60 }),
    ]);
  });

  it("doesn't call merchants new without 3 months of history, or a little over the usual unusual", () => {
    expect(unusualCharges([debit('2026-10-09', 250, 'NEW FURNITURE CO')], '2026-10')).toEqual([]);
    expect(unusualCharges([...history, debit('2026-10-07', 100, 'DEMO GROCER', 'groceries')], '2026-10')).toEqual([]);
  });

  it("doesn't flag a big regular charge from a merchant that also gets small ones (a mortgage and extra principal)", () => {
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
    const txs = [OLD, ...monthly('DEMO SERVICER', 2000, 1, months, 'housing'), ...monthly('DEMO SERVICER', 200, 15, months.slice(0, 5), 'housing'),
      debit('2026-04-20', 300, 'DEMO SERVICER', 'housing'), debit('2026-03-20', 300, 'DEMO SERVICER', 'housing')];
    expect(unusualCharges(txs, '2026-10')).toEqual([]);
  });
});

describe('price increases', () => {
  it('finds a fixed charge that went up, not bills that vary', () => {
    const txs = [
      ...monthly('STREAMCO', 15.49, 3, ['2026-08', '2026-09']),
      debit('2026-10-03', 17.99, 'STREAMCO'),
      ...monthly('CITY POWER', (m) => ({ '2026-08': 80, '2026-09': 95, '2026-10': 120 })[m], 20, ['2026-08', '2026-09', '2026-10']),
      ...monthly('GYM CO', 30, 1, ['2026-09', '2026-10']), // the same price
    ];
    expect(priceIncreases(txs, '2026-10')).toEqual([expect.objectContaining({ name: 'STREAMCO', from: 15.49, to: 17.99, date: '2026-10-03' })]);
  });
});

describe('new recurring charges', () => {
  it('finds a charge in this month and last on about the same day, and a first-time subscription', () => {
    const txs = [
      OLD,
      ...monthly('NEW APP CO', 9.99, 4, ['2026-09', '2026-10'], 'entertainment'),
      ...monthly('OLD APP CO', 4.99, 4, ['2026-03', '2026-09', '2026-10'], 'entertainment'), // seen in March: not new
      debit('2026-09-02', 40, 'NEW DINER', 'dining'),
      debit('2026-10-25', 41, 'NEW DINER', 'dining'), // different day: a visit, not a bill
      debit('2026-10-11', 12, 'MUSIC CO', 'entertainment', { isSubscription: true }),
    ];
    expect(newRecurring(txs, '2026-10')).toEqual([
      expect.objectContaining({ name: 'MUSIC CO', amount: 12, since: '2026-10', subscription: true }),
      expect.objectContaining({ name: 'NEW APP CO', amount: 9.99, since: '2026-09' }),
    ]);
    expect(newRecurring(txs.slice(1), '2026-10')).toEqual([]); // under 8 months of history
  });
});

describe('expected bills', () => {
  it('expects charges from each of the last 3 months on about the same day, plus manual subscriptions not already there', () => {
    const txs = [
      ...monthly('CITY POWER', (m) => ({ '2026-08': 80, '2026-09': 95, '2026-10': 110 })[m], 20, ['2026-08', '2026-09', '2026-10']),
      ...monthly('STREAMCO', 15.49, 31, ['2026-08']),
      debit('2026-09-30', 15.49, 'STREAMCO'),
      debit('2026-10-31', 15.49, 'STREAMCO'),
      debit('2026-08-02', 30, 'DEMO CAFE', 'dining'),
      debit('2026-09-15', 30, 'DEMO CAFE', 'dining'), // days too far apart
      debit('2026-10-28', 30, 'DEMO CAFE', 'dining'),
      ...monthly('DEMO SERVICER', 2000, 1, ['2026-08', '2026-09', '2026-10'], 'housing'),
      ...monthly('DEMO SERVICER', 250, 18, ['2026-08', '2026-10'], 'housing'), // extra principal: left out
    ];
    const subs = [
      { id: 's1', name: 'Streamco', amount: 15.49, frequency: 'yearly', nextDate: '2025-11-30' }, // covered by the charge
      { id: 's4', name: 'Premium (from paycheck)', amount: 12, frequency: 'monthly', nextDate: '2026-10-06' }, // monthly: left out
      { id: 's2', name: 'Cloud Storage', amount: 30, frequency: 'yearly', nextDate: '2025-11-08' },
      { id: 's3', name: 'Magazine', amount: 20, frequency: 'quarterly', nextDate: '2026-09-10' }, // next in December
    ];
    expect(expectedBills(txs, subs, '2026-10').map(({ name, date, amount, varies }) => ({ name, date, amount, varies }))).toEqual([
      { name: 'DEMO SERVICER', date: '2026-11-01', amount: 2000, varies: false },
      { name: 'Cloud Storage', date: '2026-11-08', amount: 30, varies: false },
      { name: 'CITY POWER', date: '2026-11-20', amount: 95, varies: true },
      { name: 'STREAMCO', date: '2026-11-30', amount: 15.49, varies: false },
    ]);
  });

  it('puts a mortgage on its due date instead of guessing a day from the payments', () => {
    const mortgages = { loans: [{ id: 'l1', status: 'active', startDate: '2025-12-01', monthlyPI: 2000, paymentKeywords: ['demo servicer'] }], payments: [] };
    const txs = [...monthly('DEMO SERVICER', 2000, 26, ['2026-08', '2026-09', '2026-10'], 'housing'), ...monthly('CITY POWER', 90, 20, ['2026-08', '2026-09', '2026-10'])];
    expect(expectedBills(txs, [], '2026-10', mortgages).map(({ name, date, amount }) => [name, date, amount])).toEqual([
      ['Mortgage due', '2026-11-01', 2000],
      ['CITY POWER', '2026-11-20', 90],
    ]);
  });

  it('expects the new price after a fixed price changes', () => {
    const txs = [...monthly('STREAMCO', 15.49, 12, ['2026-08', '2026-09']), debit('2026-10-12', 17.99, 'STREAMCO')];
    expect(expectedBills(txs, [], '2026-10')).toEqual([expect.objectContaining({ name: 'STREAMCO', amount: 17.99, varies: false })]);
  });
});

describe('net worth change', () => {
  it("compares the end of the month with the end of the month before, from the accounts' balances", () => {
    const data = {
      netWorth: {
        accounts: [{ id: 'a1', name: 'Savings', type: 'asset', category: 'bank' }, { id: 'a2', name: 'Card', type: 'liability', category: 'debt' }],
        snapshots: [
          { id: 's1', accountId: 'a1', date: '2026-09-30', balance: 10000 },
          { id: 's2', accountId: 'a1', date: '2026-10-31', balance: 11500 },
          { id: 's3', accountId: 'a2', date: '2026-09-15', balance: 500 },
        ],
      },
    };
    expect(netWorthChange(data, '2026-10')).toEqual({ start: 9500, end: 11000, change: 1500 });
    expect(netWorthChange(data, '2026-08')).toBeNull();
    expect(netWorthChange(data, '2026-09')).toEqual({ start: null, end: 9500, change: null });
  });
});

describe('plan comparison', () => {
  it("works out the month like the projection, mortgage apart, next to the projection's figures", () => {
    const data = {
      transactions: [
        credit('2026-10-15', 4000, 'PAYROLL'),
        debit('2026-10-01', 1800, 'DEMO MORTGAGE CO', 'housing'),
        debit('2026-10-05', 600, 'DEMO GROCER', 'groceries'),
        ...['2026-04', '2026-05', '2026-06'].flatMap((m) => [credit(`${m}-15`, 3000, 'PAYROLL'), debit(`${m}-05`, 900, 'DEMO GROCER', 'groceries')]),
      ],
      mortgages: { loans: [{ id: 'l1', status: 'active', paymentKeywords: ['demo mortgage'], monthlyPI: 1500 }], payments: [] },
      netWorth: { projection: { takeHome: 3500 } },
    };
    expect(planComparison(data, '2026-10', '2026-11-21')).toEqual({
      takeHome: 4000, spending: 600, mortgage: 1800, planTakeHome: 3500, planSpending: 825, planSet: { takeHome: true, spending: false },
    });
  });
});

describe('monthly review', () => {
  const data = {
    transactions: [
      OLD,
      credit('2026-09-15', 3000, 'PAYROLL'),
      debit('2026-09-05', 500, 'DEMO GROCER', 'groceries'),
      credit('2026-10-15', 3200, 'PAYROLL'),
      credit('2026-10-20', 25, 'DEMO STORE REFUND', 'refunds'),
      debit('2026-10-05', 650.4, 'DEMO GROCER', 'groceries'),
      debit('2026-10-08', 120, 'DEMO DINER', 'dining'),
      debit('2026-10-09', 900, 'CARD PAYMENT', 'transfers'),
    ],
    budgets: { groceries: 600, dining: 0 },
  };

  it('adds up the month, last month, the usual, categories and budgets; transfers left out', () => {
    const review = buildMonthlyReview(data, '2026-10', '2026-11-02');
    expect(review).toMatchObject({
      month: '2026-10', complete: true, progress: 1, income: 3225, spending: 770.4,
      previous: { income: 3000, spending: 500 },
      averageSpending: 83, averageMonths: 6,
      budgets: { budgeted: 600, spent: 650.4, left: -50.4, unbudgeted: 120 },
    });
    expect(review.categories).toEqual([
      { id: 'groceries', spent: 650.4, average: 83, budget: 600 },
      { id: 'dining', spent: 120, average: null, budget: null },
    ]);
    expect(buildMonthlyReview(data, '2026-11', '2026-11-02')).toMatchObject({ complete: false, income: 0, spending: 0 });
  });

  it("gives Claude whole dollars and names, and the next month's bills", () => {
    const facts = reviewFacts(buildMonthlyReview(data, '2026-10', '2026-11-02'));
    expect(facts).toMatchObject({
      month: 'October 2026', monthIsOver: true, income: 3225, spending: 770, kept: 2455,
      lastMonth: { income: 3000, spending: 500 },
      usualMonthlySpending: { amount: 83, overMonths: 6 },
      categories: [{ category: 'Groceries', spent: 650, usual: 83, budget: 600 }, { category: 'Dining Out', spent: 120, usual: null, budget: null }],
      budgets: { budgeted: 600, spentInBudgetedCategories: 650, left: -50 },
      billsNextMonth: { month: 'November 2026', total: 0, largest: [] },
      netWorth: null,
    });
  });
});
