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

const byDate = (a, b) => a.date.localeCompare(b.date);

// Net worth over time: on every date any balance changes, each account's latest known balance, assets
// minus liabilities. `timelines` maps account id → buildBalanceTimeline. Mortgage loans and properties
// come from the Mortgage page on their real dates (closing, payment, payoff, purchase), so buying a house
// lands on the same day as the money that paid for it.
export function buildNetWorthHistory(accounts, timelines, mortgages) {
  const series = accounts.map((acct) => ({ type: acct.type, points: timelines[acct.id] || [] }));

  // A refinance swaps the loans on one day: the new loan's money pays off the old one at funding, a few
  // days after closing, so the new loan starts at the old one's payoff (or the old one ends when the new
  // one starts) and the two are never owed at once
  const loansById = Object.fromEntries(mortgages.loans.map((l) => [l.id, l]));
  const refinancedBy = Object.fromEntries(mortgages.loans.filter((l) => l.refinancesLoanId).map((l) => [l.refinancesLoanId, l]));
  const startOf = (loan) => {
    const start = loan.closingDate || loan.startDate;
    const payoff = loansById[loan.refinancesLoanId]?.payoffDate;
    return payoff && payoff > start ? payoff : start;
  };
  const endOf = (loan) => {
    if (loan.status === 'paid_off' && loan.payoffDate) return loan.payoffDate;
    return refinancedBy[loan.id] ? startOf(refinancedBy[loan.id]) : null;
  };

  for (const loan of mortgages.loans) {
    const points = [{ date: startOf(loan), balance: loan.loanAmount }];
    for (const p of mortgages.payments) {
      if (p.loanId === loan.id) points.push({ date: p.date || `${p.forMonth}-01`, balance: p.balanceAfter });
    }
    const end = endOf(loan);
    if (end) points.push({ date: end, balance: 0 });
    series.push({ type: 'liability', points: points.filter((p) => p.date).sort(byDate) });
  }

  // A property without a purchase date counts from the start
  let undatedProperties = 0;
  for (const prop of mortgages.properties) {
    const value = prop.estimatedValue || prop.purchasePrice;
    if (prop.purchaseDate) series.push({ type: 'asset', points: [{ date: prop.purchaseDate, balance: value }] });
    else undatedProperties += value;
  }

  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const next = series.map(() => 0);
  const current = series.map(() => null);
  return dates.map((date) => {
    let assets = undatedProperties;
    let liabilities = 0;
    series.forEach((s, i) => {
      while (next[i] < s.points.length && s.points[next[i]].date <= date) current[i] = s.points[next[i]++].balance;
      if (current[i] === null) return;
      if (s.type === 'asset') assets += current[i];
      else liabilities += current[i];
    });
    return { date, assets: roundCents(assets), liabilities: roundCents(liabilities), netWorth: roundCents(assets - liabilities) };
  });
}
