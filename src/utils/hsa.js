// HSA receipt vault: medical expenses paid outside the HSA, kept so they can be reimbursed from it tax-free
// later. Receipts live in data.hsa.receipts (the files themselves on the local server, server/receiptsApi.js).
import { isSpending } from './transactions';
import { addDays } from './dates';

export const RECEIPT_CATEGORIES = [
  { id: 'doctor', name: 'Doctor' },
  { id: 'dental', name: 'Dental' },
  { id: 'vision', name: 'Vision' },
  { id: 'pharmacy', name: 'Pharmacy' },
  { id: 'hospital', name: 'Hospital' },
  { id: 'lab', name: 'Lab' },
  { id: 'therapy', name: 'Therapy' },
  { id: 'equipment', name: 'Medical equipment' },
  { id: 'other', name: 'Other' },
];

export const receiptsOf = (data) => data.hsa?.receipts || [];

const cents = (n) => Math.round((Number(n) || 0) * 100);

// What can still be reimbursed (not marked ineligible, not reimbursed yet), what has been, and how many receipts.
// Receipts marked "unsure" count as reimbursable but are totalled separately so they can be checked.
export function receiptTotals(receipts) {
  let reimbursable = 0;
  let unsure = 0;
  let reimbursed = 0;
  for (const r of receipts) {
    if (r.reimbursedAt) reimbursed += cents(r.reimbursedAmount ?? r.amount);
    else if (r.eligible !== 'no') {
      reimbursable += cents(r.amount);
      if (r.eligible === 'unsure') unsure += cents(r.amount);
    }
  }
  return { reimbursable: reimbursable / 100, unsure: unsure / 100, reimbursed: reimbursed / 100, count: receipts.length };
}

// Payments a receipt may have been paid with: spending of the same amount (to the cent) from a week before the
// service date to six months after it (bills come later), not already linked to another receipt. Health payments
// first, then the closest dates. Without a service date, any date in the last two years, newest first.
export function suggestPayments(receipt, transactions, receipts, today, limit = 5) {
  const amount = cents(receipt.amount);
  if (amount <= 0) return [];
  const taken = new Set(receipts.filter((r) => r.id !== receipt.id && r.transactionId).map((r) => r.transactionId));
  const from = receipt.serviceDate ? addDays(receipt.serviceDate, -7) : addDays(today, -730);
  const to = receipt.serviceDate ? addDays(receipt.serviceDate, 183) : today;
  const gap = (tx) => (receipt.serviceDate ? Math.abs(Date.parse(tx.date) - Date.parse(receipt.serviceDate)) : -Date.parse(tx.date));
  return transactions
    .filter((tx) => isSpending(tx) && cents(tx.amount) === amount && tx.date >= from && tx.date <= to && !taken.has(tx.id))
    .sort((a, b) => (b.category === 'health') - (a.category === 'health') || gap(a) - gap(b))
    .slice(0, limit);
}

// Medical payments since `since` that no receipt is linked to, newest first: the receipts still to find
export function missingReceipts(transactions, receipts, since) {
  const linked = new Set(receipts.map((r) => r.transactionId).filter(Boolean));
  return transactions
    .filter((tx) => isSpending(tx) && tx.category === 'health' && tx.date >= since && !linked.has(tx.id))
    .sort((a, b) => b.date.localeCompare(a.date));
}
