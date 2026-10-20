import { CATEGORY_MAP, formatCurrency } from '../constants/categories';
import { getMonthlyAmount } from '../utils/subscriptions';

const FREQ_LABELS = {
  weekly: '/wk',
  monthly: '/mo',
  quarterly: '/qtr',
  yearly: '/yr',
};

export default function SubscriptionCard({ subscription, onEdit, onDelete }) {
  const { name, amount, frequency, category, nextDate } = subscription;
  const cat = CATEGORY_MAP[category] || CATEGORY_MAP.other;
  const monthly = getMonthlyAmount(amount, frequency);

  return (
    <div className="subscription-card">
      <div className="sub-icon" style={{ backgroundColor: cat.color + '22', color: cat.color }}>
        {cat.icon}
      </div>
      <div className="sub-info">
        <span className="sub-name">{name}</span>
        <span className="sub-meta">
          {cat.name} &middot; Next: {nextDate}
        </span>
      </div>
      <div className="sub-amounts">
        <span className="sub-amount">{formatCurrency(amount)}{FREQ_LABELS[frequency]}</span>
        <span className="sub-monthly">{formatCurrency(monthly)}/mo</span>
      </div>
      <div className="sub-actions">
        <button className="btn-icon" onClick={() => onEdit(subscription)}>Edit</button>
        <button className="btn-icon danger" onClick={() => onDelete(subscription.id)}>Del</button>
      </div>
    </div>
  );
}
