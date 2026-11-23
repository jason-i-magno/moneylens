import { describe, it, expect } from 'vitest';
import {
  bankHolidays, billsForMonth, calendarWeeks, detectPaySchedule, isBusinessDay, landingDate, monthTotals, offDayRule, paychecksForMonth, scheduledPaydays,
} from './billCalendar';

let seq = 0;
const debit = (date, amount, name, category = 'utilities') => ({ id: `t${++seq}`, date, amount, name, category, type: 'debit' });
const monthly = (name, amount, day, months, category) => months.map((m) => debit(`${m}-${String(day).padStart(2, '0')}`, amount, name, category));
const HISTORY = ['2026-08', '2026-09', '2026-10'];

const transactions = [
  ...monthly('DEMO SERVICER', 2000, 27, HISTORY, 'housing'),
  ...monthly('DEMO SERVICER', 250, 17, HISTORY, 'housing'), // extra principal
  debit('2026-11-17', 250, 'DEMO SERVICER', 'housing'), // this month's extra principal, not the payment
  ...monthly('STREAMCO', 15.49, 8, HISTORY, 'entertainment'),
  debit('2026-11-08', 17.99, 'STREAMCO', 'entertainment'), // charged this month, at a new price
  ...monthly('CITY POWER', 100, 18, ['2026-08'], 'utilities'),
  debit('2026-09-19', 120, 'CITY POWER'),
  debit('2026-10-18', 110, 'CITY POWER'),
  ...monthly('DEMO ISP', 70, 21, HISTORY, 'utilities'), // due yesterday: not late yet
  ...monthly('DEMO PHONE', 60, 31, ['2026-08'], 'utilities'),
  debit('2026-09-30', 60, 'DEMO PHONE'),
  debit('2026-10-31', 60, 'DEMO PHONE'),
];
const subscriptions = [{ id: 's1', name: 'Cloud Backup', amount: 99, frequency: 'yearly', nextDate: '2025-12-14', category: 'subscriptions' }];
const today = '2026-11-22';
const show = (bills) => bills.map((b) => [b.date, b.name, b.amount, b.status]);

describe('bills for a month', () => {
  it('this month: charged ones on their real date and amount, the rest expected or late', () => {
    expect(show(billsForMonth(transactions, subscriptions, '2026-11', today))).toEqual([
      ['2026-11-08', 'STREAMCO', 17.99, 'charged'],
      ['2026-11-18', 'CITY POWER', 110, 'late'],
      ['2026-11-21', 'DEMO ISP', 70, 'expected'],
      ['2026-11-27', 'DEMO SERVICER', 2000, 'expected'],
      ['2026-11-30', 'DEMO PHONE', 60, 'expected'],
    ]);
  });

  it('a later month: every bill on its day (the 31st becomes the last day), a new price carried on, plus yearly subscriptions due', () => {
    expect(show(billsForMonth(transactions, subscriptions, '2026-12', today))).toEqual([
      ['2026-12-08', 'STREAMCO', 17.99, 'expected'],
      ['2026-12-14', 'Cloud Backup', 99, 'expected'],
      ['2026-12-18', 'CITY POWER', 110, 'expected'],
      ['2026-12-21', 'DEMO ISP', 70, 'expected'],
      ['2026-12-27', 'DEMO SERVICER', 2000, 'expected'],
      ['2026-12-31', 'DEMO PHONE', 60, 'expected'],
    ]);
    expect(billsForMonth(transactions, subscriptions, '2027-02', today).find((b) => b.name === 'DEMO PHONE').date).toBe('2027-02-28');
  });

  it('a past month: what each bill charged', () => {
    expect(show(billsForMonth(transactions, subscriptions, '2026-09', today))).toEqual([
      ['2026-09-08', 'STREAMCO', 15.49, 'charged'],
      ['2026-09-19', 'CITY POWER', 120, 'charged'],
      ['2026-09-21', 'DEMO ISP', 70, 'charged'],
      ['2026-09-27', 'DEMO SERVICER', 2000, 'charged'],
      ['2026-09-30', 'DEMO PHONE', 60, 'charged'],
    ]);
  });

  it('adds up the month and finds its biggest day', () => {
    expect(monthTotals(billsForMonth(transactions, subscriptions, '2026-11', today))).toEqual({
      total: 2257.99, charged: 17.99, toCome: 2240, toComeCount: 4, biggestDay: { date: '2026-11-27', amount: 2000 },
    });
    expect(monthTotals([])).toEqual({ total: 0, charged: 0, toCome: 0, toComeCount: 0, biggestDay: null });
  });
});

