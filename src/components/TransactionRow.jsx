import { CATEGORY_MAP, formatCurrency } from '../constants/categories';

// Edit/Del buttons render only when their handlers are passed
export default function TransactionRow({ transaction, onEdit, onDelete }) {
  const { name, amount, category, date, source } = transaction;
  const cat = CATEGORY_MAP[category] || CATEGORY_MAP.other;

  return (
    <div className="transaction-row">
      <div className="tx-icon" style={{ backgroundColor: cat.color + '22', color: cat.color }}>
        {cat.icon}
      </div>
      <div className="tx-info">
        <span className="tx-name">{name}</span>
        <span className="tx-meta">
          {date} &middot; {cat.name}
          {transaction.isSubscription && <span className="tx-badge sub">SUB</span>}
          {source === 'csv_import' && <span className="tx-badge">CSV</span>}
          {source === 'plaid' && <span className="tx-badge">SYNC</span>}
        </span>
      </div>
      <div className="tx-amount">{formatCurrency(amount)}</div>
      {(onEdit || onDelete) && (
        <div className="tx-actions">
          {onEdit && <button className="btn-icon" onClick={() => onEdit(transaction)}>Edit</button>}
          {onDelete && <button className="btn-icon danger" onClick={() => onDelete(transaction.id)}>Del</button>}
        </div>
      )}
    </div>
  );
}
