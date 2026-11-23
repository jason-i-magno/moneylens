// Bills calendar: the days recurring charges land on in a month: charged already, still to come, or late
import { addDays, addMonths, daysBetween, daysInMonth } from './dates';
import { detectBills, merchantKey, mortgageBills, mortgageDueDate, subscriptionsDue, withoutMortgagePayments } from './review';
import { isIncome, isSpending, roundCents, sumAmounts } from './transactions';

const pad = (n) => String(n).padStart(2, '0');
// Card charges take a day or two to post, so a bill is late only this many days after its day
export const LATE_AFTER_DAYS = 3;

const weekday = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).getDay();

// The nth weekday (0 = Sunday) of a month, or the last one with n = -1
function nthWeekday(year, month, day, n) {
  const ym = `${year}-${pad(month)}`;
  if (n > 0) return `${ym}-${pad(1 + ((day - weekday(`${ym}-01`) + 7) % 7) + (n - 1) * 7)}`;
  const last = daysInMonth(ym);
  return `${ym}-${pad(last - ((weekday(`${ym}-${pad(last)}`) - day + 7) % 7))}`;
}

// Federal bank holidays in a year, as the Federal Reserve observes them: one on a Sunday moves to Monday, one on
// a Saturday isn't moved (banks open the Friday before)
const holidayCache = new Map();
export function bankHolidays(year) {
  if (!holidayCache.has(year)) {
    const fixed = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]].flatMap(([m, d]) => {
      const date = `${year}-${pad(m)}-${pad(d)}`;
      const dow = weekday(date);
      return dow === 6 ? [] : [dow === 0 ? addDays(date, 1) : date];
    });
    holidayCache.set(year, new Set([
      ...fixed,
      nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
      nthWeekday(year, 2, 1, 3), // Washington's Birthday
      nthWeekday(year, 5, 1, -1), // Memorial Day
      nthWeekday(year, 9, 1, 1), // Labor Day
      nthWeekday(year, 10, 1, 2), // Columbus Day
      nthWeekday(year, 11, 4, 4), // Thanksgiving
    ]));
  }
  return holidayCache.get(year);
}

export const isBusinessDay = (date) => weekday(date) % 6 !== 0 && !bankHolidays(Number(date.slice(0, 4))).has(date);

// Why a day isn't a business day, for showing a bill that moved
export const offDayReason = (date) => (weekday(date) % 6 === 0 ? 'weekend' : 'bank holiday');

// How a bill lands when its day isn't a business day: 'stay', 'later' (the next business day) or 'earlier' (the
// business day before). Learned from the times its day fell on a weekend or bank holiday in the 12 months before
// `month`, counting only charges from the account it's paid from now (a bill that moved to a card behaves like the
// card). A charge that still landed on a weekend or holiday counts as staying: it doesn't avoid them, it was just
// a day off. Without any, a bank account's bills move later (debits don't post on weekends or bank holidays) and a
// card's stay. { rule, learned }
export function offDayRule(bill, transactions, month, accounts = []) {
  const votes = { stay: 0, later: 0, earlier: 0 };
  for (let i = 1; i <= 12; i++) {
    const m = addMonths(month, -i);
    const usual = `${m}-${pad(Math.min(bill.day, daysInMonth(m)))}`;
    if (isBusinessDay(usual)) continue;
    const charge = transactions
      .filter((tx) => tx.importedFrom === bill.source && tx.date && Math.abs(daysBetween(usual, tx.date)) <= 5 && isSpending(tx)
        && tx.amount >= bill.amount / 2 && tx.amount <= bill.amount * 2 && merchantKey(tx.name) === bill.key)
      .sort((a, b) => Math.abs(daysBetween(usual, a.date)) - Math.abs(daysBetween(usual, b.date)))[0];
    if (charge) votes[charge.date === usual || !isBusinessDay(charge.date) ? 'stay' : charge.date > usual ? 'later' : 'earlier'] += 1;
  }
  const [rule, count] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  if (count > 0) return { rule, learned: true };
  const account = accounts.find((a) => a.linkedBankProfile && a.linkedBankProfile === bill.source);
  return { rule: account?.type === 'asset' ? 'later' : 'stay', learned: false };
}

