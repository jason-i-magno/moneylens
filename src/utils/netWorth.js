import { keywordRegex } from './categorizer';
import { addDays, daysBetween } from './dates';
import { roundCents } from './transactions';

export function getLinkedTransactions(profileId, transactions) {
  return transactions.filter((tx) => tx.importedFrom === profileId);
}

// Moves to or from an account that isn't imported or synced, as recorded in the user's other accounts:
// transactions whose description matches one of the account's `transferKeywords` (matched like
// category keywords), and transfers linked to it one by one (`transferAccountId`, set in the edit form).
// The account's own linked transactions never count.
export function followedTransfers(account, transactions) {
  const patterns = (account.transferKeywords || []).filter((k) => k.trim()).map(keywordRegex);
  const linkedTo = (tx) => account.id && tx.transferAccountId === account.id && tx.category === 'transfers';
  if (!patterns.length && !account.id) return [];
  return transactions.filter((tx) => (!account.linkedBankProfile || tx.importedFrom !== account.linkedBankProfile)
    && (linkedTo(tx) || patterns.some((re) => re.test(`${tx.name} ${tx.merchantName || ''}`))));
}

// Assets grow with credits (deposits); liabilities grow with debits (charges)
export function balanceEffect(tx, accountType) {
  const signed = tx.type === 'credit' ? tx.amount : -tx.amount;
  return accountType === 'liability' ? -signed : signed;
}

