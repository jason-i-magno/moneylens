// Totals per period for the Trends charts. `groupBy` is 'monthly' or 'daily'. With `cumulative`, each
// period holds the running total since the first period instead of its own total.
import { CATEGORIES } from '../constants/categories';
import { isIncome, isTransfer, roundCents } from './transactions';

const periodOf = (date, groupBy) => (groupBy === 'daily' ? date : date.slice(0, 7));

function toRows(buckets, keys, cumulative) {
  const rows = Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));
  const running = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const row of rows) {
    for (const k of keys) {
      running[k] += row[k];
      row[k] = roundCents(cumulative ? running[k] : row[k]);
    }
  }
  return rows;
}

// `total` plus one key per category, for the transactions `include` picks (isSpending or isIncome)
export function buildCategoryData(transactions, include, { groupBy, cumulative = false }) {
  const keys = ['total', ...CATEGORIES.map((c) => c.id)];
  const buckets = {};
  for (const tx of transactions) {
    if (!tx.date || !include(tx)) continue;
    const label = periodOf(tx.date, groupBy);
    buckets[label] ??= { label, ...Object.fromEntries(keys.map((k) => [k, 0])) };
    buckets[label][tx.category] = (buckets[label][tx.category] || 0) + tx.amount;
    buckets[label].total += tx.amount;
  }
  return toRows(buckets, keys, cumulative);
}

// Income, spending and net (income − spending); transfers are neither
export function buildNetData(transactions, { groupBy, cumulative = false }) {
  const buckets = {};
  for (const tx of transactions) {
    if (!tx.date || isTransfer(tx)) continue;
    const label = periodOf(tx.date, groupBy);
    buckets[label] ??= { label, income: 0, spending: 0 };
    buckets[label][isIncome(tx) ? 'income' : 'spending'] += tx.amount;
  }
  return toRows(buckets, ['income', 'spending'], cumulative)
    .map((row) => ({ ...row, net: roundCents(row.income - row.spending) }));
}