// The day a bill lands: its day, or the next or previous business day by its rule (which can be in the next or
// previous month)
export function landingDate(date, rule) {
  if (rule === 'stay' || isBusinessDay(date)) return date;
  const dir = rule === 'later' ? 1 : -1;
  let d = addDays(date, dir);
  while (!isBusinessDay(d)) d = addDays(d, dir);
  return d;
}

// A charge is a bill's when it's from the same merchant, between half and double the bill's amount (so a
// mortgage's small extra-principal payments aren't taken for the payment itself), within this many days of the
// day the bill lands
const CHARGE_WITHIN_DAYS = 7;
function chargeNear(bill, transactions, date, today) {
  return transactions
    .filter((tx) => tx.date && tx.date <= today && Math.abs(daysBetween(date, tx.date)) <= CHARGE_WITHIN_DAYS && isSpending(tx)
      && tx.amount >= bill.amount / 2 && tx.amount <= bill.amount * 2 && merchantKey(tx.name) === bill.key)
    .sort((a, b) => Math.abs(daysBetween(date, a.date)) - Math.abs(daysBetween(date, b.date)))[0] || null;
}

// A mortgage payment counts toward the due date it's closest to, from this many days before it to this many after
const PAID_BEFORE_DAYS = 25;
const PAID_AFTER_DAYS = 15;

// A mortgage loan's entries in `month`: its due date (paid, with the day it was paid; or expected, or unpaid once
// it has gone by), and each payment made in the month, on the day it left the account. Due dates from two months
// before through the month after are matched in order, each to the closest payment of at least the scheduled
// amount (95%, for escrow changes; extra-principal payments are smaller) that an earlier one didn't take.
function mortgageEntries(loan, transactions, month, today) {
  const payments = transactions.filter((tx) => tx.date && tx.date <= today && isSpending(tx) && tx.amount >= loan.amount * 0.95 && loan.isPayment(tx));
  const taken = new Set();
  const entries = [];
  const base = { name: 'Mortgage due', detail: loan.label, category: 'housing', varies: false, mortgage: true };
  for (const m of [addMonths(month, -2), addMonths(month, -1), month, addMonths(month, 1)]) {
    const due = mortgageDueDate(loan, m);
    if (!due) continue;
    const payment = payments
      .filter((tx) => !taken.has(tx.id) && daysBetween(tx.date, due) <= PAID_BEFORE_DAYS && daysBetween(due, tx.date) <= PAID_AFTER_DAYS)
      .sort((a, b) => Math.abs(daysBetween(a.date, due)) - Math.abs(daysBetween(b.date, due)))[0];
    if (payment) taken.add(payment.id);
    if (due.startsWith(month)) {
      entries.push({
        ...base,
        key: `due:${loan.id}:${due}`,
        date: due,
        amount: loan.amount,
        ...(payment ? { status: 'paid', paidOn: payment.date } : { status: due < today ? 'unpaid' : 'expected' }),
      });
    }
    if (payment?.date.startsWith(month)) {
      entries.push({ ...base, key: `pay:${loan.id}:${due}`, name: 'Mortgage payment', date: payment.date, amount: payment.amount, status: 'charged', forDue: due, transactionId: payment.id });
    }
  }
  return entries;
}

const usualDate = (bill, month) => `${month}-${pad(Math.min(bill.day, daysInMonth(month)))}`;

