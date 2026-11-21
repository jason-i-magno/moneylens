import { useMemo, useState } from 'react';
import { ComposedChart, Area, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import SummaryCard from './SummaryCard';
import { formatCompactCurrency, formatCurrency } from '../constants/categories';
import { chartTooltipProps } from '../constants/chartTooltip';
import { currentMonth, formatMonth } from '../utils/dates';
import {
  RANGE_POINTS, cashFlowBaseline, monthlyPaycheckContribution, projectNetWorth, projectionLoans,
  projectionMilestones, resolveProjectionSettings,
} from '../utils/projection';

const CHART_MARGIN = { left: 10, right: 20, top: 24, bottom: 10 };
const Y_AXIS_WIDTH = 70;
const LOAN_PREFIX = 'auto_loan_';

// `help`: what the field does in the projection
const RATE_FIELDS = [
  { key: 'years', label: 'Years ahead', step: 1, help: 'How far ahead the chart and the cards go.' },
  { key: 'investReturn', label: 'Investment return (% a year)', step: 0.1, help: 'Growth of investment accounts, and of savings once the cash cushion is full.' },
  { key: 'cashReturn', label: 'Cash interest (% a year)', step: 0.1, help: 'Interest on bank accounts and on savings kept as the cash cushion.' },
  { key: 'homeGrowth', label: 'Home value growth (% a year)', step: 0.1, help: "Change in your home's value. Paying the mortgage down adds to your equity on top of this." },
  { key: 'raise', label: 'Raises (% a year)', step: 0.1, help: 'Growth of take-home pay and paycheck contributions. Raises above inflation widen what you save.' },
  { key: 'inflation', label: 'Inflation (% a year)', step: 0.1, help: "Growth of spending and escrow. It's also what “today's dollars” takes back out." },
];
const HELP = {
  takeHome: 'Everything that comes in each month, after taxes and paycheck deductions. What spending and the mortgage leave is saved.',
  spending: 'Everything you spend apart from the mortgage, which the projection pays itself. It rises with inflation.',
  extra: 'Paid on top of the regular payment until the loan is gone. It comes out of savings, so it trades investing for paying the loan off sooner.',
  cashCushion: 'Savings stay in cash, earning cash interest, until cash reaches this amount (rising with inflation). After that they are invested.',
  holdFlat: 'A held account keeps today’s balance: no growth and no contributions. Useful for crypto, or PTO you’ll use rather than keep.',
};
// How much each kind of field is nudged to show its effect
const NUDGE = { rate: 1, monthly: 100, cushion: 10000 };

// How the projection treats an account: by its Net Worth category
const KIND_BY_CATEGORY = { investment: 'invest', bank: 'cash', property: 'home' };
const kindOf = (acct, flat) => {
  if (acct.type === 'liability') return 'debt';
  return flat ? 'flat' : KIND_BY_CATEGORY[acct.category] || 'cash';
};

const parseNumber = (text) => {
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : undefined;
};

// 'YYYY-MM' → 'Oct 2031'
const shortMonth = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
};
// 'YYYY-MM' → a position on the chart's year axis
const yearPosition = (month) => Number(month.slice(0, 4)) + (Number(month.slice(5, 7)) - 1) / 12;
// Whole months from one 'YYYY-MM' to another
const monthsFrom = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

// '+$640K' / '−$12K'; small amounts read as no real change
const signed = (amount) => {
  if (Math.abs(amount) < 500) return 'about the same';
  return `${amount > 0 ? '+' : '−'}${formatCompactCurrency(Math.abs(amount))}`;
};

// The small "i" that shows or hides an explanation
function HelpToggle({ about, open, onClick }) {
  return (
    <button type="button" className={`info-toggle ${open ? 'active' : ''}`} aria-expanded={open} aria-label={`What ${about} does`} title={open ? 'Hide' : 'What this does'} onClick={onClick}>
      i
    </button>
  );
}

