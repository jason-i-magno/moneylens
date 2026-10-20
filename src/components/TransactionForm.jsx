import { useState } from 'react';
import { CATEGORIES } from '../constants/categories';
import { todayISO } from '../utils/dates';

// Mount with a `key` per transaction so the form resets between edits
export default function TransactionForm({ transaction, onSave }) {
  const [form, setForm] = useState(() => (
    transaction
      ? { name: transaction.name, amount: transaction.amount, category: transaction.category, date: transaction.date }
      : { name: '', amount: '', category: 'other', date: todayISO() }
  ));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

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
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>Date</label>
        <input type="date" value={form.date} onChange={set('date')} />
      </div>
      <button className="btn-primary" onClick={() => onSave({ ...form, amount: parseFloat(form.amount) || 0 })}>Save</button>
    </>
  );
}