// The bills of `month` ('YYYY-MM') as of `today`, by date. Recurring bills are the ones charged on about the same
// day in each of the 3 full months before today's month (detectBills). Each month's bill lands on its day, or, when
// that isn't a business day, where the bill has moved before (offDayRule, landingDate; `movedFrom`), which can be in
// the month before or after. A bill whose charge has posted shows the charge (its real date and amount); one that
// hasn't is expected, or late LATE_AFTER_DAYS after it lands; in a past month only charges show. A later month uses
// this month's amount once it has posted (a fixed price that just changed). Mortgage loans show on their due date
// and their payments on the day they were made (mortgageEntries), not as a guessed day: a manual payment lands
// whenever the user makes it. Quarterly and yearly manual subscriptions are added on their due dates (`manual`).
// status: 'charged' | 'expected' | 'late' | 'due' (a manual subscription's day, nothing to match it against) |
// 'paid' (a mortgage due date already paid: its money left with the payment, so it isn't counted again) | 'unpaid'
// accounts: the Net Worth accounts, to tell a bank account's bills from a card's; mortgages: data.mortgages
export function billsForMonth(transactions, subscriptions, month, today, accounts = [], mortgages = null) {
  const current = today.slice(0, 7);
  const bills = [];
  const loans = mortgageBills(mortgages);
  const others = withoutMortgagePayments(transactions, loans);
  const series = detectBills(others, addMonths(current, -1));
  for (const bill of series) {
    const { rule } = offDayRule(bill, others, current, accounts);
    const base = { key: bill.key, name: bill.name, category: bill.category, varies: bill.varies };
    const thisMonth = bill.varies ? null : chargeNear(bill, others, landingDate(usualDate(bill, current), rule), today);
    for (const m of [addMonths(month, -1), month, addMonths(month, 1)]) {
      const usual = usualDate(bill, m);
      const date = landingDate(usual, rule);
      const charged = chargeNear(bill, others, date, today);
      if ((charged ? charged.date : date).slice(0, 7) !== month) continue;
      if (charged) {
        bills.push({ ...base, key: `${bill.key}:${m}`, date: charged.date, amount: charged.amount, varies: false, status: 'charged', transactionId: charged.id });
      } else if (date >= `${current}-01`) {
        bills.push({
          ...base,
          key: `${bill.key}:${m}`,
          date,
          ...(date !== usual && { movedFrom: usual }),
          amount: m > current && thisMonth ? thisMonth.amount : bill.amount,
          status: addDays(date, LATE_AFTER_DAYS) < today ? 'late' : 'expected',
        });
      }
    }
  }
  for (const loan of loans) bills.push(...mortgageEntries(loan, transactions, month, today));
  for (const sub of subscriptionsDue(subscriptions, month, series)) {
    bills.push({ ...sub, status: sub.date < today ? 'due' : 'expected' });
  }
  return bills.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

// Whether an entry is money leaving in its month (a mortgage due date paid ahead isn't: its payment is)
export const counts = (bill) => bill.status !== 'paid';

// The month's totals: everything, what has been charged, what's still to come (expected, late or unpaid), and the
// biggest day; mortgage due dates paid ahead don't count
export function monthTotals(entries) {
  const bills = entries.filter(counts);
  const byDay = new Map();
  for (const b of bills) byDay.set(b.date, (byDay.get(b.date) || 0) + b.amount);
  const [biggestDate, biggestAmount] = [...byDay].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const toCome = bills.filter((b) => b.status === 'expected' || b.status === 'late' || b.status === 'unpaid');
  return {
    total: roundCents(sumAmounts(bills)),
    charged: roundCents(sumAmounts(bills.filter((b) => b.status === 'charged'))),
    toCome: roundCents(sumAmounts(toCome)),
    toComeCount: toCome.length,
    biggestDay: biggestDate && { date: biggestDate, amount: roundCents(biggestAmount) },
  };
}

// The weeks of `month` for a calendar grid, Sunday first: each a list of 7 dates, null outside the month
export function calendarWeeks(month) {
  const [y, m] = month.split('-').map(Number);
  const lead = new Date(y, m - 1, 1).getDay();
  const days = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${pad(i + 1)}`)];
  while (days.length % 7) days.push(null);
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7));
}

// Paychecks: deposits categorized Salary from the employer, the payer that deposited on the most days in the 120
// days before today (bank bonuses and other Salary deposits from someone else aren't paychecks). Deposits on the
// same day are one paycheck (a paycheck split across accounts).
const PAY_LOOKBACK_DAYS = 120;
// A payday more than this many days late without a deposit is "not deposited yet"
export const PAY_LATE_AFTER_DAYS = 2;
// A deposit within this many days of a payday is that payday's paycheck (paid early before a holiday, or by a bank
// that releases direct deposits early)
const PAY_WITHIN_DAYS = 3;

function paydaysOf(transactions, key) {
  const byDate = new Map();
  for (const tx of transactions) {
    if (!tx.date || !isIncome(tx) || tx.category !== 'salary' || merchantKey(tx.name) !== key) continue;
    byDate.set(tx.date, [...(byDate.get(tx.date) || []), tx]);
  }
  return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, txs]) => ({ date, amount: roundCents(sumAmounts(txs)), txs }));
}

const mode = (values) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
};

// The pay schedule from the employer's recent paydays, or null without at least 3 of them. kind: 'weekly' or
// 'biweekly' (an anchor payday on the usual weekday, stepped by 7 or 14 days), 'semimonthly' (two days of the
// month; 28 or later means the last day) or 'monthly' (one day). With the payer's key and name and the usual
// amount (the median of the last 4 paychecks; `varies` when they differ by more than 1%).
export function detectPaySchedule(transactions, today) {
  const since = addDays(today, -PAY_LOOKBACK_DAYS);
  const recent = transactions.filter((tx) => tx.date >= since && tx.date <= today && isIncome(tx) && tx.category === 'salary');
  const key = mode([...new Set(recent.map((tx) => `${merchantKey(tx.name)}|${tx.date}`))].map((k) => k.split('|')[0]).filter(Boolean));
  if (!key) return null;
  const paydays = paydaysOf(transactions, key).filter((p) => p.date >= since && p.date <= today);
  if (paydays.length < 3) return null;
  const gaps = paydays.slice(1).map((p, i) => daysBetween(paydays[i].date, p.date)).sort((a, b) => a - b);
  const gap = gaps[gaps.length >> 1];
  const last4 = paydays.slice(-4).map((p) => p.amount).sort((a, b) => a - b);
  const amount = roundCents((last4[(last4.length - 1) >> 1] + last4[last4.length >> 1]) / 2);
  const latest = paydays.at(-1).txs.at(-1);
  const base = { key, name: latest.merchantName || latest.name, amount, varies: last4.at(-1) - last4[0] > amount * 0.01 };
  if (gap <= 10 || (gap >= 12 && gap <= 16 && new Set(paydays.map((p) => weekday(p.date))).size <= 2)) {
    const day = mode(paydays.slice(-8).map((p) => weekday(p.date)));
    const anchor = [...paydays].reverse().find((p) => weekday(p.date) === day).date;
    return { ...base, kind: gap <= 10 ? 'weekly' : 'biweekly', anchor, every: gap <= 10 ? 7 : 14 };
  }
  const dayOf = (p) => Math.min(Number(p.date.slice(8, 10)), 28);
  if (gap <= 20) {
    const days = paydays.slice(-8).map(dayOf);
    return { ...base, kind: 'semimonthly', days: [mode(days.filter((d) => d <= 15)), mode(days.filter((d) => d > 15))].filter(Boolean) };
  }
  return { ...base, kind: 'monthly', days: [mode(paydays.slice(-6).map(dayOf))] };
}

// A schedule's paydays in `month`, each moved to the business day before when it falls on a weekend or holiday
// (`movedFrom`)
export function scheduledPaydays(schedule, month) {
  const first = `${month}-01`;
  const last = `${month}-${pad(daysInMonth(month))}`;
  let dates;
  if (schedule.every) {
    const start = daysBetween(schedule.anchor, first);
    let d = addDays(schedule.anchor, Math.ceil(start / schedule.every) * schedule.every);
    dates = [];
    for (; d <= last; d = addDays(d, schedule.every)) dates.push(d);
  } else {
    dates = schedule.days.map((day) => `${month}-${pad(day >= 28 ? daysInMonth(month) : day)}`);
  }
  return dates.map((usual) => {
    let date = usual;
    while (!isBusinessDay(date)) date = addDays(date, -1);
    return { date, usual };
  });
}

// The paychecks of `month` as of `today`, by date: each deposit from the employer (status 'received', its real
// date and amount), and each scheduled payday from today's month on that no deposit within 3 days covers:
// 'expected', or 'late' PAY_LATE_AFTER_DAYS after it
export function paychecksForMonth(transactions, month, today) {
  const schedule = detectPaySchedule(transactions, today);
  if (!schedule) return [];
  const all = paydaysOf(transactions, schedule.key);
  const base = { name: 'Paycheck', payer: schedule.name, category: 'salary', income: true };
  const entries = all
    .filter((p) => p.date.startsWith(month) && p.date <= today)
    .map((p) => ({ ...base, key: `pay:${p.date}`, date: p.date, amount: p.amount, varies: false, status: 'received' }));
  if (month < today.slice(0, 7)) return entries;
  for (const { date, usual } of scheduledPaydays(schedule, month)) {
    if (all.some((p) => Math.abs(daysBetween(date, p.date)) <= PAY_WITHIN_DAYS)) continue;
    entries.push({
      ...base,
      key: `payday:${date}`,
      date,
      ...(date !== usual && { movedFrom: usual }),
      amount: schedule.amount,
      varies: schedule.varies,
      status: addDays(date, PAY_LATE_AFTER_DAYS) < today ? 'late' : 'expected',
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}
