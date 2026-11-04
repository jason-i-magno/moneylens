import { isSpending, sumByCategory } from './transactions';
import { addMonths, daysInMonth } from './dates';

const roundCents = (n) => Math.round(n * 100) / 100;

// Spending per category in one month ('YYYY-MM'); transfers and credits don't count
export function monthSpending(transactions, month) {
  return sumByCategory(transactions.filter((tx) => tx.date?.startsWith(month) && isSpending(tx)));
}

// A month's totals: the budgets added up, what was spent in budgeted categories, what's left of the
// budgets (negative when over), and spending in categories without a budget
export function budgetTotals(budgets, spending) {
  const budgeted = Object.entries(budgets).filter(([, amount]) => amount > 0);
  const budgetedIds = new Set(budgeted.map(([id]) => id));
  const total = budgeted.reduce((sum, [, amount]) => sum + amount, 0);
  const spent = budgeted.reduce((sum, [id]) => sum + (spending[id] || 0), 0);
  const unbudgeted = Object.entries(spending).reduce((sum, [id, amount]) => sum + (budgetedIds.has(id) ? 0 : amount), 0);
  return { budgeted: roundCents(total), spent: roundCents(spent), left: roundCents(total - spent), unbudgeted: roundCents(unbudgeted) };
}

// How much of `month` has gone by on `today` ('YYYY-MM-DD'), counting today: 1 for a past month, 0 for a future one
export function monthProgress(month, today) {
  const current = today.slice(0, 7);
  if (month < current) return 1;
  if (month > current) return 0;
  return Number(today.slice(8, 10)) / daysInMonth(month);
}

// Average monthly spending per category, in whole dollars, over the `count` full months before `month`.
// Months before the first transaction aren't counted, so a short history isn't averaged down by empty months.
export function averageSpending(transactions, month, count = 6) {
  const firstMonth = transactions.reduce((min, tx) => (tx.date && (!min || tx.date < min) ? tx.date : min), null)?.slice(0, 7);
  const months = [];
  for (let i = count; i >= 1; i--) {
    const m = addMonths(month, -i);
    if (firstMonth && m >= firstMonth) months.push(m);
  }
  if (months.length === 0) return { months, averages: {} };
  const inWindow = new Set(months);
  const totals = sumByCategory(transactions.filter((tx) => tx.date && inWindow.has(tx.date.slice(0, 7)) && isSpending(tx)));
  const averages = Object.fromEntries(Object.entries(totals).map(([id, total]) => [id, Math.round(total / months.length)]));
  return { months, averages };
}