describe('calendar weeks', () => {
  it('lays out a month Sunday first, padded with empty days', () => {
    const weeks = calendarWeeks('2026-11'); // November 1, 2026 is a Sunday
    expect(weeks).toHaveLength(5);
    expect(weeks[0]).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect(weeks[4]).toEqual(['2026-11-29', '2026-11-30', null, null, null, null, null]);
    expect(calendarWeeks('2027-05')[0].slice(0, 6)).toEqual([null, null, null, null, null, null]); // May 1, 2027 is a Saturday
  });
});

describe('business days', () => {
  it('knows the federal bank holidays, moving a Sunday one to Monday and not a Saturday one', () => {
    expect([...bankHolidays(2026)].sort()).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    ]); // July 4, 2026 is a Saturday
    expect(bankHolidays(2027).has('2027-07-05')).toBe(true); // July 4, 2027 is a Sunday
    expect(bankHolidays(2027).has('2027-12-24')).toBe(false); // Christmas 2027 is a Saturday
    expect([isBusinessDay('2026-11-21'), isBusinessDay('2026-11-26'), isBusinessDay('2026-11-27')]).toEqual([false, false, true]);
  });

  it('moves a day to the next or previous business day, into the next or previous month if need be', () => {
    expect(landingDate('2026-11-21', 'later')).toBe('2026-11-23');
    expect(landingDate('2026-11-21', 'earlier')).toBe('2026-11-20');
    expect(landingDate('2026-11-21', 'stay')).toBe('2026-11-21');
    expect(landingDate('2026-11-26', 'later')).toBe('2026-11-27'); // Thanksgiving
    expect(landingDate('2026-11-24', 'later')).toBe('2026-11-24');
    expect(landingDate('2026-05-31', 'later')).toBe('2026-06-01');
    expect(landingDate('2026-08-01', 'earlier')).toBe('2026-07-31');
  });
});

describe('how a bill lands on a weekend or holiday', () => {
  const ACCOUNTS = [
    { id: 'a1', name: 'Checking', type: 'asset', category: 'bank', linkedBankProfile: 'bank' },
    { id: 'a2', name: 'Card', type: 'liability', category: 'debt', linkedBankProfile: 'card' },
  ];
  const paid = (date, amount, name, source) => ({ ...debit(date, amount, name), importedFrom: source });
  const bill = (key, day, amount, source) => ({ key, day, amount, source });

  it('learns it from the times its day fell on one', () => {
    // the 22nd: Sunday in March, Saturday in August
    const later = [paid('2026-03-23', 80, 'CITY POWER', 'bank'), paid('2026-07-22', 80, 'CITY POWER', 'bank'), paid('2026-08-24', 80, 'CITY POWER', 'bank')];
    expect(offDayRule(bill('city power', 22, 80, 'bank'), later, '2026-11', ACCOUNTS)).toEqual({ rule: 'later', learned: true });
    // the 27th: Saturday in June, Sunday in September
    const earlier = [paid('2026-06-26', 2000, 'DEMO SERVICER', 'bank'), paid('2026-09-25', 2000, 'DEMO SERVICER', 'bank')];
    expect(offDayRule(bill('demo servicer', 27, 2000, 'bank'), earlier, '2026-11', ACCOUNTS)).toEqual({ rule: 'earlier', learned: true });
    // the 21st: a Sunday in June, charged that day
    expect(offDayRule(bill('demo isp', 21, 70, 'card'), [paid('2026-06-21', 70, 'DEMO ISP', 'card')], '2026-11', ACCOUNTS)).toEqual({ rule: 'stay', learned: true });
    // the 8th: a Saturday in August, charged on the Sunday: it doesn't avoid weekends
    expect(offDayRule(bill('streamco', 8, 16, 'card'), [paid('2026-08-09', 16, 'STREAMCO', 'card')], '2026-11', ACCOUNTS)).toEqual({ rule: 'stay', learned: true });
  });

  it('counts only charges from the account it is paid from now', () => {
    const txs = [
      paid('2026-02-23', 70, 'DEMO ISP', 'bank'), paid('2026-03-23', 70, 'DEMO ISP', 'bank'), // the 22nd, when it came from checking
      paid('2026-06-21', 70, 'DEMO ISP', 'card'), // since moving to the card
    ];
    expect(offDayRule(bill('demo isp', 21, 70, 'card'), txs, '2026-11', ACCOUNTS).rule).toBe('stay');
  });

  it("without any, a bank account's bills move later and a card's stay", () => {
    expect(offDayRule(bill('demo gym', 21, 30, 'bank'), [], '2026-11', ACCOUNTS)).toEqual({ rule: 'later', learned: false });
    expect(offDayRule(bill('demo gym', 21, 30, 'card'), [], '2026-11', ACCOUNTS)).toEqual({ rule: 'stay', learned: false });
    expect(offDayRule(bill('demo gym', 21, 30, 'unknown'), [], '2026-11', ACCOUNTS)).toEqual({ rule: 'stay', learned: false });
  });

  it('puts the bill on the day it will land, and says where it moved from', () => {
    const txs = ['2026-08-21', '2026-09-21', '2026-10-21'].map((d) => paid(d, 45, 'DEMO GYM', 'bank'));
    const [gym] = billsForMonth(txs, [], '2026-11', '2026-11-22', ACCOUNTS);
    expect(gym).toMatchObject({ date: '2026-11-23', movedFrom: '2026-11-21', status: 'expected' });
    const onCard = billsForMonth(txs.map((t) => ({ ...t, importedFrom: 'card' })), [], '2026-11', '2026-11-22', ACCOUNTS)[0];
    expect(onCard.date).toBe('2026-11-21');
    expect(onCard.movedFrom).toBeUndefined();
  });

  it('lets a bill land in the next month, and shows it there', () => {
    // the 27th from checking: February 27, 2027 is a Saturday, so it lands Monday, March 1
    const txs = ['2026-08-27', '2026-09-28', '2026-10-27'].map((d) => paid(d, 120, 'DEMO INSURER', 'bank'));
    const days = (m) => billsForMonth(txs, [], m, '2026-11-22', ACCOUNTS).map((b) => [b.date, b.movedFrom]);
    expect(days('2027-02')).toEqual([]);
    expect(days('2027-03')).toEqual([['2027-03-01', '2027-02-27'], ['2027-03-29', '2027-03-27']]);
  });
});

