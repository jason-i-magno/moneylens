import { useState, useMemo } from 'react';
import Modal from '../components/Modal';
import TransactionRow from '../components/TransactionRow';
import TransactionForm from '../components/TransactionForm';
import EmptyState from '../components/EmptyState';
import { CATEGORIES, formatCurrency } from '../constants/categories';
import { getMonthOptions } from '../utils/dates';
import { isCredit, isTransfer, sumAmounts } from '../utils/transactions';

export default function Spending({ data, addTransaction, updateTransaction, deleteTransaction }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [subsOnly, setSubsOnly] = useState(false);

  const monthOptions = useMemo(() => getMonthOptions(data.transactions), [data.transactions]);
  const [selectedMonth, setSelectedMonth] = useState(monthOptions[0] || '');

  // Every debit is listed (including transfers, so they can be found and recategorized)
  const monthTransactions = useMemo(
    () => data.transactions
      .filter((tx) => tx.date?.startsWith(selectedMonth) && !isCredit(tx))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [data.transactions, selectedMonth]
  );

  const filtered = useMemo(() => {
    let result = monthTransactions;
    if (selectedCategory !== 'all') {
      result = result.filter((tx) => tx.category === selectedCategory);
    }
    if (subsOnly) {
      result = result.filter((tx) => tx.isSubscription);
    }
    return result;
  }, [monthTransactions, selectedCategory, subsOnly]);

  // ...but transfers only count toward the total when they're what you're looking at
  const showingTransfers = selectedCategory === 'transfers';
  const monthTotal = useMemo(
    () => sumAmounts(showingTransfers ? filtered : filtered.filter((tx) => !isTransfer(tx))),
    [filtered, showingTransfers]
  );
  const hasHiddenTransfers = !showingTransfers && filtered.some(isTransfer);

  const categoryCounts = useMemo(() => {
    const counts = {};
    monthTransactions.forEach((tx) => {
      counts[tx.category] = (counts[tx.category] || 0) + 1;
    });
    return counts;
  }, [monthTransactions]);

  const activeCategories = useMemo(
    () => CATEGORIES.filter((c) => categoryCounts[c.id]),
    [categoryCounts]
  );

  const subsCount = useMemo(
    () => monthTransactions.filter((tx) => tx.isSubscription).length,
    [monthTransactions]
  );

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (tx) => {
    setEditing(tx);
    setModalOpen(true);
  };

  const handleSave = (payload) => {
    if (editing) {
      updateTransaction(editing.id, payload);
    } else {
      addTransaction(payload);
    }
    setModalOpen(false);
  };

  return (
    <div className="page spending">
      <div className="page-header">
        <div>
          <h2>Spending</h2>
          <p className="page-subtitle">
            {filtered.length} transactions &middot; {formatCurrency(monthTotal)}
            {hasHiddenTransfers && ' (excl. transfers)'}
          </p>
        </div>
        <div className="page-header-actions">
          <select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>
            {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn-primary" onClick={openAdd}>+ Add</button>
        </div>
      </div>

      <div className="category-filters">
        <button
          className={`trend-toggle ${selectedCategory === 'all' && !subsOnly ? 'active' : ''}`}
          style={selectedCategory === 'all' && !subsOnly ? { backgroundColor: '#E8E4DD', color: '#1A1A1F' } : {}}
          onClick={() => { setSelectedCategory('all'); setSubsOnly(false); }}
        >
          All ({monthTransactions.length})
        </button>
        {subsCount > 0 && (
          <button
            className={`trend-toggle ${subsOnly ? 'active' : ''}`}
            style={subsOnly ? { backgroundColor: '#E87CE833', color: '#E87CE8', borderColor: '#E87CE8' } : {}}
            onClick={() => setSubsOnly(!subsOnly)}
          >
            Subscriptions ({subsCount})
          </button>
        )}
        {activeCategories.map((c) => (
          <button
            key={c.id}
            className={`trend-toggle ${selectedCategory === c.id ? 'active' : ''}`}
            style={selectedCategory === c.id ? { backgroundColor: c.color + '33', color: c.color, borderColor: c.color } : {}}
            onClick={() => setSelectedCategory(c.id)}
          >
            {c.icon} {c.name} ({categoryCounts[c.id]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={'\u{1F4B8}'} message="No transactions this month." action={<button className="btn-primary" onClick={openAdd}>Add Transaction</button>} />
      ) : (
        filtered.map((tx) => (
          <TransactionRow key={tx.id} transaction={tx} onEdit={openEdit} onDelete={deleteTransaction} />
        ))
      )}

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Transaction' : 'Add Transaction'}>
        <TransactionForm key={editing?.id || 'new'} transaction={editing} onSave={handleSave} />
      </Modal>
    </div>
  );
}
