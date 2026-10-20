import { useState, useMemo } from 'react';
import Modal from '../components/Modal';
import SubscriptionCard from '../components/SubscriptionCard';
import EmptyState from '../components/EmptyState';
import { CATEGORIES, CATEGORY_MAP, formatCurrency } from '../constants/categories';
import { getMonthlyAmount } from '../utils/subscriptions';
import { isCredit } from '../utils/transactions';

const EMPTY_SUB = { name: '', amount: '', frequency: 'monthly', category: 'utilities', nextDate: '' };

export default function Subscriptions({ data, addSubscription, updateSubscription, deleteSubscription }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_SUB);

  const subs = data.subscriptions;

  const totalMonthly = useMemo(
    () => subs.reduce((sum, s) => sum + getMonthlyAmount(s.amount, s.frequency), 0),
    [subs]
  );

  // Group detected subscription transactions by name
  const detectedSubs = useMemo(() => {
    const subTxs = data.transactions.filter((tx) => tx.isSubscription && !isCredit(tx));
    const grouped = {};
    subTxs.forEach((tx) => {
      const key = tx.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
      if (!grouped[key]) {
        grouped[key] = { name: tx.name, category: tx.category, transactions: [] };
      }
      grouped[key].transactions.push(tx);
    });

    return Object.values(grouped).map((g) => {
      const sorted = g.transactions.sort((a, b) => b.date.localeCompare(a.date));
      const latest = sorted[0];
      const amounts = sorted.map((tx) => tx.amount);
      const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
      return {
        name: g.name,
        category: g.category,
        latestDate: latest.date,
        latestAmount: latest.amount,
        avgAmount: Math.round(avgAmount * 100) / 100,
        count: sorted.length,
        transactions: sorted,
      };
    }).sort((a, b) => b.latestDate.localeCompare(a.latestDate));
  }, [data.transactions]);

  const detectedMonthly = useMemo(
    () => detectedSubs.reduce((sum, s) => sum + s.avgAmount, 0),
    [detectedSubs]
  );

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_SUB);
    setModalOpen(true);
  };

  const openEdit = (sub) => {
    setEditing(sub);
    setForm({ name: sub.name, amount: sub.amount, frequency: sub.frequency, category: sub.category, nextDate: sub.nextDate });
    setModalOpen(true);
  };

  const handleSave = () => {
    const payload = { ...form, amount: parseFloat(form.amount) || 0 };
    if (editing) {
      updateSubscription(editing.id, payload);
    } else {
      addSubscription(payload);
    }
    setModalOpen(false);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="page subscriptions">
      <div className="page-header">
        <div>
          <h2>Subscriptions</h2>
          <p className="page-subtitle">
            {subs.length} manual &middot; {formatCurrency(totalMonthly)}/mo
          </p>
        </div>
        <button className="btn-primary" onClick={openAdd}>+ Add</button>
      </div>

      {subs.length === 0 && detectedSubs.length === 0 ? (
        <EmptyState icon={'\u{1F504}'} message="No subscriptions yet." action={<button className="btn-primary" onClick={openAdd}>Add Subscription</button>} />
      ) : (
        <>
          {subs.map((sub) => (
            <SubscriptionCard key={sub.id} subscription={sub} onEdit={openEdit} onDelete={deleteSubscription} />
          ))}

          {detectedSubs.length > 0 && (
            <div className="detected-subs">
              <h3>Detected from Imports</h3>
              <p className="page-subtitle" style={{ marginBottom: 16 }}>
                {detectedSubs.length} subscriptions &middot; ~{formatCurrency(detectedMonthly)}/mo
              </p>
              {detectedSubs.map((sub) => {
                const cat = CATEGORY_MAP[sub.category] || CATEGORY_MAP.other;
                return (
                  <div key={sub.name} className="detected-sub-card">
                    <div className="sub-icon" style={{ backgroundColor: cat.color + '22', color: cat.color }}>
                      {cat.icon}
                    </div>
                    <div className="sub-info">
                      <span className="sub-name">{sub.name}</span>
                      <span className="sub-meta">
                        {cat.name} &middot; {sub.count} charge{sub.count > 1 ? 's' : ''} &middot; Last: {sub.latestDate}
                      </span>
                    </div>
                    <div className="sub-amounts">
                      <span className="sub-amount">{formatCurrency(sub.latestAmount)}</span>
                      {sub.count > 1 && (
                        <span className="sub-monthly">avg {formatCurrency(sub.avgAmount)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Subscription' : 'Add Subscription'}>
        <div className="form-group">
          <label>Name</label>
          <input value={form.name} onChange={set('name')} placeholder="Netflix, Spotify, etc." />
        </div>
        <div className="form-group">
          <label>Amount</label>
          <input type="number" step="0.01" value={form.amount} onChange={set('amount')} placeholder="15.49" />
        </div>
        <div className="form-group">
          <label>Frequency</label>
          <select value={form.frequency} onChange={set('frequency')}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        <div className="form-group">
          <label>Category</label>
          <select value={form.category} onChange={set('category')}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Next Bill Date</label>
          <input type="date" value={form.nextDate} onChange={set('nextDate')} />
        </div>
        <button className="btn-primary" onClick={handleSave}>Save</button>
      </Modal>
    </div>
  );
}
