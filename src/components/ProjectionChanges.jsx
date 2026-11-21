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
  { id: 'periodCost', label: 'A cost for several years (e.g. college)', kind: 'periodCost' },
  { id: 'contribution', label: 'Regular deposits into an account', kind: 'contribution' },
  { id: 'spendAccount', label: 'Spend an account down', kind: 'spendAccount' },
  { id: 'stopPaychecks', label: 'Paychecks stop (retirement)', kind: 'stopPaychecks' },
];
const EVERY_OPTIONS = [
  { months: 1, label: 'Every month' },
  { months: 3, label: 'Every 3 months' },
  { months: 6, label: 'Twice a year' },
  { months: 12, label: 'Once a year' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const HELP = 'Changes you expect, from a month on: take-home pay or spending going up or down (a dependent no longer qualifying for '
  + 'tax credits, childcare starting or ending), pay rising by a percentage (a promotion: paycheck contributions rise by all of it, '
  + 'take-home by about 85% of it, since a raise is taxed at your top rate), a one-time amount in or out (a car, an inheritance), '
  + 'a cost for several years (college: paid first from an account such as a 529, the rest from what you save, rising by its own rate '
  + 'or with inflation), regular deposits into an account (a 529: they come out of what you save, and a match is added on top), '
  + 'spending an account down over some years (that money leaves your net worth), or paychecks stopping when you retire, which also '
  + 'stops paycheck contributions. Dollar amounts are in today’s dollars: they grow with raises (take-home) or inflation (everything '
  + 'else), like the rest of the projection. Untick a change to see the projection without it.';

const ACCOUNT_KINDS = ['contribution', 'spendAccount'];

// The projection's future changes: listed with a switch and Delete, plus a form to add one.
// `changes` are resolveChanges' (sorted, well formed); `accounts` ({ id, name }) are the ones deposits and
// spending down can use; `markerNumbers` maps a change id to its number on the chart; `onSave({ changes })`
// replaces the list.
export default function ProjectionChanges({ changes, accounts = [], endMonth, markerNumbers = {}, open, onToggleHelp, onSave }) {
  const [form, setForm] = useState(() => ({
    type: 'takeHomeDown', amount: '', month: '01', year: String(Number(currentMonth().slice(0, 4)) + 1), label: '',
    accountId: '', every: '12', times: '', match: '', years: '4', payFrom: '', growth: '',
  }));
  const type = CHANGE_TYPES.find((t) => t.id === form.type);
  const kind = type.kind;
  const amount = parseFloat(form.amount);
  const year = Number(form.year);
  const times = form.times.trim() ? Number(form.times) : undefined;
  const match = form.match.trim() ? Number(form.match) : undefined;
  const years = Number(form.years);
  const growth = form.growth.trim() ? Number(form.growth) : undefined;
  const accountId = form.accountId || accounts[0]?.id || '';
  const nameOf = (id) => accounts.find((a) => a.id === id)?.name || 'A removed account';

  const validFor = {
    stopPaychecks: true,
    contribution: !!accountId && amount > 0 && (times === undefined || (Number.isInteger(times) && times > 0)) && (match === undefined || match >= 0),
    spendAccount: !!accountId && years > 0,
    periodCost: amount > 0 && years > 0 && (growth === undefined || Number.isFinite(growth)),
  };
  const valid = Number.isInteger(year) && year >= 1900 && year <= 2200 && (validFor[kind] ?? amount > 0);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // makeId runs here, outside any state updater
  const add = () => {
    const change = { id: makeId('chg'), month: `${year}-${form.month}`, kind };
    if (ACCOUNT_KINDS.includes(kind)) change.accountId = accountId;
    if (kind === 'contribution') {
      Object.assign(change, { amount, every: Number(form.every) });
      if (times !== undefined) change.times = times;
      if (match) change.match = match;
    } else if (kind === 'spendAccount') {
      change.years = years;
    } else if (kind === 'periodCost') {
      Object.assign(change, { amount, years });
      if (form.payFrom) change.accountId = form.payFrom;
      if (growth !== undefined) change.growth = growth;
    } else if (kind !== 'stopPaychecks') {
      change.amount = type.sign * amount;
    }
    if (form.label.trim()) change.label = form.label.trim().slice(0, 60);
    onSave({ changes: [...changes, change] });
    setForm((f) => ({ ...f, amount: '', label: '', times: '', match: '', growth: '' }));
  };
  const toggle = (id) => onSave({ changes: changes.map((c) => (c.id === id ? { ...c, enabled: c.enabled === false } : c)) });
  const remove = (id) => {
    const next = changes.filter((c) => c.id !== id);
    onSave({ changes: next.length ? next : undefined });
  };

  const amountLabel = {
    payRaise: 'Raise (% of pay)',
    contribution: 'Each deposit (today’s dollars)',
    periodCost: 'Cost a year (today’s dollars)',
    oneTime: 'Amount (today’s dollars)',
  }[kind] || 'By how much a month (today’s dollars)';
  const startLabel = { oneTime: 'In', contribution: 'First deposit' }[kind] || 'Starting';

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
                  {describeChange(c, nameOf)}
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
        {ACCOUNT_KINDS.includes(kind) && (
          <div className="form-group">
            <label>Account</label>
            <select value={accountId} onChange={set('accountId')}>
              {accounts.length === 0 && <option value="">No accounts to use</option>}
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        {kind !== 'stopPaychecks' && kind !== 'spendAccount' && (
          <div className="form-group">
            <label>{amountLabel}</label>
            <input type="number" min="0" step={kind === 'payRaise' ? 0.5 : 10} value={form.amount} onChange={set('amount')} placeholder={kind === 'payRaise' ? '8' : '500'} />
          </div>
        )}
        {kind === 'contribution' && (
          <>
            <div className="form-group">
              <label>How often</label>
              <select value={form.every} onChange={set('every')}>
                {EVERY_OPTIONS.map((o) => <option key={o.months} value={String(o.months)}>{o.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>How many deposits (blank: no end)</label>
              <input type="number" min="1" step="1" value={form.times} onChange={set('times')} placeholder="5" />
            </div>
            <div className="form-group">
              <label>Match (% of each deposit, optional)</label>
              <input type="number" min="0" step="10" value={form.match} onChange={set('match')} placeholder="100" />
            </div>
          </>
        )}
        {kind === 'spendAccount' && (
          <div className="form-group">
            <label>Over how many years</label>
            <input type="number" min="1" step="1" value={form.years} onChange={set('years')} />
          </div>
        )}
        {kind === 'periodCost' && (
          <>
            <div className="form-group">
              <label>For how many years</label>
              <input type="number" min="1" step="1" value={form.years} onChange={set('years')} />
            </div>
            <div className="form-group">
              <label>Paid first from</label>
              <select value={form.payFrom} onChange={set('payFrom')}>
                <option value="">Savings only</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Rises (% a year, blank: inflation)</label>
              <input type="number" step="0.1" value={form.growth} onChange={set('growth')} placeholder="3.5" />
            </div>
          </>
        )}
        <div className="form-group">
          <label>{startLabel}</label>
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
