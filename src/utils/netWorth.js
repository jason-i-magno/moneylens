import { roundCents } from './transactions';

export function getLinkedTransactions(profileId, transactions) {
  return transactions.filter((tx) => tx.importedFrom === profileId);
}

// Assets grow with credits (deposits); liabilities grow with debits (charges)
export function balanceEffect(tx, accountType) {
  const signed = tx.type === 'credit' ? tx.amount : -tx.amount;
  return accountType === 'liability' ? -signed : signed;
}

// End-of-day balances for an account. Snapshots are anchors; transactions imported from the
// account's linked bank profile fill in every other day by replaying forward from each anchor
// and backward from the earliest one.
export function buildBalanceTimeline(account, snapshots, transactions) {
  const anchors = snapshots
    .filter((s) => s.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (anchors.length === 0) return [];

  const points = new Map(anchors.map((s) => [s.date, s.balance]));
  const anchorDates = [...points.keys()];

  const effectByDate = new Map();
  const linked = account.linkedBankProfile ? getLinkedTransactions(account.linkedBankProfile, transactions) : [];
  for (const tx of linked) {
    effectByDate.set(tx.date, (effectByDate.get(tx.date) || 0) + balanceEffect(tx, account.type));
  }
  const txDates = [...effectByDate.keys()].sort();

  // Before the first anchor: undo each day's activity walking backward
  const first = anchorDates[0];
  let balance = points.get(first);
  for (const date of txDates.filter((d) => d <= first).reverse()) {
    if (date < first) points.set(date, roundCents(balance));
    balance -= effectByDate.get(date);
  }

  // From each anchor up to the next one: apply each day's activity walking forward
  anchorDates.forEach((anchorDate, i) => {
    const nextAnchor = anchorDates[i + 1];
    let running = points.get(anchorDate);
    for (const date of txDates) {
      if (date <= anchorDate) continue;
      if (nextAnchor && date >= nextAnchor) break;
      running += effectByDate.get(date);
      points.set(date, roundCents(running));
    }
  });

  return [...points.entries()]
    .map(([date, bal]) => ({ date, balance: bal }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
