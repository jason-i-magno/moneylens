// Single source of truth for how transactions count toward income and spending.
// Manual transactions have no `type` and are treated as debits.
// Transfers (credit card payments, moves between own accounts) are neither income nor spending.

export const isCredit = (tx) => tx.type === 'credit';
export const isTransfer = (tx) => tx.category === 'transfers';
export const isIncome = (tx) => isCredit(tx) && !isTransfer(tx);
export const isSpending = (tx) => !isCredit(tx) && !isTransfer(tx);

export const sumAmounts = (txs) => txs.reduce((sum, tx) => sum + tx.amount, 0);

export const roundCents = (n) => Math.round(n * 100) / 100;

export function sumByCategory(txs) {
  const map = {};
  for (const tx of txs) {
    map[tx.category] = (map[tx.category] || 0) + tx.amount;
  }
  for (const key in map) {
    map[key] = roundCents(map[key]);
  }
  return map;
}