// hint: the figure from your data, always shown. help (what the field does) and effect (what a nudge to it
// changes) show only while the field's "i" is open; effect is worked out only then.
function Field({ label, value, step, help, hint, open, effect, onToggleHelp, onChange, onCommit }) {
  return (
    <div className="form-group">
      <div className="projection-label">
        <label>{label}</label>
        {help && <HelpToggle about={label} open={open} onClick={onToggleHelp} />}
      </div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {hint && <span className="projection-hint">{hint}</span>}
      {open && (
        <div className="projection-explain">
          {help}
          {effect && <span className="projection-effect">{effect()}</span>}
        </div>
      )}
    </div>
  );
}

// Where today's balances go: see projectNetWorth. `accounts` are the Net Worth page's accounts with their
// latest balances (mortgage loans and properties included); `settings` is data.netWorth.projection, and
// `onSave(changes)` merges into it (undefined removes a setting).
export default function NetWorthProjection({ accounts, mortgages, transactions, settings = {}, onSave }) {
  // Typed but not yet saved (fields save when they lose focus, not on every keystroke)
  const [draft, setDraft] = useState({});
  const [todaysDollars, setTodaysDollars] = useState(false);
  // The one field whose explanation is open, if any
  const [helpOpen, setHelpOpen] = useState(null);
  const helpFor = (key) => ({ open: helpOpen === key, onToggleHelp: () => setHelpOpen((k) => (k === key ? null : key)) });
  const month = currentMonth();

  // Figures worked out from the data, used wherever the settings don't say otherwise
  const derived = useMemo(() => {
    const escrowOf = (loan) => {
      const latest = mortgages.payments.filter((p) => p.loanId === loan.id).sort((a, b) => (b.forMonth || '').localeCompare(a.forMonth || ''))[0];
      return latest?.escrow || 0;
    };
    const baseline = cashFlowBaseline(
      transactions,
      mortgages.loans.map((l) => ({ ...l, scheduled: (l.monthlyPI || 0) + escrowOf(l) })),
      month
    );
    const balances = Object.fromEntries(accounts.filter((a) => a.id.startsWith(LOAN_PREFIX)).map((a) => [a.id.slice(LOAN_PREFIX.length), a.balance]));
    const loans = projectionLoans(mortgages.loans, mortgages.payments, balances);
    const contributions = Object.fromEntries(
      accounts.filter((a) => !a.auto && a.paycheckContribution).map((a) => [a.id, monthlyPaycheckContribution(a, transactions, month, baseline.months)])
    );
    const monthlyCosts = baseline.spending + loans.reduce((s, l) => s + l.payment + l.escrow + l.extra, 0);
    return { baseline, loans, contributions, cashCushion: Math.round((6 * monthlyCosts) / 1000) * 1000 };
  }, [accounts, mortgages, transactions, month]);

  // A field's number: what's being typed, else the saved setting, else the fallback
  const numberFor = (key, fallback) => {
    if (key in draft) return parseNumber(draft[key]) ?? fallback;
    return Number.isFinite(settings[key]) ? settings[key] : fallback;
  };
  const extraKey = (loan) => `extra.${loan.id}`;
  const extraFor = (loan) => {
    const key = extraKey(loan);
    if (key in draft) return parseNumber(draft[key]) ?? loan.extra;
    return Number.isFinite(settings.extra?.[loan.id]) ? settings.extra[loan.id] : loan.extra;
  };

  const rateDraft = Object.fromEntries(RATE_FIELDS.filter((f) => f.key in draft).map((f) => [f.key, parseNumber(draft[f.key])]));
  const rates = resolveProjectionSettings({ ...settings, ...rateDraft });
  const takeHome = numberFor('takeHome', derived.baseline.takeHome);
  const spending = numberFor('spending', derived.baseline.spending);
  const cashCushion = numberFor('cashCushion', derived.cashCushion);
  const holdFlat = useMemo(() => new Set(settings.holdFlat || []), [settings.holdFlat]);
  const loans = derived.loans.map((l) => ({ ...l, extra: extraFor(l) }));

  const start = {
    month,
    accounts: accounts.filter((a) => !a.id.startsWith(LOAN_PREFIX)).map((a) => {
      const flat = holdFlat.has(a.id);
      return { id: a.id, kind: kindOf(a, flat), balance: a.balance, monthly: flat ? 0 : derived.contributions[a.id] || 0 };
    }),
    loans,
    takeHome,
    spending,
    cashCushion,
  };
  const expected = projectNetWorth(start, rates);
  const low = projectNetWorth(start, { ...rates, investReturn: rates.investReturn - RANGE_POINTS, homeGrowth: rates.homeGrowth - RANGE_POINTS / 2 });
  const high = projectNetWorth(start, { ...rates, investReturn: rates.investReturn + RANGE_POINTS, homeGrowth: rates.homeGrowth + RANGE_POINTS / 2 });

  // In today's dollars: each month's value with inflation taken back out
  const deflate = (value, m) => (todaysDollars ? value / (1 + rates.inflation / 100) ** (m / 12) : value);
  const valueAt = (run, m) => deflate(run.points[m].netWorth, m);

  // What a nudge to a field changes in the final figure (in today's dollars when those are shown)
  const endYear = expected.points[rates.years * 12].month.slice(0, 4);
  const baseEnd = valueAt(expected, rates.years * 12);
  const endValue = (s, r) => {
    const value = projectNetWorth(s, r).points[r.years * 12].netWorth;
    return todaysDollars ? value / (1 + r.inflation / 100) ** r.years : value;
  };
  const byEnd = (s, r) => `${signed(endValue(s, r) - baseEnd)} by ${endYear}`;
  const rateEffect = (key) => (key === 'years' ? null : `+${NUDGE.rate} point \u2192 ${byEnd(start, { ...rates, [key]: rates[key] + NUDGE.rate })}`);
  const startEffect = (changes, label) => `${label} \u2192 ${byEnd({ ...start, ...changes }, rates)}`;
  const perMonth = `+${formatCurrency(NUDGE.monthly).replace('.00', '')} a month`;
  const extraEffect = (loan) => {
    const nudged = { ...start, loans: start.loans.map((l) => (l.id === loan.id ? { ...l, extra: l.extra + NUDGE.monthly } : l)) };
    const before = expected.payoffs[loan.id];
    const after = projectNetWorth(nudged, rates).payoffs[loan.id];
    const sooner = before && after ? monthsFrom(after, before) : null;
    const payoff = sooner === null ? '' : sooner > 0 ? `paid off ${sooner} month${sooner !== 1 ? 's' : ''} sooner, ` : 'paid off the same month, ';
    return `${perMonth} \u2192 ${payoff}${byEnd(nudged, rates)}`;
  };

  const chartData = [];
  for (let m = 0; m <= rates.years * 12; m += 12) {
    const p = expected.points[m];
    chartData.push({ x: yearPosition(p.month), label: formatMonth(p.month), expected: valueAt(expected, m), range: [valueAt(low, m), valueAt(high, m)] });
  }
  const horizons = [...new Set([5, 10, rates.years].filter((y) => y <= rates.years))];
  const milestones = projectionMilestones(expected.points.map((pt, m) => ({ ...pt, netWorth: deflate(pt.netWorth, m) }))).slice(0, 4);
  const firstPayoff = loans.map((l) => expected.payoffs[l.id]).filter(Boolean).sort()[0];

  const setField = (key) => (text) => setDraft((d) => ({ ...d, [key]: text }));
  const commit = (key) => () => {
    if (!(key in draft)) return;
    const n = parseNumber(draft[key]);
    if (key.startsWith('extra.')) {
      const extra = { ...(settings.extra || {}) };
      const id = key.slice('extra.'.length);
      if (n === undefined) delete extra[id];
      else extra[id] = n;
      onSave({ extra: Object.keys(extra).length ? extra : undefined });
    } else {
      onSave({ [key]: n });
    }
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  };
  const shown = (key, value, digits = 0) => (key in draft ? draft[key] : String(Math.round(value * 10 ** digits) / 10 ** digits));

  const toggleFlat = (id) => {
    const next = new Set(holdFlat);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSave({ holdFlat: next.size ? [...next] : undefined });
  };

  const resetAll = () => {
    setDraft({});
    onSave({ years: undefined, investReturn: undefined, cashReturn: undefined, homeGrowth: undefined, raise: undefined, inflation: undefined, takeHome: undefined, spending: undefined, cashCushion: undefined, extra: undefined });
  };

  // Assets that would change: a balance to grow, or contributions coming in (and any already held)
  const flatCandidates = accounts.filter((a) => a.type === 'asset' && !a.auto && (a.balance !== 0 || derived.contributions[a.id] || holdFlat.has(a.id)));
  const rangeNote = (m) => `${formatCompactCurrency(valueAt(low, m))} – ${formatCompactCurrency(valueAt(high, m))}`;

  return (
    <div className="card">
      <div className="amort-header">
        <h3>Projection</h3>
        <label className="toggle-label">
          <input type="checkbox" checked={todaysDollars} onChange={(e) => setTodaysDollars(e.target.checked)} />
          In today&apos;s dollars
        </label>
      </div>
      <p className="muted settings-help">
        Starts from today&apos;s balances. Each month, take-home pay minus spending and mortgage payments is saved: into cash until the
        cushion is reached, then invested. Paycheck contributions continue and rise with raises, and a paid-off mortgage&apos;s payment is
        saved too. Other debts stay as they are. The shaded range is investment returns {RANGE_POINTS} points lower or higher (home values{' '}
        {RANGE_POINTS / 2}). The <span className="info-toggle-inline">i</span> next to an assumption explains it and shows what a small change to it would do to the final figure.
      </p>

      <div className="summary-grid">
        {horizons.map((y) => (
          <SummaryCard key={y} label={`In ${y} year${y !== 1 ? 's' : ''}`} value={formatCompactCurrency(valueAt(expected, y * 12))} note={rangeNote(y * 12)} accent={y === rates.years} />
        ))}
        {loans.length > 0 && (
          <SummaryCard
            label={loans.length > 1 ? 'First mortgage paid off' : 'Mortgage paid off'}
            value={firstPayoff ? shortMonth(firstPayoff) : 'Not yet'}
            note={firstPayoff ? null : `Still owed after ${rates.years} years`}
          />
        )}
      </div>

      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} tickFormatter={(x) => String(Math.floor(x))} stroke="#6b7280" tick={{ fontSize: 12 }} />
          <YAxis tickFormatter={formatCompactCurrency} stroke="#6b7280" width={Y_AXIS_WIDTH} />
          <Tooltip
            labelFormatter={(_, payload) => payload?.[0]?.payload.label}
            formatter={(value, name) => (name === 'range'
              ? [`${formatCompactCurrency(value[0])} – ${formatCompactCurrency(value[1])}`, 'Range']
              : [formatCurrency(Math.round(value)), 'Expected'])}
            itemSorter={(item) => (item.name === 'expected' ? 0 : 1)}
            {...chartTooltipProps(CHART_MARGIN.left + Y_AXIS_WIDTH)}
          />
          <Area type="monotone" dataKey="range" name="range" stroke="none" fill="#C97CE8" fillOpacity={0.18} isAnimationActive={false} />
          <Line type="monotone" dataKey="expected" name="expected" stroke="#E8E4DD" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
          {loans.filter((l) => expected.payoffs[l.id]).map((l) => (
            <ReferenceLine
              key={l.id}
              x={yearPosition(expected.payoffs[l.id])}
              stroke="#7CB5E8"
              strokeDasharray="4 4"
              label={{ value: loans.length > 1 ? `${l.name} paid off` : 'Mortgage paid off', fill: '#7CB5E8', fontSize: 11, position: 'insideTopLeft' }}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      {milestones.length > 0 && (
        <p className="muted projection-milestones">
          {milestones.map((m) => `${formatCompactCurrency(m.amount)} by ${shortMonth(m.month)}`).join(' · ')}
        </p>
      )}

      <h4 className="projection-heading">Assumptions</h4>
      <div className="projection-settings">
        {RATE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} step={f.step} value={shown(f.key, rates[f.key], 1)} help={f.help} effect={f.key === 'years' ? null : () => rateEffect(f.key)} {...helpFor(f.key)} onChange={setField(f.key)} onCommit={commit(f.key)} />
        ))}
        <Field
          label="Take-home pay a month"
          step={10}
          value={shown('takeHome', takeHome)}
          help={HELP.takeHome}
          hint={`Last 12 months: ${formatCurrency(Math.round(derived.baseline.takeHome))} (all money in, including refunds)`}
          effect={() => startEffect({ takeHome: takeHome + NUDGE.monthly }, perMonth)}
          {...helpFor('takeHome')}
          onChange={setField('takeHome')}
          onCommit={commit('takeHome')}
        />
        <Field
          label="Spending a month, outside the mortgage"
          step={10}
          value={shown('spending', spending)}
          help={HELP.spending}
          hint={`Last 12 months: ${formatCurrency(Math.round(derived.baseline.spending))}`}
          effect={() => startEffect({ spending: spending + NUDGE.monthly }, perMonth)}
          {...helpFor('spending')}
          onChange={setField('spending')}
          onCommit={commit('spending')}
        />
        {loans.map((l) => (
          <Field
            key={l.id}
            label={`Extra principal a month${loans.length > 1 ? ` (${l.name})` : ''}`}
            step={10}
            value={shown(extraKey(l), l.extra)}
            help={HELP.extra}
            hint={`Latest 6 statements: ${formatCurrency(Math.round(derived.loans.find((d) => d.id === l.id).extra))} on average`}
            effect={() => extraEffect(l)}
            {...helpFor(extraKey(l))}
            onChange={setField(extraKey(l))}
            onCommit={commit(extraKey(l))}
          />
        ))}
        <Field
          label="Cash cushion before investing"
          step={1000}
          value={shown('cashCushion', cashCushion)}
          help={HELP.cashCushion}
          hint={`6 months of costs: ${formatCurrency(derived.cashCushion)}`}
          effect={() => startEffect({ cashCushion: cashCushion + NUDGE.cushion }, `+${formatCurrency(NUDGE.cushion).replace('.00', '')}`)}
          {...helpFor('cashCushion')}
          onChange={setField('cashCushion')}
          onCommit={commit('cashCushion')}
        />
      </div>
      {derived.baseline.estimatedMortgage && (
        <p className="warn-text settings-help">
          A mortgage has no payment keywords, so its scheduled payment was taken out of spending. Add them to the loan on the Mortgage page
          to use the payments actually made.
        </p>
      )}
      {flatCandidates.length > 0 && (
        <div className="projection-flat">
          <span className="muted">Hold as they are:</span>
          <HelpToggle about="holding an account" open={helpOpen === 'holdFlat'} onClick={helpFor('holdFlat').onToggleHelp} />
          {flatCandidates.map((a) => (
            <label key={a.id} className="toggle-label">
              <input type="checkbox" checked={holdFlat.has(a.id)} onChange={() => toggleFlat(a.id)} />
              {a.name}
            </label>
          ))}
          {helpOpen === 'holdFlat' && <div className="projection-explain">{HELP.holdFlat}</div>}
        </div>
      )}
      <div className="data-actions mt-12">
        <button className="btn-secondary" onClick={resetAll}>Reset Assumptions</button>
        <span className="muted inline-status">Retirement accounts count at full value, before the tax due on withdrawals.</span>
      </div>
    </div>
  );
}