describe('a mortgage paid by hand', () => {
  // Due on the 1st (the loan started on a 1st), paid a few days early, plus smaller extra-principal payments
  const mortgages = {
    loans: [{ id: 'l1', label: 'Demo loan', status: 'active', startDate: '2025-12-01', monthlyPI: 2000, paymentKeywords: ['demo servicer'] }],
    payments: [{ loanId: 'l1', forMonth: '2026-10', escrow: 0 }],
  };
  const pay = (date, amount) => ({ ...debit(date, amount, 'DEMO SERVICER PMT', 'housing'), importedFrom: 'bank' });
  const txs = [pay('2026-08-27', 2000), pay('2026-09-25', 2000), pay('2026-09-04', 1000), pay('2026-10-27', 2000), pay('2026-10-22', 300), pay('2026-11-17', 300)];
  const show = (bills) => bills.map((b) => [b.date, b.name, b.amount, b.status, b.paidOn || b.forDue || null]);

  it('shows the due date as paid on the day it was paid, and the payment on the day it left the account', () => {
    expect(show(billsForMonth(txs, [], '2026-10', '2026-11-22', [], mortgages))).toEqual([
      ['2026-10-01', 'Mortgage due', 2000, 'paid', '2026-09-25'],
      ['2026-10-27', 'Mortgage payment', 2000, 'charged', '2026-11-01'],
    ]);
  });

  it("doesn't count a due date paid ahead again, and doesn't guess a day from the payments", () => {
    const november = billsForMonth(txs, [], '2026-11', '2026-11-22', [], mortgages);
    expect(show(november)).toEqual([['2026-11-01', 'Mortgage due', 2000, 'paid', '2026-10-27']]);
    expect(monthTotals(november)).toMatchObject({ total: 0, toCome: 0, biggestDay: null });
  });

  it('expects the next due date, and calls it unpaid once it goes by without a payment', () => {
    expect(show(billsForMonth(txs, [], '2026-12', '2026-11-22', [], mortgages))).toEqual([['2026-12-01', 'Mortgage due', 2000, 'expected', null]]);
    expect(show(billsForMonth(txs, [], '2026-12', '2026-12-03', [], mortgages))).toEqual([['2026-12-01', 'Mortgage due', 2000, 'unpaid', null]]);
    // a payment a few days late still counts
    const late = [...txs, pay('2026-12-04', 2000)];
    expect(show(billsForMonth(late, [], '2026-12', '2026-12-05', [], mortgages))).toEqual([
      ['2026-12-01', 'Mortgage due', 2000, 'paid', '2026-12-04'],
      ['2026-12-04', 'Mortgage payment', 2000, 'charged', '2026-12-01'],
    ]);
  });

  it('nothing before the first payment is due', () => {
    expect(billsForMonth([], [], '2025-12', '2025-12-10', [], mortgages)).toEqual([]);
    expect(show(billsForMonth([], [], '2026-01', '2025-12-10', [], mortgages))).toEqual([['2026-01-01', 'Mortgage due', 2000, 'expected', null]]);
  });
});

