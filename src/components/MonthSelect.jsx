import { formatMonth } from '../utils/dates';

// Month picker for page headers ('YYYY-MM' values, shown as "October 2026")
export default function MonthSelect({ months, value, onChange }) {
  return (
    <select className="month-select" aria-label="Month" value={value} onChange={(e) => onChange(e.target.value)}>
      {months.map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}
    </select>
  );
}
