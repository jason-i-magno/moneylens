import { useState, useMemo } from 'react';
import Modal from '../components/Modal';
import MiniBar from '../components/MiniBar';
import MonthSelect from '../components/MonthSelect';
import SummaryCard from '../components/SummaryCard';
import EmptyState from '../components/EmptyState';
import { SPENDING_CATEGORIES, formatCurrency } from '../constants/categories';
import { currentMonth, daysInMonth, formatMonth, getMonthOptions, todayISO } from '../utils/dates';
import { averageSpending, budgetTotals, monthProgress, monthSpending } from '../utils/budgets';

// Months the suggested budgets average over
const AVERAGE_MONTHS = 6;
// Transfers never count as spending, so they can't have a budget
const BUDGET_CATEGORIES = SPENDING_CATEGORIES.filter((c) => c.id !== 'transfers');

// 'May – October 2026', or 'November 2025 – April 2026' across a year
function formatMonthRange(first, last) {
  if (first === last) return formatMonth(first);
  return first.slice(0, 4) === last.slice(0, 4)
    ? `${formatMonth(first).split(' ')[0]} – ${formatMonth(last)}`
    : `${formatMonth(first)} – ${formatMonth(last)}`;
}

export default function Budgets({ data, setBudget, deleteBudget }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editCat, setEditCat] = useState('');
  const [amount, setAmount] = useState('');
  const thisMonth = currentMonth();
  const monthOptions = useMemo(() => getMonthOptions(data.transactions), [data.transactions]);
  const [month, setMonth] = useState(thisMonth);

  const spending = useMemo(() => monthSpending(data.transactions, month), [data.transactions, month]);
  const totals = useMemo(() => budgetTotals(data.budgets, spending), [data.budgets, spending]);
  const history = useMemo(() => averageSpending(data.transactions, thisMonth, AVERAGE_MONTHS), [data.transactions, thisMonth]);

  // Pace: how much of the budget an even rate of spending would have used by today (this month only)
  const isCurrent = month === thisMonth;
  const today = todayISO();
  const progress = isCurrent ? monthProgress(month, today) : null;
  const expected = isCurrent ? Math.round(totals.budgeted * progress * 100) / 100 : 0;
  const paceLabel = `Pace (day ${Number(today.slice(8, 10))} of ${daysInMonth(month)})`;

  const rows = useMemo(
    () => BUDGET_CATEGORIES.filter((c) => data.budgets[c.id] > 0 || spending[c.id] > 0 || history.averages[c.id] > 0),
    [data.budgets, spending, history],
  );

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

  const suggestion = editCat ? history.averages[editCat] : 0;
  const averagedOver = history.months.length > 0 ? formatMonthRange(history.months[0], history.months.at(-1)) : null;

  return (
    <div className="page budgets">
      <div className="page-header">
        <div>
          <h2>Budgets</h2>
          <p className="page-subtitle">
            {formatMonth(month)}
            {averagedOver && <> &middot; averages cover {averagedOver}</>}
          </p>
        </div>
        <div className="page-header-actions">
          <MonthSelect months={monthOptions} value={month} onChange={setMonth} />
          <button className="btn-primary" onClick={openAdd}>+ Set Budget</button>
        </div>
      </div>

      {totals.budgeted > 0 && (
        <div className="summary-grid">
          <SummaryCard label="Budgeted" value={formatCurrency(totals.budgeted)} />
          <SummaryCard label="Spent" value={formatCurrency(totals.spent)} note="In categories with a budget" />
          {totals.left >= 0
            ? <SummaryCard label={isCurrent ? 'Left' : 'Under Budget'} value={formatCurrency(totals.left)} tone="good" />
            : <SummaryCard label="Over Budget" value={formatCurrency(-totals.left)} tone="bad" />}
          {isCurrent && (
            <SummaryCard
              label={paceLabel}
              value={totals.spent <= expected ? 'On track' : `${formatCurrency(totals.spent - expected)} over`}
              tone={totals.spent <= expected ? 'good' : 'bad'}
              note={`${formatCurrency(expected)} by today at an even pace`}
            />
          )}
          {totals.unbudgeted > 0 && (
            <SummaryCard label="Not Budgeted" value={formatCurrency(totals.unbudgeted)} note="Spending in categories without a budget" />
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={'\u{1F4CA}'} message="No budgets set yet." action={<button className="btn-primary" onClick={openAdd}>Set a Budget</button>} />
      ) : (
        rows.map((cat) => {
          const spent = spending[cat.id] || 0;
          const budget = data.budgets[cat.id] || 0;
          const average = history.averages[cat.id] || 0;
          const over = budget > 0 && spent > budget;

          return (
            <div key={cat.id} className="budget-row" onClick={() => openEdit(cat.id)}>
              <div className="budget-label">
                <span className="budget-icon">{cat.icon}</span>
                <div>
                  <span className="budget-name">{cat.name}</span>
                  {average > 0 && <span className="budget-average">avg {formatCurrency(average)}/mo</span>}
                </div>
              </div>
              <div className="budget-bar-wrap">
                <MiniBar spent={spent} budget={budget} color={cat.color} marker={isCurrent && budget > 0 ? progress : null} />
                <div className="budget-amounts-row">
                  <span className={`budget-amounts ${over ? 'over' : ''}`}>
                    {formatCurrency(spent)} / {budget > 0 ? formatCurrency(budget) : 'No budget'}
                  </span>
                  {budget > 0 && (
                    <span className={`budget-left ${over ? 'over' : ''}`}>
                      {over ? `${formatCurrency(spent - budget)} over` : `${formatCurrency(budget - spent)} ${isCurrent ? 'left' : 'under'}`}
                    </span>
                  )}
                </div>
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
            {BUDGET_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Monthly Budget</label>
          <input type="number" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500" />
        </div>
        {suggestion > 0 && (
          <div className="budget-suggestion">
            <span className="muted">Average over the last {history.months.length === 1 ? 'month' : `${history.months.length} months`}: {formatCurrency(suggestion)}</span>
            <button className="btn-secondary" onClick={() => setAmount(String(suggestion))}>Use {formatCurrency(suggestion)}</button>
          </div>
        )}
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
