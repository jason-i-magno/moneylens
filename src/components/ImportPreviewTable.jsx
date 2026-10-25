import { categoriesFor, formatCurrency } from '../constants/categories';

export default function ImportPreviewTable({ transactions, onCategoryChange, onToggleSkip }) {
  return (
    <div className="import-preview">
      <table>
        <thead>
          <tr>
            <th>Skip</th>
            <th>Date</th>
            <th>Description</th>
            <th>Amount</th>
            <th>Type</th>
            <th>Category</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.index} className={!tx.valid ? 'row-invalid' : tx.isDuplicate ? 'row-duplicate' : ''}>
              <td>
                <input
                  type="checkbox"
                  checked={tx.skip}
                  onChange={() => onToggleSkip(tx.index)}
                />
              </td>
              <td>{tx.date || 'Invalid'}</td>
              <td className="desc-cell">{tx.description}</td>
              <td>{formatCurrency(tx.amount)}</td>
              <td>{tx.isDebit ? 'Debit' : 'Credit'}</td>
              <td>
                <select
                  value={tx.category}
                  onChange={(e) => onCategoryChange(tx.index, e.target.value)}
                >
                  {categoriesFor(tx.isDebit === false).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </td>
              <td>
                {!tx.valid && <span className="badge-error">Parse Error</span>}
                {tx.isDuplicate && <span className="badge-warn">Duplicate</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
