// Net worth projection (Net Worth page): today's balances carried forward month by month with what's
// saved, paycheck contributions, the mortgage paydown and growth. Pure: the page passes today's balances.
import { isIncome, isSpending } from './transactions';
import { keywordRegex } from './categorizer';
import { addMonths, formatShortMonth } from './dates';
import { formatCurrency } from '../constants/categories';
import { paycheckContributions } from './netWorth';
import { averageExtraPrincipal } from './mortgageCalculations';

// Rates are % a year. `raise` grows take-home pay and paycheck contributions; `inflation` grows spending
// (and escrow) and gives the today's-dollars view.
export const PROJECTION_DEFAULTS = { years: 20, investReturn: 6.5, cashReturn: 3, homeGrowth: 3, raise: 3, inflation: 2.5 };
const RATE_KEYS = Object.keys(PROJECTION_DEFAULTS);
// The range drawn around the expected line: investment returns this many points lower and higher, home
// growth half as many
export const RANGE_POINTS = 2;
export const MAX_YEARS = 50;

// Saved settings (data.netWorth.projection) over the defaults; anything missing or not a number falls back
export function resolveProjectionSettings(saved = {}) {
  const out = { ...PROJECTION_DEFAULTS };
  for (const key of RATE_KEYS) if (Number.isFinite(saved[key])) out[key] = saved[key];
  out.years = Math.min(MAX_YEARS, Math.max(1, Math.round(out.years)));
  return out;
}

const textOf = (tx) => `${tx.name} ${tx.merchantName || ''}`;

// Average month of the 12 full months before `month` ('YYYY-MM'): money in (income) and spending, with
// mortgage payments taken out of spending, since the projection pays the loans itself. Mortgage payments are
// the ones matching a loan's payment keywords; for an active loan without keywords its scheduled payment
// (P&I plus escrow) is taken out for each month since it started (`estimatedMortgage`). Months without any
// transactions are left out of the average, so a few months of data give their own average.
// loans: [{ paymentKeywords, status, startDate, scheduled }]
export function cashFlowBaseline(transactions, loans, month) {
  const from = addMonths(month, -12);
  const to = addMonths(month, -1);
  const patterns = loans.flatMap((l) => (l.paymentKeywords || []).filter((k) => k.trim()).map(keywordRegex));
  const isMortgage = (tx) => patterns.some((re) => re.test(textOf(tx)));
  const months = new Set();
  let income = 0;
  let spending = 0;
  let mortgage = 0;
  for (const tx of transactions) {
    const m = tx.date?.slice(0, 7);
    if (!m || m < from || m > to) continue;
    months.add(m);
    if (isIncome(tx)) income += tx.amount;
    else if (isSpending(tx)) {
      if (isMortgage(tx)) mortgage += tx.amount;
      else spending += tx.amount;
    }
  }
  const unmatched = loans.filter((l) => l.status === 'active' && !(l.paymentKeywords || []).some((k) => k.trim()));
  for (const loan of unmatched) {
    const since = (loan.startDate || from).slice(0, 7);
    const paid = [...months].filter((m) => m >= since).length * (loan.scheduled || 0);
    mortgage += paid;
    spending -= paid;
  }
  const n = months.size || 1;
  return {
    takeHome: income / n,
    spending: Math.max(0, spending) / n,
    mortgage: mortgage / n,
    months: months.size,
    estimatedMortgage: unmatched.length > 0,
  };
}

// Paycheck contributions (see paycheckContributions) as a monthly amount: the account's amount times its
// paydays in the same 12 months, per month that had transactions
export function monthlyPaycheckContribution(account, transactions, month, monthsCovered) {
  const from = addMonths(month, -12);
  const to = addMonths(month, -1);
  const paydays = paycheckContributions(account, transactions).filter((c) => c.date.slice(0, 7) >= from && c.date.slice(0, 7) <= to);
  return monthsCovered ? (paydays.length * (Number(account.paycheckContribution) || 0)) / monthsCovered : 0;
}

