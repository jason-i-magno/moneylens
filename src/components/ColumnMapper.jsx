import { useState } from 'react';
import { detectDateFormat } from '../utils/csvParser';

const AMOUNT_FORMATS = [
  { value: 'negative_is_debit', label: 'Negative = Debit' },
  { value: 'positive_is_debit', label: 'Positive = Debit' },
  { value: 'two_columns', label: 'Separate Debit/Credit columns' },
];

const DATE_FORMATS = ['MM/DD/YYYY', 'YYYY-MM-DD', 'MM-DD-YYYY', 'DD/MM/YYYY'];

function guessColumn(headers, pattern, fallbackIndex) {
  return headers.find((h) => pattern.test(h)) || headers[fallbackIndex] || '';
}

function detectForColumn(rows, column) {
  return detectDateFormat(rows.slice(0, 20).map((r) => r[column]));
}

// rows: parsed CSV rows, used to detect the date format of whichever column is mapped as the date.
// onSubmit(mapping, saveName) — saveName is '' when the user doesn't want a reusable profile.
export default function ColumnMapper({ headers, rows, onSubmit }) {
  const [mapping, setMapping] = useState(() => {
    const dateColumn = guessColumn(headers, /date/i, 0);
    return {
      dateColumn,
      descriptionColumn: guessColumn(headers, /desc|name|payee|merchant/i, 1),
      amountColumn: guessColumn(headers, /amount/i, 2),
      categoryColumn: '',
      amountFormat: 'negative_is_debit',
      dateFormat: detectForColumn(rows, dateColumn),
      debitColumn: '',
      creditColumn: '',
    };
  });
  const [saveName, setSaveName] = useState('');

  const set = (key) => (e) => setMapping((m) => ({ ...m, [key]: e.target.value }));

  const handleDateColumnChange = (e) => {
    const dateColumn = e.target.value;
    setMapping((m) => ({ ...m, dateColumn, dateFormat: detectForColumn(rows, dateColumn) }));
  };

  return (
    <div className="column-mapper">
      <div className="mapper-row">
        <label>Date Column</label>
        <select value={mapping.dateColumn} onChange={handleDateColumnChange}>
          {headers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </div>

      <div className="mapper-row">
        <label>Description Column</label>
        <select value={mapping.descriptionColumn} onChange={set('descriptionColumn')}>
          {headers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </div>

      <div className="mapper-row">
        <label>Amount Format</label>
        <select value={mapping.amountFormat} onChange={set('amountFormat')}>
          {AMOUNT_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      {mapping.amountFormat === 'two_columns' ? (
        <>
          <div className="mapper-row">
            <label>Debit Column</label>
            <select value={mapping.debitColumn} onChange={set('debitColumn')}>
              <option value="">Select...</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
          <div className="mapper-row">
            <label>Credit Column</label>
            <select value={mapping.creditColumn} onChange={set('creditColumn')}>
              <option value="">Select...</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>
        </>
      ) : (
        <div className="mapper-row">
          <label>Amount Column</label>
          <select value={mapping.amountColumn} onChange={set('amountColumn')}>
            {headers.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      )}

      <div className="mapper-row">
        <label>Category Column (optional)</label>
        <select value={mapping.categoryColumn} onChange={set('categoryColumn')}>
          <option value="">None</option>
          {headers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </div>

      <div className="mapper-row">
        <label>Date Format</label>
        <select value={mapping.dateFormat} onChange={set('dateFormat')}>
          {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      </div>

      <div className="mapper-row">
        <label>Save as bank profile (optional)</label>
        <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="e.g. Chase Checking" />
      </div>

      <button className="btn-primary" onClick={() => onSubmit(mapping, saveName.trim())}>
        Continue
      </button>
    </div>
  );
}