// End-of-day balances for an account. Snapshots are anchors; transactions imported from the
// account's linked bank profile fill in every other day by replaying forward from each anchor
// and backward from the earliest one. Followed transfers count the other way round: money that
// left another account for this one raises an asset here or pays down a liability.
export function buildBalanceTimeline(account, snapshots, transactions) {
  const anchors = snapshots
    .filter((s) => s.accountId === account.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (anchors.length === 0) return [];

  const points = new Map(anchors.map((s) => [s.date, s.balance]));
  const anchorDates = [...points.keys()];

  const effectByDate = new Map();
  const add = (date, effect) => effectByDate.set(date, (effectByDate.get(date) || 0) + effect);
  const linked = account.linkedBankProfile ? getLinkedTransactions(account.linkedBankProfile, transactions) : [];
  for (const tx of linked) add(tx.date, balanceEffect(tx, account.type));
  for (const tx of followedTransfers(account, transactions)) add(tx.date, -balanceEffect(tx, account.type));
  const txDates = [...effectByDate.keys()].sort();

  // Before the first anchor: undo each day's activity walking backward, ending with the opening
  // balance on the day before the earliest activity, so the first move nets out against its other side
  const first = anchorDates[0];
  let balance = points.get(first);
  const earlier = txDates.filter((d) => d <= first).reverse();
  for (const date of earlier) {
    if (date < first) points.set(date, roundCents(balance));
    balance -= effectByDate.get(date);
  }
  if (earlier.length) points.set(addDays(earlier[earlier.length - 1], -1), roundCents(balance));

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

// Both sides of a transfer between two linked accounts, posted a few days apart (a card shows a payment
// before the bank account it came from does). Until the later side posts, the earlier side's change is
// held back, so net worth doesn't count the money in both places for those days. A pair is a transfer
// debit and a same-amount transfer credit in two different linked accounts, at most `maxDays` apart,
// closest first; each transaction pairs once, and moves a followed account already accounts for are
// left out. Returns { accountId, from, to, delta }: add `delta` to that account from `from` until `to`.
export function transfersInTransit(accounts, transactions, maxDays = 5) {
  const accountByProfile = new Map();
  for (const a of accounts) {
    if (a.linkedBankProfile && !accountByProfile.has(a.linkedBankProfile)) accountByProfile.set(a.linkedBankProfile, a);
  }
  const followed = new Set(accounts.flatMap((a) => followedTransfers(a, transactions)));
  const moves = transactions.filter((tx) => tx.category === 'transfers' && accountByProfile.has(tx.importedFrom) && !followed.has(tx));

  const debitsByCents = new Map();
  for (const tx of moves) {
    if (tx.type === 'credit') continue;
    const cents = Math.round(tx.amount * 100);
    debitsByCents.set(cents, [...(debitsByCents.get(cents) || []), tx]);
  }
  // Same-day pairs take part too, so they can't be matched to a later move of the same amount
  const candidates = [];
  for (const credit of moves) {
    if (credit.type !== 'credit') continue;
    for (const debit of debitsByCents.get(Math.round(credit.amount * 100)) || []) {
      const gap = Math.abs(daysBetween(credit.date, debit.date));
      if (debit.importedFrom !== credit.importedFrom && gap <= maxDays) candidates.push({ credit, debit, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || a.credit.date.localeCompare(b.credit.date));

  const paired = new Set();
  const holds = [];
  for (const { credit, debit, gap } of candidates) {
    if (paired.has(credit) || paired.has(debit)) continue;
    paired.add(credit);
    paired.add(debit);
    if (gap === 0) continue;
    const [early, late] = credit.date < debit.date ? [credit, debit] : [debit, credit];
    const account = accountByProfile.get(early.importedFrom);
    holds.push({ accountId: account.id, from: early.date, to: late.date, delta: -balanceEffect(early, account.type) });
  }
  return holds;
}

const paymentDate = (p) => p.date || `${p.forMonth}-01`;
// A recorded payment's balance includes everything up to its statement date (when later than its own)
const coveredThrough = (p) => (p.statementDate && p.statementDate > paymentDate(p) ? p.statementDate : paymentDate(p));

// A mortgage loan's balance: the loan amount from `start`, then each recorded payment, stepping down on
// the dates of its statement's listed payments (`activity`), so extra principal paid weeks before the
// regular payment counts when it was paid; without them, the regular payment and any extra principal
// step down on the payment's date. A servicer often dates a payment a few days before the bank posts it,
// so each step counts on the day a followed payment of the same amount left the bank, within 5 days
// (closest first, each bank payment once), and the money isn't counted in both places. A drop since the previous statement that neither one lists (a
// payment made between the two periods, e.g. around a servicing transfer) lands on the followed payments
// in between. Principal applied before `start` counts from `start`.
// After the latest recorded payment come estimates from the payments the loan follows (`paymentKeywords`,
// matched like category keywords): one of at least the scheduled amount (monthly P&I plus the latest
// escrow) pays a month's interest at the loan's rate and the escrow, and the rest is principal; a smaller
// one is all principal. Payments up to the latest statement's date are already in its balance. Without a
// statement date, a payment equal to the latest recorded one's total, within 10 days of it, is that same
// payment reaching the bank account, so it isn't counted twice. Estimates have `estimated`.
export function loanBalancePoints(loan, payments, transactions = [], start = loan.closingDate || loan.startDate) {
  const recorded = payments.filter((p) => p.loanId === loan.id).sort((a, b) => paymentDate(a).localeCompare(paymentDate(b)));
  const followed = followedTransfers({ transferKeywords: loan.paymentKeywords }, transactions)
    .filter((tx) => tx.type !== 'credit')
    .sort(byDate);
  const principalOf = (tx, balance, escrow) => {
    const scheduled = (loan.monthlyPI || 0) + escrow;
    return scheduled > 0 && tx.amount >= scheduled - 0.005 ? tx.amount - roundCents((balance * (loan.interestRate || 0)) / 1200) - escrow : tx.amount;
  };

  const matched = new Set();
  const bankDate = (a) => {
    const amount = roundCents(a.amount ?? a.principal);
    let best = null;
    for (const tx of followed) {
      const gap = Math.abs(daysBetween(a.date, tx.date));
      if (!matched.has(tx) && roundCents(tx.amount) === amount && gap <= 5 && (!best || gap < best.gap)) best = { tx, gap };
    }
    if (!best) return a.date;
    matched.add(best.tx);
    return best.tx.date;
  };

  // A payment's dated steps: the statement's listed payments, else the regular payment and any extra
  // principal, both on the payment's date
  const stepsOf = (p) => {
    const listed = (p.activity || []).filter((a) => a.date).sort(byDate);
    if (listed.length) return listed;
    const principal = p.principal || 0;
    const regular = { date: paymentDate(p), principal, amount: roundCents(principal + (p.interest || 0) + (p.escrow || 0)) };
    return p.extraPrincipal > 0 ? [regular, { date: paymentDate(p), principal: p.extraPrincipal, amount: p.extraPrincipal }] : [regular];
  };

  const points = [{ date: start, balance: loan.loanAmount }];
  recorded.forEach((p, i) => {
    const steps = stepsOf(p).map((a) => ({ ...a, date: bankDate(a) })).sort(byDate);
    let balance = roundCents(p.balanceAfter + steps.reduce((sum, a) => sum + a.principal, 0));
    const prev = recorded[i - 1];
    if (prev) {
      let between = prev.balanceAfter;
      for (const tx of followed.filter((t) => !matched.has(t) && t.date > coveredThrough(prev) && t.date < steps[0].date)) {
        if (between <= balance + 0.005) break;
        between = Math.max(balance, roundCents(between - principalOf(tx, between, prev.escrow || 0)));
        points.push({ date: tx.date, balance: between });
      }
    }
    steps.forEach((a, j) => {
      balance = j === steps.length - 1 ? p.balanceAfter : roundCents(balance - a.principal);
      points.push({ date: a.date, balance });
    });
  });

  const base = points[points.length - 1];
  const latest = recorded[recorded.length - 1];
  const escrow = latest?.escrow || 0;
  const latestTotal = latest && roundCents((latest.principal || 0) + (latest.extraPrincipal || 0) + (latest.interest || 0) + escrow);
  const statementDate = latest?.statementDate;
  const since = statementDate && base.date && statementDate > base.date ? statementDate : base.date;

  let balance = base.balance;
  let latestPosted = Boolean(statementDate);
  for (const tx of followed.filter((t) => since && t.date > since)) {
    if (!latestPosted && latestTotal === roundCents(tx.amount) && daysBetween(base.date, tx.date) <= 10) {
      latestPosted = true;
      continue;
    }
    balance = Math.max(0, roundCents(balance - principalOf(tx, balance, escrow)));
    points.push({ date: tx.date, balance, estimated: true });
  }
  return points.filter((p) => p.date).map((p) => (start && p.date < start ? { ...p, date: start } : p));
}

// Net worth over time: on every date any balance changes, each account's latest known balance, assets
// minus liabilities. `timelines` maps account id → buildBalanceTimeline. Mortgage loans and properties
// come from the Mortgage page on their real dates (closing, payment, payoff, purchase), so buying a house
// lands on the same day as the money that paid for it; loans follow their payments after the latest
// statement. Transfers in transit (see transfersInTransit) count on the day their later side posts.
export function buildNetWorthHistory(accounts, timelines, mortgages, transactions = []) {
  const holds = transfersInTransit(accounts, transactions);
  const series = accounts.map((acct) => ({
    type: acct.type,
    points: timelines[acct.id] || [],
    holds: holds.filter((h) => h.accountId === acct.id),
  }));

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
    const end = endOf(loan);
    const points = loanBalancePoints(loan, mortgages.payments, transactions, startOf(loan)).filter((p) => !end || p.date < end);
    if (end) points.push({ date: end, balance: 0 });
    series.push({ type: 'liability', points: points.sort(byDate) });
  }

  // A property counts at its purchase price from the purchase date, then at its estimated value from the
  // estimate's date (from the purchase when the estimate has no date). Without a purchase date it
  // counts from the start.
  let undatedProperties = 0;
  for (const prop of mortgages.properties) {
    const value = prop.estimatedValue || prop.purchasePrice;
    if (!prop.purchaseDate) {
      undatedProperties += value;
      continue;
    }
    const laterEstimate = prop.estimatedValue && prop.purchasePrice && prop.estimatedValueDate > prop.purchaseDate;
    series.push({
      type: 'asset',
      points: laterEstimate
        ? [{ date: prop.purchaseDate, balance: prop.purchasePrice }, { date: prop.estimatedValueDate, balance: prop.estimatedValue }]
        : [{ date: prop.purchaseDate, balance: value }],
    });
  }

  const dates = [...new Set([...series.flatMap((s) => s.points.map((p) => p.date)), ...holds.flatMap((h) => [h.from, h.to])])].sort();
  const next = series.map(() => 0);
  const current = series.map(() => null);
  return dates.map((date) => {
    let assets = undatedProperties;
    let liabilities = 0;
    series.forEach((s, i) => {
      while (next[i] < s.points.length && s.points[next[i]].date <= date) current[i] = s.points[next[i]++].balance;
      if (current[i] === null) return;
      const held = (s.holds || []).reduce((sum, h) => (h.from <= date && date < h.to ? sum + h.delta : sum), 0);
      if (s.type === 'asset') assets += current[i] + held;
      else liabilities += current[i] + held;
    });
    return { date, assets: roundCents(assets), liabilities: roundCents(liabilities), netWorth: roundCents(assets - liabilities) };
  });
}
