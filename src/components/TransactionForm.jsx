import { useState } from 'react';
import { CATEGORY_MAP, categoriesFor } from '../constants/categories';
import { todayISO } from '../utils/dates';

// Mount with a `key` per transaction so the form resets between edits. `accounts` are the Net Worth
// accounts a transfer can be linked to (ones that aren't imported or synced).
export default function TransactionForm({ transaction, onSave, accounts = [] }) {
  const [form, setForm] = useState(() => (
    transaction
      ? { name: transaction.name, amount: transaction.amount, category: transaction.category, date: transaction.date, transferAccountId: transaction.transferAccountId || '' }
      : { name: '', amount: '', category: 'other', date: todayISO(), transferAccountId: '' }
  ));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // Money in gets income categories; a category from before those existed (Other on a credit) stays selectable
  const choices = categoriesFor(transaction?.type === 'credit');
  const legacy = transaction && !choices.some((c) => c.id === transaction.category) ? CATEGORY_MAP[transaction.category] : null;
  const options = legacy ? [...choices, legacy] : choices;
  const isTransfer = form.category === 'transfers';

  const handleSave = () => onSave({
    ...form,
    amount: parseFloat(form.amount) || 0,
    transferAccountId: isTransfer && form.transferAccountId ? form.transferAccountId : undefined,
  });

  return (
    <>
      <div className="form-group">
        <label>Description</label>
        <input value={form.name} onChange={set('name')} placeholder="Grocery run, dinner, etc." />
      </div>
      <div className="form-group">
        <label>Amount</label>
        <input type="number" step="0.01" value={form.amount} onChange={set('amount')} placeholder="25.00" />
      </div>
      <div className="form-group">
        <label>Category</label>
        <select value={form.category} onChange={set('category')}>
          {options.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
      </div>
      {isTransfer && accounts.length > 0 && (
        <div className="form-group">
          <label>Other Account (Net Worth)</label>
          <select value={form.transferAccountId} onChange={set('transferAccountId')}>
            <option value="">None</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <p className="muted settings-help">
            The account this money moved to or from, if it isn&apos;t imported or synced. Net Worth moves that account&apos;s
            balance the other way, so the transfer doesn&apos;t look like money appearing or disappearing.
          </p>
        </div>
      )}
      <div className="form-group">
        <label>Date</label>
        <input type="date" value={form.date} onChange={set('date')} />
      </div>
      <button className="btn-primary" onClick={handleSave}>Save</button>
    </>
  );
}
