// Monthly money review: what happened in one month, worked out from the data. The Review page shows it, and
// reviewFacts() is what Claude writes the summary from (server/reviewApi.js).
import { isIncome, isSpending, roundCents, sumAmounts } from './transactions';
import { averageSpending, budgetTotals, monthProgress, monthSpending } from './budgets';
import { addMonths, daysInMonth, formatMonth } from './dates';
import { baselineLoans, cashFlowBaseline } from './projection';
import { buildBalanceTimeline, buildNetWorthHistory } from './netWorth';
import { CATEGORY_MAP, SPENDING_CATEGORIES } from '../constants/categories';
import { keywordRegex } from './categorizer';

// A charge from a merchant not seen in the 12 months before, at least this much, is worth a look
export const NEW_MERCHANT_MIN = 100;
// A charge at least this many times the merchant's usual, and this much more, is worth a look
export const LARGE_FACTOR = 2;
export const LARGE_MIN_EXTRA = 50;
// A bill's day of the month moves at most this much between months (random visits don't line up)
const BILL_DAY_SPREAD = 6;

const pad = (n) => String(n).padStart(2, '0');
const cents = (n) => Math.round(n * 100);
const monthOf = (tx) => tx.date?.slice(0, 7);
const lastDay = (month) => `${month}-${pad(daysInMonth(month))}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const displayName = (tx) => tx.merchantName || tx.name;

// Words that don't tell merchants apart ("STREAMCO USA", "SHOPCO MKTPL", "DEMO CO")
const FILLER_WORDS = new Set(['usa', 'us', 'inc', 'llc', 'ltd', 'co', 'corp', 'com', 'www', 'the', 'pc', 'mktp', 'mktpl', 'marketplace', 'online', 'bill', 'billing', 'pmt', 'autopay', 'purchase', 'recurring', 'pos']);

// Who a charge is from, for comparing charges over time: the bank's description without a card-processor
// prefix ("SQ *", "TST*", "PAYPAL *"), anything after a "*" (order numbers), words with digits (store numbers,
// reference codes), punctuation and filler words; the first three words left. Built from the description, not
// Plaid's merchant name, so CSV history and synced rows agree.
export function merchantKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^(sq|tst|pp|paypal|sp|dd|py|cke|bt|ic|pos|ppl)\s?\*\s*/, '')
    .replace(/\*.*$/, '')
    .split(/\s+/)
    .filter((w) => !/\d/.test(w))
    .join(' ')
    .replace(/[^a-z&]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1 && !FILLER_WORDS.has(w))
    .slice(0, 3)
    .join(' ');
}

// Spending from `from` to `to` (dates, inclusive) grouped by merchantKey, each list oldest first
function chargesByMerchant(transactions, from, to) {
  const map = new Map();
  for (const tx of transactions) {
    if (!tx.date || tx.date < from || tx.date > to || !isSpending(tx)) continue;
    const key = merchantKey(tx.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(tx);
  }
  for (const list of map.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

const firstDate = (transactions) => transactions.reduce((min, tx) => (tx.date && (!min || tx.date < min) ? tx.date : min), null);

// Charges in `month` worth a look, largest first, at most one per merchant: from a merchant not seen in the 12
// months before (at least NEW_MERCHANT_MIN), or well above what that merchant usually charges (its median, with
// at least 3 earlier charges) and more than any of its charges in the year before, so a merchant with a big
// regular charge and small extra ones (a mortgage and extra principal) isn't flagged every month. New merchants
// count only once there's 3 months of history before the month.
export function unusualCharges(transactions, month, limit = 6) {
  const start = `${month}-01`;
  const history = firstDate(transactions);
  const judgeNew = history && history <= `${addMonths(month, -3)}-01`;
  const found = [];
  for (const list of chargesByMerchant(transactions, `${addMonths(month, -12)}-01`, lastDay(month)).values()) {
    const before = list.filter((t) => t.date < start);
    const usual = before.length >= 3 ? median(before.map((t) => t.amount)) : null;
    const highest = Math.max(0, ...before.map((t) => t.amount));
    const flagged = list
      .filter((t) => t.date >= start)
      .map((tx) => {
        if (before.length === 0 && judgeNew && tx.amount >= NEW_MERCHANT_MIN) return { kind: 'new', tx };
        if (usual !== null && tx.amount > highest && tx.amount >= usual * LARGE_FACTOR && tx.amount - usual >= LARGE_MIN_EXTRA) {
          return { kind: 'large', tx, usual: roundCents(usual) };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.tx.amount - a.tx.amount);
    if (flagged[0]) found.push(flagged[0]);
  }
  return found
    .sort((a, b) => b.tx.amount - a.tx.amount)
    .slice(0, limit)
    .map(({ kind, tx, usual }) => ({ kind, name: displayName(tx), amount: tx.amount, date: tx.date, category: tx.category, transactionId: tx.id, ...(usual !== undefined && { usual }) }));
}

// Fixed-price charges that went up in `month`: one charge this month, and one in each of the merchant's two
// latest earlier months (within 6) at exactly the same amount, lower than this month's. Bills that vary
// (utilities) never match.
export function priceIncreases(transactions, month) {
  const found = [];
  for (const list of chargesByMerchant(transactions, `${addMonths(month, -6)}-01`, lastDay(month)).values()) {
    const byMonth = new Map();
    for (const tx of list) byMonth.set(monthOf(tx), [...(byMonth.get(monthOf(tx)) || []), tx]);
    const now = byMonth.get(month);
    const earlier = [...byMonth.keys()].filter((m) => m < month).sort().reverse();
    if (now?.length !== 1 || earlier.length < 2) continue;
    const [a, b] = earlier.map((m) => byMonth.get(m));
    if (a.length !== 1 || b.length !== 1 || cents(a[0].amount) !== cents(b[0].amount)) continue;
    const [tx] = now;
    if (cents(tx.amount) - cents(a[0].amount) < 50) continue;
    found.push({ name: displayName(tx), from: a[0].amount, to: tx.amount, date: tx.date, category: tx.category, transactionId: tx.id });
  }
  return found.sort((x, y) => y.to - y.from - (x.to - x.from));
}

// Recurring charges that started lately: a merchant charged once in `month` and once the month before, on about
// the same day and amount (within 10%), and not in the 7 months before that; or a subscription charged for the
// first time in a year. Needs 8 months of history before the month.
export function newRecurring(transactions, month) {
  const history = firstDate(transactions);
  if (!history || history > `${addMonths(month, -8)}-01`) return [];
  const prev = addMonths(month, -1);
  const found = [];
  for (const list of chargesByMerchant(transactions, `${addMonths(month, -12)}-01`, lastDay(month)).values()) {
    const last = list.at(-1);
    if (monthOf(last) !== month) continue;
    const older = list.filter((t) => monthOf(t) < prev);
    const inPrev = list.filter((t) => monthOf(t) === prev);
    const inMonth = list.filter((t) => monthOf(t) === month);
    const recentOlder = older.filter((t) => t.date >= `${addMonths(month, -8)}-01`);
    if (inPrev.length === 1 && inMonth.length === 1 && !recentOlder.length) {
      const before = inPrev[0];
      const sameDay = Math.abs(Number(last.date.slice(8, 10)) - Number(before.date.slice(8, 10))) <= BILL_DAY_SPREAD;
      if (sameDay && Math.abs(last.amount - before.amount) <= 0.1 * Math.max(last.amount, before.amount)) {
        found.push({ name: displayName(last), amount: last.amount, since: prev, category: last.category });
        continue;
      }
    }
    if (last.isSubscription && !older.length && !inPrev.length) {
      found.push({ name: displayName(last), amount: last.amount, since: month, category: last.category, subscription: true });
    }
  }
  return found.sort((a, b) => b.amount - a.amount);
}

// The day a quarterly or yearly manual subscription is due in `month`, stepping its nextDate forward
const STEP_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
function dueIn(sub, month) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sub.nextDate || '')) return null;
  const day = Number(sub.nextDate.slice(8, 10));
  const step = STEP_MONTHS[sub.frequency] || 1;
  let m = sub.nextDate.slice(0, 7);
  while (m < month) m = addMonths(m, step);
  return m === month ? `${month}-${pad(Math.min(day, daysInMonth(month)))}` : null;
}

// Recurring bills in the 3 months ending with `month`: merchants charged in each of them whose largest charge
// each month came on about the same day (a mortgage payment, not the extra principal; random visits don't line
// up). Each with its day of the month (the latest) and its amount: the latest when the two before it were the
// same (a fixed price, perhaps just changed), else about the average (`varies`).
export function detectBills(transactions, month) {
  const months = [addMonths(month, -2), addMonths(month, -1), month];
  const bills = [];
  for (const [key, all] of chargesByMerchant(transactions, `${months[0]}-01`, lastDay(month))) {
    const list = months.map((m) => all.filter((t) => monthOf(t) === m).sort((a, b) => b.amount - a.amount)[0]);
    if (list.some((t) => !t)) continue;
    const days = list.map((t) => Number(t.date.slice(8, 10)));
    if (Math.max(...days) - Math.min(...days) > BILL_DAY_SPREAD) continue;
    const last = list[2];
    const fixed = cents(list[0].amount) === cents(list[1].amount);
    bills.push({
      key,
      name: displayName(last),
      day: days[2],
      amount: fixed ? last.amount : roundCents(sumAmounts(list) / 3),
      varies: !fixed,
      category: last.category,
      source: last.importedFrom, // the account it's paid from
    });
  }
  return bills;
}

// Quarterly and yearly manual subscriptions due in `month` that none of `bills` already covers (monthly ones show
// up in the charges, or come out of a paycheck)
export function subscriptionsDue(subscriptions, month, bills) {
  return subscriptions.flatMap((sub) => {
    if (!STEP_MONTHS[sub.frequency] || sub.frequency === 'monthly') return [];
    const date = dueIn(sub, month);
    const word = merchantKey(sub.name).split(' ')[0];
    if (!date || (word && bills.some((b) => b.key.includes(word)))) return [];
    return [{ key: `sub:${sub.id}`, name: sub.name, date, amount: sub.amount, varies: false, category: sub.category, manual: true }];
  });
}

// Active mortgage loans as bills: each due on its start date's day of the month (payment 1 is due the month after
// it starts) for its scheduled payment (P&I plus the latest escrow, baselineLoans), with `isPayment` recognizing
// the user's payments to it by its payment keywords. Loans without a scheduled payment are left out.
const textOf = (tx) => `${tx.name} ${tx.merchantName || ''}`;
export function mortgageBills(mortgages) {
  if (!mortgages?.loans?.length) return [];
  return baselineLoans({ payments: [], ...mortgages })
    .filter((l) => l.status === 'active' && l.scheduled > 0 && /^\d{4}-\d{2}-\d{2}$/.test(l.startDate || ''))
    .map((l) => {
      const patterns = (l.paymentKeywords || []).filter((k) => k.trim()).map(keywordRegex);
      return {
        id: l.id,
        label: l.label || 'Mortgage',
        day: Number(l.startDate.slice(8, 10)),
        firstDue: addMonths(l.startDate.slice(0, 7), 1),
        amount: roundCents(l.scheduled),
        isPayment: (tx) => patterns.some((re) => re.test(textOf(tx))),
      };
    });
}

// A loan's due date in `month`, or null before its first payment
export const mortgageDueDate = (loan, month) => (month < loan.firstDue ? null : `${month}-${pad(Math.min(loan.day, daysInMonth(month)))}`);

// Transactions without the payments to mortgage loans: those are bills with a due date (mortgageBills), not
// charges to guess a day from, since a manual payment lands whenever the user makes it
export const withoutMortgagePayments = (transactions, loans) => (loans.length ? transactions.filter((tx) => !loans.some((l) => l.isPayment(tx))) : transactions);

// Bills expected in the month after `month`, by date: the recurring bills of the 3 months ending with `month`
// (detectBills, leaving out mortgage payments) on their day again, mortgage loans on their due date, and manual
// subscriptions due then (subscriptionsDue)
export function expectedBills(transactions, subscriptions, month, mortgages) {
  const next = addMonths(month, 1);
  const loans = mortgageBills(mortgages);
  const bills = detectBills(withoutMortgagePayments(transactions, loans), month)
    .map(({ day, ...b }) => ({ ...b, date: `${next}-${pad(Math.min(day, daysInMonth(next)))}` }));
  const dues = loans.flatMap((l) => {
    const date = mortgageDueDate(l, next);
    return date ? [{ key: `due:${l.id}`, name: 'Mortgage due', date, amount: l.amount, varies: false, category: 'housing', mortgage: true }] : [];
  });
  return [...bills, ...dues, ...subscriptionsDue(subscriptions, next, bills)].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}

// Net worth at the end of the month before `month` and at the end of `month` (as far as it's known), from the
// same history the Net Worth page charts. null without any balances by then.
export function netWorthChange(data, month) {
  const nw = data.netWorth || { accounts: [], snapshots: [] };
  const mortgages = data.mortgages || { properties: [], loans: [], payments: [] };
  const transactions = data.transactions || [];
  const timelines = Object.fromEntries(nw.accounts.map((a) => [a.id, buildBalanceTimeline(a, nw.snapshots, transactions)]));
  const history = buildNetWorthHistory(nw.accounts, timelines, mortgages, transactions);
  const on = (date) => history.reduce((v, p) => (p.date <= date ? p.netWorth : v), null);
  const end = on(lastDay(month));
  if (end === null) return null;
  const start = on(lastDay(addMonths(month, -1)));
  return { start, end, change: start === null ? null : roundCents(end - start) };
}

// The month's take-home and spending (mortgage payments apart), worked out the way the projection does, next
// to the projection's monthly figures: its settings, else its default (the 12 months before `today`'s month)
export function planComparison(data, month, today) {
  const transactions = data.transactions || [];
  const loans = baselineLoans(data.mortgages || { loans: [], payments: [] });
  const actual = cashFlowBaseline(transactions, loans, addMonths(month, 1), 1);
  const usual = cashFlowBaseline(transactions, loans, today.slice(0, 7));
  const settings = data.netWorth?.projection || {};
  const set = (key) => Number.isFinite(settings[key]);
  return {
    takeHome: roundCents(actual.takeHome),
    spending: roundCents(actual.spending),
    mortgage: roundCents(actual.mortgage),
    planTakeHome: roundCents(set('takeHome') ? settings.takeHome : usual.takeHome),
    planSpending: roundCents(set('spending') ? settings.spending : usual.spending),
    planSet: { takeHome: set('takeHome'), spending: set('spending') },
  };
}

// Everything the Review page shows for `month` ('YYYY-MM') on `today` ('YYYY-MM-DD')
export function buildMonthlyReview(data, month, today) {
  const transactions = data.transactions || [];
  const inMonth = (m) => transactions.filter((tx) => monthOf(tx) === m);
  const totals = (m) => {
    const txs = inMonth(m);
    return { income: roundCents(sumAmounts(txs.filter(isIncome))), spending: roundCents(sumAmounts(txs.filter(isSpending))) };
  };
  const spent = monthSpending(transactions, month);
  const { months: averageMonths, averages } = averageSpending(transactions, month);
  const window = new Set(averageMonths);
  const averageTotal = averageMonths.length
    ? Math.round(sumAmounts(transactions.filter((tx) => window.has(monthOf(tx)) && isSpending(tx))) / averageMonths.length)
    : null;
  const budgets = Object.fromEntries(Object.entries(data.budgets || {}).filter(([, amount]) => amount > 0));
  const categories = SPENDING_CATEGORIES
    .filter((c) => c.id !== 'transfers')
    .map((c) => ({ id: c.id, spent: roundCents(spent[c.id] || 0), average: averages[c.id] ?? null, budget: budgets[c.id] ?? null }))
    .filter((c) => c.spent > 0 || c.budget || c.average >= 50) // a usual of a few dollars and nothing spent is clutter
    .sort((a, b) => b.spent - a.spent || (b.average || 0) - (a.average || 0));

  return {
    month,
    complete: month < today.slice(0, 7),
    progress: monthProgress(month, today),
    ...totals(month),
    previous: totals(addMonths(month, -1)),
    averageSpending: averageTotal,
    averageMonths: averageMonths.length,
    categories,
    budgets: Object.keys(budgets).length ? budgetTotals(budgets, spent) : null,
    unusual: unusualCharges(transactions, month),
    increases: priceIncreases(transactions, month),
    newRecurring: newRecurring(transactions, month),
    upcoming: expectedBills(transactions, data.subscriptions || [], month, data.mortgages),
    netWorth: netWorthChange(data, month),
    plan: planComparison(data, month, today),
  };
}

// What Claude writes the summary from: the review in whole dollars with names instead of IDs, lists trimmed.
// Rounding also means a few cents' change doesn't make a written summary out of date.
export function reviewFacts(review) {
  const $ = (n) => (n === null || n === undefined ? null : Math.round(n));
  const name = (id) => CATEGORY_MAP[id]?.name || id;
  const next = addMonths(review.month, 1);
  return {
    month: formatMonth(review.month),
    monthIsOver: review.complete,
    income: $(review.income),
    spending: $(review.spending),
    kept: $(review.income - review.spending),
    lastMonth: { income: $(review.previous.income), spending: $(review.previous.spending) },
    usualMonthlySpending: review.averageSpending === null ? null : { amount: review.averageSpending, overMonths: review.averageMonths },
    categories: review.categories.slice(0, 8).map((c) => ({ category: name(c.id), spent: $(c.spent), usual: $(c.average), budget: $(c.budget) })),
    budgets: review.budgets && { budgeted: $(review.budgets.budgeted), spentInBudgetedCategories: $(review.budgets.spent), left: $(review.budgets.left) },
    priceIncreases: review.increases.slice(0, 5).map((i) => ({ merchant: i.name, from: i.from, to: i.to })),
    unusualCharges: review.unusual.map((u) => ({
      merchant: u.name,
      amount: $(u.amount),
      date: u.date,
      why: u.kind === 'new' ? 'first charge from this merchant in a year' : `usually about ${$(u.usual)}`,
    })),
    newRecurringCharges: review.newRecurring.slice(0, 5).map((r) => ({ merchant: r.name, amount: $(r.amount), since: formatMonth(r.since) })),
    billsNextMonth: {
      month: formatMonth(next),
      total: $(sumAmounts(review.upcoming)),
      largest: [...review.upcoming].sort((a, b) => b.amount - a.amount).slice(0, 5).map((b) => ({ name: b.name, date: b.date, amount: $(b.amount), varies: b.varies })),
    },
    netWorth: review.netWorth && { startOfMonth: $(review.netWorth.start), endOfMonth: $(review.netWorth.end), change: $(review.netWorth.change) },
    projection: {
      takeHome: $(review.plan.takeHome),
      projectionTakeHome: $(review.plan.planTakeHome),
      spendingWithoutMortgage: $(review.plan.spending),
      projectionSpending: $(review.plan.planSpending),
    },
  };
}
