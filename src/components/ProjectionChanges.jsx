import { useState } from 'react';
import HelpToggle from './HelpToggle';
import { currentMonth } from '../utils/dates';
import { makeId } from '../utils/ids';
import { describeChange } from '../utils/projection';

// What the form offers, as the stored kind and the sign of its amount
const CHANGE_TYPES = [
  { id: 'takeHomeDown', label: 'Take-home pay drops', kind: 'takeHome', sign: -1 },
  { id: 'takeHomeUp', label: 'Take-home pay rises', kind: 'takeHome', sign: 1 },
  { id: 'payRaise', label: 'Pay rises by a percentage (promotion)', kind: 'payRaise', sign: 1 },
  { id: 'spendingUp', label: 'Spending rises', kind: 'spending', sign: 1 },
  { id: 'spendingDown', label: 'Spending drops', kind: 'spending', sign: -1 },
  { id: 'oneTimeOut', label: 'One-time cost', kind: 'oneTime', sign: -1 },
  { id: 'oneTimeIn', label: 'One-time money in', kind: 'oneTime', sign: 1 },
  { id: 'stopPaychecks', label: 'Paychecks stop (retirement)', kind: 'stopPaychecks' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HELP = 'Changes you expect, from a month on: take-home pay or spending going up or down (a dependent no longer qualifying for '
  + 'tax credits, childcare starting or ending), pay rising by a percentage (a promotion: paycheck contributions rise by all of it, '
  + 'take-home by about 85% of it, since a raise is taxed at your top rate), a one-time amount in or out (a car, an inheritance), or '
  + 'paychecks stopping when you retire, which also stops paycheck contributions. Dollar amounts are in today’s dollars: they grow '
  + 'with raises (take-home) or inflation (spending and one-time amounts), like everything else. Untick a change to see the '
  + 'projection without it.';

// The projection's future changes: listed with a switch and Delete, plus a form to add one.
// `changes` are resolveChanges' (sorted, well formed); `markerNumbers` maps a change id to its number on the
// chart; `onSave({ changes })` replaces the list.
export default function ProjectionChanges({ changes, endMonth, markerNumbers = {}, open, onToggleHelp, onSave }) {
  const [form, setForm] = useState(() => ({ type: 'takeHomeDown', amount: '', month: '01', year: String(Number(currentMonth().slice(0, 4)) + 1), label: '' }));
  const type = CHANGE_TYPES.find((t) => t.id === form.type);
  const amount = parseFloat(form.amount);
  const year = Number(form.year);
  const valid = Number.isInteger(year) && year >= 1900 && year <= 2200 && (type.kind === 'stopPaychecks' || amount > 0);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // makeId runs here, outside any state updater
  const add = () => {
    const change = { id: makeId('chg'), month: `${year}-${form.month}`, kind: type.kind };
    if (type.kind !== 'stopPaychecks') change.amount = type.sign * amount;
    if (form.label.trim()) change.label = form.label.trim().slice(0, 60);
    onSave({ changes: [...changes, change] });
    setForm((f) => ({ ...f, amount: '', label: '' }));
  };
  const toggle = (id) => onSave({ changes: changes.map((c) => (c.id === id ? { ...c, enabled: c.enabled === false } : c)) });
  const remove = (id) => {
    const next = changes.filter((c) => c.id !== id);
    onSave({ changes: next.length ? next : undefined });
  };

  return (
    <div className="projection-changes">
      <div className="projection-label">
        <h4 className="projection-subheading">Future changes</h4>
        <HelpToggle about="a future change" open={open} onClick={onToggleHelp} />
      </div>
      {open && <div className="projection-explain">{HELP}</div>}
      {changes.length > 0 && (
        <ul className="projection-change-list">
          {changes.map((c) => (
            <li key={c.id} className="projection-change">
              <label className="toggle-label">
                <input type="checkbox" checked={c.enabled !== false} onChange={() => toggle(c.id)} />
                <span>
                  {markerNumbers[c.id] && <span className="projection-marker" title="Its number on the chart">{markerNumbers[c.id]}</span>}
                  {c.label && <strong>{c.label}: </strong>}
                  {describeChange(c)}
                  {c.month > endMonth && <span className="muted"> (after the projection ends)</span>}
                </span>
              </label>
              <button className="btn-icon danger" onClick={() => remove(c.id)}>Del</button>
            </li>
          ))}
        </ul>
      )}
      <div className="projection-change-form">
        <div className="form-group">
          <label>What changes</label>
          <select value={form.type} onChange={set('type')}>
            {CHANGE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {type.kind !== 'stopPaychecks' && (
          <div className="form-group">
            <label>{type.kind === 'payRaise' ? 'Raise (% of pay)' : <>{type.kind === 'oneTime' ? 'Amount' : 'By how much a month'} (today&apos;s dollars)</>}</label>
            <input type="number" min="0" step={type.kind === 'payRaise' ? 0.5 : 10} value={form.amount} onChange={set('amount')} placeholder={type.kind === 'payRaise' ? '8' : '500'} />
          </div>
        )}
        <div className="form-group">
          <label>{type.kind === 'oneTime' ? 'In' : 'Starting'}</label>
          <div className="projection-when">
            <select value={form.month} onChange={set('month')} aria-label="Month">
              {MONTHS.map((name, i) => <option key={name} value={String(i + 1).padStart(2, '0')}>{name}</option>)}
            </select>
            <input type="number" value={form.year} onChange={set('year')} aria-label="Year" />
          </div>
        </div>
        <div className="form-group">
          <label>Description (optional)</label>
          <input value={form.label} onChange={set('label')} placeholder="e.g. Childcare ends" maxLength={60} />
        </div>
        <div className="form-group projection-change-add">
          <button className="btn-secondary" onClick={add} disabled={!valid}>Add Change</button>
        </div>
      </div>
    </div>
  );
}
