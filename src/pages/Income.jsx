import { useState, useMemo } from 'react';
import Modal from '../components/Modal';
import TransactionRow from '../components/TransactionRow';
import TransactionForm from '../components/TransactionForm';
import EmptyState from '../components/EmptyState';
import { formatCurrency } from '../constants/categories';
import { getMonthOptions } from '../utils/dates';
import { isCredit, isIncome, sumAmounts } from '../utils/transactions';

export default function Income({ data, updateTransaction, deleteTransaction }) {
  const [editing, setEditing] = useState(null);

  // Every credit is listed so misclassified ones can be fixed; transfers in (card payments,
  // moves between your own accounts) are shown but not counted as income
  const creditTransactions = useMemo(
    () => data.transactions.filter(isCredit),
    [data.transactions]
  );

  const monthOptions = useMemo(() => getMonthOptions(creditTransactions), [creditTransactions]);
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0] || '');

  const filtered = useMemo(
    () => creditTransactions
      .filter((tx) => tx.date?.startsWith(selectedMonth))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [creditTransactions, selectedMonth]
  );

  const incomeTotal = useMemo(() => sumAmounts(filtered.filter(isIncome)), [filtered]);
  const transferTotal = useMemo(() => sumAmounts(filtered.filter((tx) => !isIncome(tx))), [filtered]);

  const handleSave = (payload) => {
    updateTransaction(editing.id, payload);
    setEditing(null);
  };

  return (
    <div className="page income">
      <div className="page-header">
        <div>
          <h2>Income</h2>
          <p className="page-subtitle">
            {filtered.length} transactions &middot; {formatCurrency(incomeTotal)} income
            {transferTotal > 0 && ` · ${formatCurrency(transferTotal)} transfers in (not counted)`}
          </p>
        </div>
        <div className="page-header-actions">
          <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
            {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={'\u{1F4B0}'} message="No income this month. Import a CSV with credit transactions." />
      ) : (
        filtered.map((tx) => (
          <TransactionRow key={tx.id} transaction={tx} onEdit={setEditing} onDelete={deleteTransaction} />
        ))
      )}

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit Transaction">
        {editing && <TransactionForm key={editing.id} transaction={editing} onSave={handleSave} />}
      </Modal>
    </div>
  );
}
