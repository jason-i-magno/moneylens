const key = (date, amount, description) => `${date}|${amount}|${(description || '').toLowerCase()}`;

export function findDuplicates(newTransactions, existingTransactions) {
  const existingSet = new Set(existingTransactions.map((tx) => key(tx.date, tx.amount, tx.name)));

  return newTransactions.map((tx) => ({
    ...tx,
    isDuplicate: existingSet.has(key(tx.date, tx.amount, tx.description)),
  }));
}