// Each active loan as the projection pays it: today's balance (`balances` maps loan id → balance, the Net
// Worth page's figure), rate, monthly P&I, escrow from the latest payment, and the extra principal of the
// latest 6 statements on average
export function projectionLoans(loans, payments, balances) {
  return loans.filter((l) => l.status === 'active').map((loan) => {
    const own = payments.filter((p) => p.loanId === loan.id);
    const latest = [...own].sort((a, b) => (b.forMonth || '').localeCompare(a.forMonth || ''))[0];
    return {
      id: loan.id,
      name: loan.label || loan.lender || 'Mortgage',
      balance: balances[loan.id] ?? loan.loanAmount ?? 0,
      rate: loan.interestRate || 0,
      payment: loan.monthlyPI || 0,
      escrow: latest?.escrow || 0,
      extra: averageExtraPrincipal(own),
    };
  });
}

const growth = (pct) => (1 + pct / 100) ** (1 / 12);

// Future changes (netWorth.projection.changes): from `month` on, take-home or spending goes up (+) or down
// (-) by `amount` a month; or `amount` comes in (+) or goes out (-) once that month; or paychecks stop
// (take-home and paycheck contributions). Amounts are in today's dollars and grow like what they change:
// take-home with raises, spending and one-time amounts with inflation.
export const CHANGE_KINDS = ['takeHome', 'spending', 'oneTime', 'stopPaychecks'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const dollars = (n) => formatCurrency(Math.abs(n)).replace(/\.00$/, '');
const signed = (n) => `${n < 0 ? '\u2212' : '+'}${dollars(n)}`;

// 'Take-home −$525 a month from Jun 2040', 'One-time −$30,000 in Mar 2031', 'Paychecks stop from Jan 2055'
export function describeChange(c) {
  const when = formatShortMonth(c.month);
  if (c.kind === 'stopPaychecks') return `Paychecks stop from ${when}`;
  if (c.kind === 'oneTime') return `One-time ${signed(c.amount)} in ${when}`;
  return `${c.kind === 'takeHome' ? 'Take-home' : 'Spending'} ${signed(c.amount)} a month from ${when}`;
}

// A few words for the chart: the change's own description, else what kind of change it is
export function changeTitle(c) {
  if (c.label) return c.label;
  if (c.kind === 'stopPaychecks') return 'Paychecks stop';
  if (c.kind === 'oneTime') return c.amount < 0 ? 'One-time cost' : 'Money in';
  return `${c.kind === 'takeHome' ? 'Take-home' : 'Spending'} ${c.amount < 0 ? 'drops' : 'rises'}`;
}

// The saved changes that are well formed; `enabled: false` ones are kept (the list shows them) but marked
export function resolveChanges(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.id === 'string' && MONTH_RE.test(c.month) && CHANGE_KINDS.includes(c.kind)
      && (c.kind === 'stopPaychecks' || Number.isFinite(c.amount)))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// start: {
//   month: 'YYYY-MM' (today),
//   accounts: [{ id, kind, balance, monthly }]: kind 'invest' | 'cash' | 'home' (grow at their rate; invest
//     and cash also get `monthly` contributions, rising with raises), 'flat' (an asset held as it is) or
//     'debt' (owed, held as it is);
//   loans: [{ id, balance, rate, payment, escrow, extra }],
//   takeHome, spending (a month, today), cashCushion (today's dollars),
//   changes: future changes (see resolveChanges); ones with `enabled: false` are left out
// }
// Each month, take-home pay minus spending, escrow and loan payments is saved: into cash until cash
// accounts and savings reach the cushion (rising with inflation), then invested; a shortfall is taken from
// those savings, cash first. A loan's payment goes to savings once it's paid off. Returns { points: one per month from 0 (today) with netWorth, invested, cash,
// home, other, owed; payoffs: loan id → 'YYYY-MM' }.
export function projectNetWorth(start, settings) {
  const { years, investReturn, cashReturn, homeGrowth, raise, inflation } = settings;
  const g = { invest: growth(investReturn), cash: growth(cashReturn), home: growth(homeGrowth) };
  const gPay = growth(raise);
  const gLiving = growth(inflation);
  const accounts = start.accounts.map((a) => ({ ...a }));
  const loans = start.loans.map((l) => ({ ...l }));
  const changes = (start.changes || []).filter((c) => c.enabled !== false);
  const payoffs = {};
  let saved = 0; // savings kept as cash
  let invested = 0; // savings invested
  let pay = 1;
  let living = 1;

  const sum = (kind) => accounts.reduce((s, a) => s + (a.kind === kind ? a.balance : 0), 0);
  const point = (m) => {
    const totals = {
      month: addMonths(start.month, m),
      invested: sum('invest') + invested,
      cash: sum('cash') + saved,
      home: sum('home'),
      other: sum('flat'),
      owed: sum('debt') + loans.reduce((s, l) => s + l.balance, 0),
    };
    return { ...totals, netWorth: totals.invested + totals.cash + totals.home + totals.other - totals.owed };
  };

  const points = [point(0)];
  for (let m = 1; m <= years * 12; m++) {
    pay *= gPay;
    living *= gLiving;
    const month = addMonths(start.month, m);
    const active = changes.filter((c) => c.month <= month);
    const paid = !active.some((c) => c.kind === 'stopPaychecks');
    const monthlyChange = (kind) => active.reduce((s, c) => s + (c.kind === kind ? c.amount : 0), 0);
    for (const a of accounts) {
      if (!g[a.kind]) continue;
      a.balance = a.balance * g[a.kind] + (a.kind === 'home' || !paid ? 0 : (a.monthly || 0) * pay);
    }
    saved *= g.cash;
    invested *= g.invest;

    const takeHome = paid ? Math.max(0, start.takeHome + monthlyChange('takeHome')) * pay : 0;
    const spending = Math.max(0, start.spending + monthlyChange('spending')) * living;
    const once = changes.reduce((s, c) => s + (c.kind === 'oneTime' && c.month === month ? c.amount : 0), 0) * living;
    let surplus = takeHome - spending + once;
    for (const loan of loans) {
      surplus -= (loan.escrow || 0) * living; // taxes and insurance, still owed once the loan is paid off
      if (loan.balance <= 0) continue;
      const interest = (loan.balance * loan.rate) / 1200;
      const payment = Math.min(loan.balance + interest, loan.payment + (loan.extra || 0));
      loan.balance += interest - payment;
      surplus -= payment;
      if (loan.balance < 0.005) {
        loan.balance = 0;
        payoffs[loan.id] = month;
      }
    }
    if (surplus > 0) {
      const room = Math.max(0, start.cashCushion * living - (sum('cash') + saved));
      const toCash = Math.min(surplus, room);
      saved += toCash;
      invested += surplus - toCash;
    } else {
      // A shortfall (after paychecks stop, say) comes out of savings kept as cash, then invested savings;
      // beyond that cash goes below zero
      let need = -surplus;
      const fromCash = Math.min(need, Math.max(saved, 0));
      saved -= fromCash;
      need -= fromCash;
      const fromInvested = Math.min(need, invested);
      invested -= fromInvested;
      saved -= need - fromInvested;
    }
    points.push(point(m));
  }
  return { points, payoffs };
}

// The first month the projection reaches each round amount above where it starts
const ROUND_AMOUNTS = [250e3, 500e3, 1e6, 2e6, 3e6, 5e6, 10e6, 20e6];
export function projectionMilestones(points) {
  const startValue = points[0]?.netWorth ?? 0;
  return ROUND_AMOUNTS.filter((amount) => amount > startValue)
    .map((amount) => ({ amount, month: points.find((p) => p.netWorth >= amount)?.month }))
    .filter((m) => m.month);
}
