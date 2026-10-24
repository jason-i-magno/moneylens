// All dates are local calendar dates as strings: 'YYYY-MM-DD' for days, 'YYYY-MM' for months.
// Never use toISOString() for these — it converts to UTC and shifts the day in the evening.

const pad = (n) => String(n).padStart(2, '0');

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function currentMonth() {
  return todayISO().slice(0, 7);
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Whole days from one date to another (negative when `to` is earlier); UTC math so DST can't skew it
export function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function addMonths(monthStr, months) {
  const [y, m] = monthStr.split('-').map(Number);
  const date = new Date(y, m - 1 + months, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

// Months that have transactions, plus the current month, newest first
export function getMonthOptions(transactions) {
  const months = new Set(transactions.filter((tx) => tx.date).map((tx) => tx.date.slice(0, 7)));
  months.add(currentMonth());
  return [...months].sort().reverse();
}
