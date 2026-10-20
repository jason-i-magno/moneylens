import { useState, useMemo } from 'react';
import Modal from '../components/Modal';
import MiniBar from '../components/MiniBar';
import EmptyState from '../components/EmptyState';
import { CATEGORIES, formatCurrency } from '../constants/categories';
import { currentMonth } from '../utils/dates';
import { isSpending, sumByCategory } from '../utils/transactions';

export default function Budgets({ data, setBudget, deleteBudget }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editCat, setEditCat] = useState('');
  const [amount, setAmount] = useState('');
  const month = currentMonth();

  const spendingByCategory = useMemo(
    () => sumByCategory(data.transactions.filter((tx) => tx.date?.startsWith(month) && isSpending(tx))),
    [data.transactions, month]
  );

  const budgetCategories = useMemo(() => {
    const ids = new Set([
      ...Object.keys(data.budgets),
      ...Object.keys(spendingByCategory),
    ]);
    return CATEGORIES.filter((c) => ids.has(c.id));
  }, [data.budgets, spendingByCategory]);

  const openEdit = (catId) => {
    setEditCat(catId);
    setAmount(data.budgets[catId] || '');
    setModalOpen(true);
  };

  const openAdd = () => {
    setEditCat('');
    setAmount('');
    setModalOpen(true);
  };

  const handleSave = () => {
    if (editCat && amount) {
      setBudget(editCat, parseFloat(amount));
    }
    setModalOpen(false);
  };

  const handleDelete = () => {
    if (editCat) deleteBudget(editCat);
    setModalOpen(false);
  };

  return (
    <div className="page budgets">
      <div className="page-header">
        <h2>Budgets</h2>
        <button className="btn-primary" onClick={openAdd}>+ Set Budget</button>
      </div>

      {budgetCategories.length === 0 ? (
        <EmptyState icon={'\u{1F4CA}'} message="No budgets set yet." action={<button className="btn-primary" onClick={openAdd}>Set a Budget</button>} />
      ) : (
        budgetCategories.map((cat) => {
          const spent = spendingByCategory[cat.id] || 0;
          const budget = data.budgets[cat.id] || 0;
          const over = budget > 0 && spent > budget;

          return (
            <div key={cat.id} className="budget-row" onClick={() => openEdit(cat.id)}>
              <div className="budget-label">
                <span className="budget-icon">{cat.icon}</span>
                <span>{cat.name}</span>
              </div>
              <div className="budget-bar-wrap">
                <MiniBar spent={spent} budget={budget} color={cat.color} />
                <span className={`budget-amounts ${over ? 'over' : ''}`}>
                  {formatCurrency(spent)} / {budget > 0 ? formatCurrency(budget) : 'No limit'}
                </span>
              </div>
            </div>
          );
        })
      )}

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title="Set Budget">
        <div className="form-group">
          <label>Category</label>
          <select value={editCat} onChange={(e) => setEditCat(e.target.value)}>
            <option value="">Select...</option>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Monthly Budget</label>
          <input type="number" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
        </div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={handleSave}>Save</button>
          {editCat && data.budgets[editCat] && (
            <button className="btn-danger" onClick={handleDelete}>Remove Budget</button>
          )}
        </div>
      </Modal>
    </div>
  );
}