describe('paychecks', () => {
  const deposit = (date, amount, name = 'DEMO EMPLOYER PAYROLL') => ({ id: `d${++seq}`, date, amount, name, category: 'salary', type: 'credit' });
  // Weekly on Wednesdays; Veterans Day (Wednesday, November 11, 2026) paid on the Tuesday before
  const weekly = [
    ...['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']
      .map((d) => deposit(d, 1900)),
    deposit('2026-11-10', 1903),
    deposit('2026-11-18', 1900),
    deposit('2026-10-16', 1000, 'DEMO BANK BONUS'), // salary-categorized, but not from the employer
    deposit('2026-10-30', 1000, 'DEMO BANK BONUS'),
  ];
  const show = (list) => list.map((p) => [p.date, p.amount, p.status, p.movedFrom || null]);

  it('learns a weekly schedule from the employer, not other salary deposits', () => {
    expect(detectPaySchedule(weekly, '2026-11-22')).toMatchObject({ key: 'demo employer payroll', kind: 'weekly', every: 7, anchor: '2026-11-18', amount: 1900, varies: false });
  });

  it("shows this month's paychecks as received and the rest as expected", () => {
    expect(show(paychecksForMonth(weekly, '2026-11', '2026-11-22'))).toEqual([
      ['2026-11-04', 1900, 'received', null],
      ['2026-11-10', 1903, 'received', null],
      ['2026-11-18', 1900, 'received', null],
      ['2026-11-25', 1900, 'expected', null],
    ]);
    expect(show(paychecksForMonth(weekly, '2026-10', '2026-11-22')).map((p) => p[0])).toEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28']);
    expect(paychecksForMonth(weekly, '2026-12', '2026-11-22').map((p) => p.date)).toEqual(['2026-12-02', '2026-12-09', '2026-12-16', '2026-12-23', '2026-12-30']);
  });

  it('expects a holiday payday on the business day before, and calls a missing one late after 2 days', () => {
    expect(show(paychecksForMonth(weekly.filter((d) => d.date !== '2026-11-10'), '2026-11', '2026-11-09'))).toContainEqual(['2026-11-10', 1900, 'expected', '2026-11-11']);
    const missing = weekly.filter((d) => d.date !== '2026-11-18');
    expect(show(paychecksForMonth(missing, '2026-11', '2026-11-21'))).toContainEqual(['2026-11-18', 1900, 'late', null]);
    expect(show(paychecksForMonth(missing, '2026-11', '2026-11-20'))).toContainEqual(['2026-11-18', 1900, 'expected', null]);
  });

  it('learns every two weeks and twice a month too, moving weekend and holiday paydays earlier', () => {
    const biweekly = ['2026-10-02', '2026-10-16', '2026-10-30', '2026-11-13'].map((d) => deposit(d, 2500));
    const bi = detectPaySchedule(biweekly, '2026-11-22');
    expect(bi).toMatchObject({ kind: 'biweekly', every: 14, anchor: '2026-11-13' });
    expect(scheduledPaydays(bi, '2026-12')).toEqual([{ date: '2026-12-11', usual: '2026-12-11' }, { date: '2026-12-24', usual: '2026-12-25' }]);

    const semi = ['2026-09-15', '2026-09-30', '2026-10-15', '2026-10-30', '2026-11-13'].map((d) => deposit(d, 3000));
    const twice = detectPaySchedule(semi, '2026-11-22');
    expect(twice).toMatchObject({ kind: 'semimonthly', days: [15, 28] });
    // May 15, 2027 is a Saturday; May 31 is Memorial Day
    expect(scheduledPaydays(twice, '2027-05').map((p) => p.date)).toEqual(['2027-05-14', '2027-05-28']);
  });

  it('needs at least 3 recent paydays', () => {
    expect(detectPaySchedule([deposit('2026-11-04', 1900), deposit('2026-11-11', 1900)], '2026-11-22')).toBeNull();
    expect(paychecksForMonth([], '2026-11', '2026-11-22')).toEqual([]);
  });
});
