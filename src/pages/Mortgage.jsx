import { useState, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { formatCurrency } from '../constants/categories';
import { generateAmortization, buildActualTimeline, extrapolateFromBalance } from '../utils/mortgageCalculations';
import Modal from '../components/Modal';
import FileDropZone from '../components/FileDropZone';
import EmptyState from '../components/EmptyState';
import ConfirmButton from '../components/ConfirmButton';
import { addMonths, todayISO } from '../utils/dates';
import { parseKeywordList } from '../utils/categorizer';

// ─── Loan Summary Card ───
function LoanSummary({ loan, onEdit }) {
  const fields = [
    ['Loan Amount', formatCurrency(loan.loanAmount)],
    ['Interest Rate', `${loan.interestRate}%`],
    ['Term', `${loan.termYears} years`],
    ['Monthly P&I', formatCurrency(loan.monthlyPI)],
    ['Closing Date', loan.closingDate],
    ['Maturity Date', loan.maturityDate],
    ['Loan Type', loan.loanType],
    ['Servicer', loan.servicer],
    loan.closingCosts > 0 && ['Closing Costs', formatCurrency(loan.closingCosts)],
    loan.cashToClose > 0 && ['Cash to Close', formatCurrency(loan.cashToClose)],
    loan.payoffDate && ['Payoff Date', loan.payoffDate],
    loan.payoffBalance && ['Payoff Balance', formatCurrency(loan.payoffBalance)],
  ].filter(Boolean);

  return (
    <div className="card mortgage-summary">
      <div className="amort-header">
        <h3>{loan.label}</h3>
        {loan.status === 'active' && <span className="badge-active">Active</span>}
        {onEdit && <button className="btn-icon" onClick={() => onEdit(loan)}>Edit</button>}
      </div>
      <div className="mortgage-grid">
        {fields.map(([label, value]) => (
          <div key={label}><span className="label">{label}</span><span className="value">{value}</span></div>
        ))}
      </div>
    </div>
  );
}

// ─── Balance Chart ───
function BalanceChart({ title, projected, actual, extrapolated, refiDate }) {
  const data = useMemo(() => {
    const map = {};
    projected.forEach((p) => { map[p.date] = { date: p.date, projected: p.balance }; });
    actual.forEach((a) => { map[a.date] = { ...map[a.date], date: a.date, actual: a.balance }; });
    if (extrapolated) {
      extrapolated.forEach((e) => { map[e.date] = { ...map[e.date], date: e.date, extrapolated: e.balance }; });
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }, [projected, actual, extrapolated]);

  const LABELS = { projected: 'Projected (Original Min)', actual: 'Actual Balance', extrapolated: 'New Trajectory (Min)' };

  return (
    <div className="card">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={350}>
        <LineChart data={data} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
          <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
          <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={100} />
          {refiDate && <ReferenceLine x={refiDate} stroke="#C97CE8" strokeDasharray="4 4" label={{ value: 'Refi', fill: '#C97CE8', fontSize: 12 }} />}
          <Tooltip
            formatter={(value, name) => [formatCurrency(value), LABELS[name] || name]}
            contentStyle={{ backgroundColor: '#222228', border: '1px solid #333', borderRadius: 8 }}
            labelStyle={{ color: '#E8E4DD' }}
          />
          <Line type="monotone" dataKey="projected" name="projected" stroke="#6b7280" strokeWidth={2} strokeDasharray="6 3" dot={false} />
          <Line type="monotone" dataKey="actual" name="actual" stroke="#7CE8A3" strokeWidth={2.5} dot={{ r: 3 }} />
          {extrapolated && <Line type="monotone" dataKey="extrapolated" name="extrapolated" stroke="#E8927C" strokeWidth={2} strokeDasharray="4 2" dot={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Amortization Table ───
function AmortizationTable({ title, schedule, actualPayments, isActive }) {
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const actualMap = {};
    actualPayments.forEach((p) => { actualMap[p.forMonth] = p; });
    return schedule.map((row) => {
      const actual = actualMap[row.date];
      return {
        ...row,
        actualPrincipal: actual ? actual.principal + actual.extraPrincipal : null,
        actualInterest: actual ? actual.interest : null,
        actualBalance: actual ? actual.balanceAfter : null,
        hasActual: !!actual,
      };
    });
  }, [schedule, actualPayments]);

  const displayRows = showAll ? rows : rows.slice(0, 24);

  return (
    <div className="card">
      <div className="amort-header">
        <h3>{title}</h3>
        {isActive && <span className="badge-active">Active</span>}
      </div>
      <div className="amort-table-wrap">
        <table className="amort-table">
          <thead>
            <tr><th>#</th><th>Date</th><th>Proj P</th><th>Proj I</th><th>Proj Bal</th><th>Actual P</th><th>Actual I</th><th>Actual Bal</th></tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={row.paymentNumber} className={row.hasActual ? 'has-actual' : ''}>
                <td>{row.paymentNumber}</td>
                <td>{row.date}</td>
                <td>{formatCurrency(row.principal)}</td>
                <td>{formatCurrency(row.interest)}</td>
                <td>{formatCurrency(row.balance)}</td>
                <td>{row.actualPrincipal !== null ? formatCurrency(row.actualPrincipal) : '-'}</td>
                <td>{row.actualInterest !== null ? formatCurrency(row.actualInterest) : '-'}</td>
                <td>{row.actualBalance !== null ? formatCurrency(row.actualBalance) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 24 && (
        <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show Less' : `Show All ${rows.length} Payments`}
        </button>
      )}
    </div>
  );
}

// ─── Combined Amortization Table ───
function CombinedAmortTable({ rows }) {
  const [showAll, setShowAll] = useState(false);
  const displayRows = showAll ? rows : rows.slice(0, 36);

  return (
    <div className="card">
      <h3>Combined Amortization</h3>
      <div className="amort-table-wrap">
        <table className="amort-table">
          <thead>
            <tr><th>#</th><th>Date</th><th>Loan</th><th>Proj P</th><th>Proj I</th><th>Proj Bal</th><th>Actual P</th><th>Actual I</th><th>Actual Bal</th></tr>
          </thead>
          <tbody>
            {displayRows.map((row) => (
              <tr key={`${row.date}-${row.loanLabel}`} className={row.hasActual ? 'has-actual' : ''}>
                <td>{row.paymentNumber}</td>
                <td>{row.date}</td>
                <td className="desc-cell">{row.loanLabel}</td>
                <td>{formatCurrency(row.principal)}</td>
                <td>{formatCurrency(row.interest)}</td>
                <td>{formatCurrency(row.balance)}</td>
                <td>{row.actualPrincipal !== null ? formatCurrency(row.actualPrincipal) : '-'}</td>
                <td>{row.actualInterest !== null ? formatCurrency(row.actualInterest) : '-'}</td>
                <td>{row.actualBalance !== null ? formatCurrency(row.actualBalance) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 36 && (
        <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show Less' : `Show All ${rows.length} Payments`}
        </button>
      )}
    </div>
  );
}

// ─── Loan Form ───
const EMPTY_LOAN = {
  label: '', lender: '', servicer: '', servicerType: '', loanNumber: '',
  loanAmount: '', interestRate: '', termYears: '', monthlyPI: '',
  startDate: '', maturityDate: '', closingDate: '', loanType: 'Conventional, Fixed Rate',
  closingCosts: '', cashToClose: '', lenderCredits: '', status: 'active',
  payoffDate: '', payoffBalance: '', propertyId: '',
};

function LoanForm({ loan, onSave, onDelete, properties }) {
  const [form, setForm] = useState(loan || EMPTY_LOAN);
  const [keywords, setKeywords] = useState((loan?.paymentKeywords || []).join(', '));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const handleSave = () => {
    onSave({
      ...form,
      paymentKeywords: parseKeywordList(keywords),
      loanAmount: parseFloat(form.loanAmount) || 0,
      interestRate: parseFloat(form.interestRate) || 0,
      termYears: parseInt(form.termYears) || 0,
      monthlyPI: parseFloat(form.monthlyPI) || 0,
      closingCosts: parseFloat(form.closingCosts) || 0,
      cashToClose: parseFloat(form.cashToClose) || 0,
      lenderCredits: parseFloat(form.lenderCredits) || 0,
      payoffBalance: form.payoffBalance ? parseFloat(form.payoffBalance) : null,
      payoffDate: form.payoffDate || null,
    });
  };

  return (
    <>
      {properties.length > 0 && (
        <div className="form-group">
          <label>Property</label>
          <select value={form.propertyId} onChange={set('propertyId')}>
            <option value="">Select...</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
          </select>
        </div>
      )}
      <div className="form-group"><label>Label</label><input value={form.label} onChange={set('label')} placeholder="e.g. Original Mortgage" /></div>
      <div className="form-group"><label>Lender</label><input value={form.lender} onChange={set('lender')} /></div>
      <div className="form-group"><label>Servicer</label><input value={form.servicer} onChange={set('servicer')} /></div>
      <div className="form-group">
        <label>Servicer Type (for PDF parsing)</label>
        <select value={form.servicerType} onChange={set('servicerType')}>
          <option value="">None</option>
          <option value="lakeview">Lakeview / LoanCare</option>
          <option value="rocket">Rocket Mortgage</option>
        </select>
      </div>
      <div className="form-group">
        <label>Follow payments matching (keywords, comma-separated)</label>
        <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. my servicer" />
        <p className="muted settings-help">
          Net Worth lowers the balance with each matching payment from your accounts after the latest statement, estimating
          the interest at the loan&apos;s rate, until a newer statement replaces the estimate.
        </p>
      </div>
      <div className="form-group"><label>Loan Number</label><input value={form.loanNumber} onChange={set('loanNumber')} /></div>
      <div className="form-group"><label>Loan Amount</label><input type="number" value={form.loanAmount} onChange={set('loanAmount')} /></div>
      <div className="form-group"><label>Interest Rate (%)</label><input type="number" step="0.001" value={form.interestRate} onChange={set('interestRate')} /></div>
      <div className="form-group"><label>Term (years)</label><input type="number" value={form.termYears} onChange={set('termYears')} /></div>
      <div className="form-group"><label>Monthly P&I</label><input type="number" step="0.01" value={form.monthlyPI} onChange={set('monthlyPI')} /></div>
      <div className="form-group"><label>Start Date</label><input type="date" value={form.startDate} onChange={set('startDate')} /></div>
      <div className="form-group"><label>Maturity Date</label><input type="date" value={form.maturityDate} onChange={set('maturityDate')} /></div>
      <div className="form-group"><label>Closing Date</label><input type="date" value={form.closingDate} onChange={set('closingDate')} /></div>
      <div className="form-group"><label>Loan Type</label><input value={form.loanType} onChange={set('loanType')} /></div>
      <div className="form-group"><label>Closing Costs</label><input type="number" step="0.01" value={form.closingCosts} onChange={set('closingCosts')} /></div>
      <div className="form-group"><label>Cash to Close</label><input type="number" step="0.01" value={form.cashToClose} onChange={set('cashToClose')} /></div>
      <div className="form-group">
        <label>Status</label>
        <select value={form.status} onChange={set('status')}>
          <option value="active">Active</option>
          <option value="paid_off">Paid Off</option>
        </select>
      </div>
      {form.status === 'paid_off' && (
        <>
          <div className="form-group"><label>Payoff Date</label><input type="date" value={form.payoffDate || ''} onChange={set('payoffDate')} /></div>
          <div className="form-group"><label>Payoff Balance</label><input type="number" step="0.01" value={form.payoffBalance || ''} onChange={set('payoffBalance')} /></div>
        </>
      )}
      <div className="modal-actions">
        <button className="btn-primary" onClick={handleSave}>Save Loan</button>
        {onDelete && <ConfirmButton label="Delete Loan" confirmLabel="Delete loan and all its payments?" onConfirm={onDelete} />}
      </div>
    </>
  );
}

// ─── Payment Form ───
function PaymentForm({ loans, onSave }) {
  const [form, setForm] = useState({ loanId: loans[0]?.id || '', date: '', forMonth: '', principal: '', interest: '', escrow: '0', extraPrincipal: '0', balanceAfter: '' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const handleSave = () => {
    onSave({
      ...form,
      principal: parseFloat(form.principal) || 0,
      interest: parseFloat(form.interest) || 0,
      escrow: parseFloat(form.escrow) || 0,
      extraPrincipal: parseFloat(form.extraPrincipal) || 0,
      balanceAfter: parseFloat(form.balanceAfter) || 0,
      source: 'manual',
    });
  };

  return (
    <>
      <div className="form-group">
        <label>Loan</label>
        <select value={form.loanId} onChange={set('loanId')}>
          {loans.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
      </div>
      <div className="form-group"><label>Payment Date</label><input type="date" value={form.date} onChange={set('date')} /></div>
      <div className="form-group"><label>For Month (YYYY-MM)</label><input value={form.forMonth} onChange={set('forMonth')} placeholder="2026-01" /></div>
      <div className="form-group"><label>Principal</label><input type="number" step="0.01" value={form.principal} onChange={set('principal')} /></div>
      <div className="form-group"><label>Interest</label><input type="number" step="0.01" value={form.interest} onChange={set('interest')} /></div>
      <div className="form-group"><label>Extra Principal</label><input type="number" step="0.01" value={form.extraPrincipal} onChange={set('extraPrincipal')} /></div>
      <div className="form-group"><label>Balance After</label><input type="number" step="0.01" value={form.balanceAfter} onChange={set('balanceAfter')} /></div>
      <button className="btn-primary" onClick={handleSave}>Save Payment</button>
    </>
  );
}

// ─── Property Form ───
function PropertyForm({ property, onSave, onDelete }) {
  const [form, setForm] = useState(property || { address: '', purchasePrice: '', purchaseDate: '', estimatedValue: '' });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const handleSave = () => {
    onSave({
      ...form,
      purchasePrice: parseFloat(form.purchasePrice) || 0,
      estimatedValue: parseFloat(form.estimatedValue) || 0,
    });
  };

  return (
    <>
      <div className="form-group"><label>Address</label><input value={form.address} onChange={set('address')} /></div>
      <div className="form-group"><label>Purchase Price</label><input type="number" value={form.purchasePrice} onChange={set('purchasePrice')} /></div>
      <div className="form-group"><label>Purchase Date</label><input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} /></div>
      <div className="form-group"><label>Estimated Value</label><input type="number" value={form.estimatedValue} onChange={set('estimatedValue')} /></div>
      <div className="form-group"><label>Estimate Date (net worth uses the purchase price until then)</label><input type="date" value={form.estimatedValueDate || ''} onChange={set('estimatedValueDate')} /></div>
      <div className="modal-actions">
        <button className="btn-primary" onClick={handleSave}>Save Property</button>
        {onDelete && <ConfirmButton label="Delete Property" confirmLabel="Click again to delete property" onConfirm={onDelete} />}
      </div>
    </>
  );
}

// ─── Main Mortgage Page ───
export default function Mortgage({ data, finance }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [modal, setModal] = useState(null); // { type: 'loan'|'payment'|'property', editing?: obj }
  const [pdfResults, setPdfResults] = useState([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const jsonRef = useRef(null);

  const mortgages = data.mortgages;
  const { properties, loans, payments } = mortgages;
  const activeLoan = loans.find((l) => l.status === 'active');

  const currentBalance = useMemo(() => {
    if (!activeLoan) return 0;
    const loanPayments = payments.filter((p) => p.loanId === activeLoan.id);
    if (loanPayments.length === 0) return activeLoan.loanAmount;
    const sorted = [...loanPayments].sort((a, b) => b.forMonth.localeCompare(a.forMonth));
    return sorted[0].balanceAfter;
  }, [activeLoan, payments]);

  const equity = useMemo(() => {
    const prop = properties[0];
    if (!prop) return 0;
    return (prop.estimatedValue || prop.purchasePrice) - currentBalance;
  }, [properties, currentBalance]);

  const ltv = useMemo(() => {
    const prop = properties[0];
    if (!prop || !currentBalance) return 0;
    const value = prop.estimatedValue || prop.purchasePrice;
    return value > 0 ? Math.round((currentBalance / value) * 10000) / 100 : 0;
  }, [properties, currentBalance]);

  // Build schedules and timelines per loan
  const loanData = useMemo(() => {
    const result = {};
    for (const loan of loans) {
      const schedule = generateAmortization(loan.loanAmount, loan.interestRate, loan.termYears, loan.startDate);
      const loanPayments = payments.filter((p) => p.loanId === loan.id);
      const startMonth = loan.startDate.slice(0, 7);
      const projectedTimeline = [{ date: startMonth, balance: loan.loanAmount }, ...schedule.map((s) => ({ date: s.date, balance: s.balance }))];
      const actualTimeline = buildActualTimeline(loanPayments, loan.loanAmount, startMonth);

      // Extrapolate from last actual balance forward using minimum payments
      let extrapolatedTimeline = null;
      if (loanPayments.length > 0 && loan.status === 'active') {
        const sorted = [...loanPayments].sort((a, b) => b.forMonth.localeCompare(a.forMonth));
        const lastBalance = sorted[0].balanceAfter;
        const lastMonth = sorted[0].forMonth;
        // Start extrapolation from the month after the last actual payment
        const ext = extrapolateFromBalance(lastBalance, loan.interestRate, loan.monthlyPI, addMonths(lastMonth, 1));
        // Prepend the last actual point so the line connects
        extrapolatedTimeline = [{ date: lastMonth, balance: lastBalance }, ...ext];
      }

      result[loan.id] = { schedule, loanPayments, projectedTimeline, actualTimeline, extrapolatedTimeline };
    }
    return result;
  }, [loans, payments]);

  // Combined timeline
  const combinedData = useMemo(() => {
    const map = {};
    for (const loan of loans) {
      const ld = loanData[loan.id];
      if (!ld) continue;
      const startMonth = loan.startDate.slice(0, 7);
      map[startMonth] = { ...map[startMonth], date: startMonth, projected: loan.loanAmount };
      if (loan.status === 'paid_off') {
        ld.schedule.forEach((s) => {
          if (!loan.payoffDate || s.date < loan.payoffDate.slice(0, 7)) {
            map[s.date] = { ...map[s.date], date: s.date, projected: s.balance };
          }
        });
      } else {
        ld.schedule.forEach((s) => { map[s.date] = { ...map[s.date], date: s.date, projected: s.balance }; });
      }
      ld.actualTimeline.forEach((a) => { map[a.date] = { ...map[a.date], date: a.date, actual: a.balance }; });
      if (ld.extrapolatedTimeline) {
        ld.extrapolatedTimeline.forEach((e) => { map[e.date] = { ...map[e.date], date: e.date, extrapolated: e.balance }; });
      }
    }
    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }, [loans, loanData]);

  const refiDate = useMemo(() => {
    const refi = loans.find((l) => l.refinancesLoanId);
    return refi ? refi.startDate.slice(0, 7) : null;
  }, [loans]);

  // Payment statistics
  const paymentStats = useMemo(() => {
    if (loans.length === 0) return null;

    let totalPrincipalPaid = 0;
    let totalInterestPaid = 0;
    let totalExtraPaid = 0;
    let originalProjectedInterest = 0;
    let newProjectedInterest = 0;
    let originalPayoffMonths = 0;
    let newPayoffMonths = 0;

    for (const loan of loans) {
      const ld = loanData[loan.id];
      if (!ld) continue;

      // Actual payments
      for (const p of ld.loanPayments) {
        totalPrincipalPaid += p.principal;
        totalInterestPaid += p.interest;
        totalExtraPaid += p.extraPrincipal || 0;
      }

      // Original projected total interest (full schedule)
      const scheduleInterest = ld.schedule.reduce((s, r) => s + r.interest, 0);

      if (loan.status === 'paid_off') {
        // For paid-off loans, actual interest paid up to payoff
        // Projected interest is only the months before payoff
        const payoffMonth = loan.payoffDate ? loan.payoffDate.slice(0, 7) : null;
        const projInterestBeforePayoff = payoffMonth
          ? ld.schedule.filter((r) => r.date < payoffMonth).reduce((s, r) => s + r.interest, 0)
          : scheduleInterest;
        originalProjectedInterest += projInterestBeforePayoff;
        newProjectedInterest += ld.loanPayments.reduce((s, p) => s + p.interest, 0);
        originalPayoffMonths += payoffMonth
          ? ld.schedule.filter((r) => r.date < payoffMonth).length
          : ld.schedule.length;
        newPayoffMonths += ld.loanPayments.length;
      } else {
        // Active loan: full schedule interest + extrapolated remaining interest
        originalProjectedInterest += scheduleInterest;
        originalPayoffMonths += ld.schedule.length;

        // New projected = actual interest paid so far + remaining interest from extrapolation
        const actualInterestSoFar = ld.loanPayments.reduce((s, p) => s + p.interest, 0);
        let remainingInterest = 0;
        let remainingMonths = 0;
        if (ld.extrapolatedTimeline && ld.extrapolatedTimeline.length > 1) {
          // Recompute extrapolation with interest tracking
          const monthlyRate = loan.interestRate / 100 / 12;
          let bal = ld.extrapolatedTimeline[0].balance;
          for (let i = 0; bal > 0 && i < 360; i++) {
            const int = Math.round(bal * monthlyRate * 100) / 100;
            const prin = Math.min(Math.round((loan.monthlyPI - int) * 100) / 100, bal);
            remainingInterest += int;
            bal = Math.round((bal - prin) * 100) / 100;
            remainingMonths++;
            if (bal <= 0) break;
          }
        }
        newProjectedInterest += actualInterestSoFar + remainingInterest;
        newPayoffMonths += ld.loanPayments.length + remainingMonths;
      }
    }

    const interestSaved = Math.round((originalProjectedInterest - newProjectedInterest) * 100) / 100;
    const monthsSaved = originalPayoffMonths - newPayoffMonths;
    const yearsSaved = Math.floor(Math.abs(monthsSaved) / 12);
    const remMonths = Math.abs(monthsSaved) % 12;

    return {
      totalPrincipalPaid: Math.round(totalPrincipalPaid * 100) / 100,
      totalInterestPaid: Math.round(totalInterestPaid * 100) / 100,
      totalExtraPaid: Math.round(totalExtraPaid * 100) / 100,
      originalProjectedInterest: Math.round(originalProjectedInterest * 100) / 100,
      newProjectedInterest: Math.round(newProjectedInterest * 100) / 100,
      interestSaved,
      monthsSaved,
      timeSavedLabel: monthsSaved > 0
        ? `${yearsSaved > 0 ? `${yearsSaved}y ` : ''}${remMonths}mo`
        : '-',
      timeToPayoff: (() => {
        // Remaining months from extrapolation of active loan
        const active = loans.find((l) => l.status === 'active');
        if (!active) return '-';
        const ld = loanData[active.id];
        if (!ld || !ld.extrapolatedTimeline || ld.extrapolatedTimeline.length < 2) return '-';
        const remaining = ld.extrapolatedTimeline.length - 1; // subtract the connecting point
        const yrs = Math.floor(remaining / 12);
        const mos = remaining % 12;
        return `${yrs > 0 ? `${yrs}y ` : ''}${mos}mo`;
      })(),
    };
  }, [loans, loanData]);

  // Combined amortization: stitch projected schedules + overlay actual payments
  const combinedSchedule = useMemo(() => {
    if (loans.length === 0) return [];
    const rows = [];
    let paymentNum = 0;

    // Sort loans by start date
    const sortedLoans = [...loans].sort((a, b) => a.startDate.localeCompare(b.startDate));

    for (const loan of sortedLoans) {
      const ld = loanData[loan.id];
      if (!ld) continue;
      const actualMap = {};
      ld.loanPayments.forEach((p) => { actualMap[p.forMonth] = p; });

      for (const row of ld.schedule) {
        // For paid-off loans, stop at payoff month
        if (loan.status === 'paid_off' && loan.payoffDate && row.date >= loan.payoffDate.slice(0, 7)) break;

        paymentNum++;
        const actual = actualMap[row.date];
        rows.push({
          paymentNumber: paymentNum,
          date: row.date,
          loanLabel: loan.label.split('(')[0].trim(),
          principal: row.principal,
          interest: row.interest,
          balance: row.balance,
          actualPrincipal: actual ? actual.principal + actual.extraPrincipal : null,
          actualInterest: actual ? actual.interest : null,
          actualBalance: actual ? actual.balanceAfter : null,
          hasActual: !!actual,
        });
      }
    }
    return rows;
  }, [loans, loanData]);

  // ─── Handlers ───
  const handleSaveLoan = (loanForm) => {
    if (modal?.editing) {
      finance.updateLoan(modal.editing.id, loanForm);
    } else {
      finance.addLoan(loanForm);
    }
    setModal(null);
  };

  const handleSaveProperty = (propForm) => {
    if (modal?.editing) {
      finance.updateProperty(modal.editing.id, propForm);
    } else {
      finance.addProperty(propForm);
    }
    setModal(null);
  };

  const handleSavePayment = (payForm) => {
    finance.addMortgagePayment(payForm);
    setModal(null);
  };

  const handleImportJson = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const mortgageData = parsed.properties ? parsed : parsed.mortgages;
        if (mortgageData?.properties && mortgageData?.loans && mortgageData?.payments) {
          finance.importMortgageData(mortgageData);
        }
      } catch { /* ignore bad json */ }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExportJson = () => {
    const json = JSON.stringify({ version: 1, exportDate: todayISO(), ...mortgages }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'moneylens-mortgage.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePdfUpload = async (files) => {
    const { parseMortgagePdfs } = await import('../utils/mortgagePdfParser.js');
    const results = await parseMortgagePdfs(files, loans, payments);
    setPdfResults(results);
  };

  const handleImportPdfPayments = () => {
    const toImport = pdfResults.filter((r) => r.parsed && !r.isDuplicate && r.loanId);
    finance.importMortgagePayments(toImport.map((r) => ({
      loanId: r.loanId,
      date: r.payment.date,
      forMonth: r.payment.forMonth,
      principal: r.payment.principal,
      interest: r.payment.interest,
      escrow: r.payment.escrow || 0,
      extraPrincipal: r.payment.extraPrincipal || 0,
      balanceAfter: r.payment.balanceAfter,
      source: 'pdf_import',
      statementDate: r.payment.statementDate,
    })));
    setPdfResults([]);
  };

  const handleDeleteLoan = () => {
    finance.deleteLoan(modal.editing.id);
    if (activeTab === modal.editing.id) setActiveTab('overview');
    setModal(null);
  };

  const handleDeleteProperty = () => {
    finance.deleteProperty(modal.editing.id);
    setModal(null);
  };

  const loanLabels = Object.fromEntries(loans.map((l) => [l.id, l.label]));
  const sortedPayments = [...payments].sort((a, b) => b.forMonth.localeCompare(a.forMonth));

  const hasData = loans.length > 0;

  const TABS = [
    { id: 'overview', label: 'Overview' },
    ...loans.map((l) => ({ id: l.id, label: l.label.split('(')[0].trim() || l.label })),
    loans.length > 1 && { id: 'combined', label: 'Combined' },
    { id: 'data', label: 'Data' },
  ].filter(Boolean);

  return (
    <div className="page mortgage">
      <h2>Mortgage</h2>

      {hasData && (
        <div className="summary-grid">
          <div className="summary-card">
            <span className="summary-label">Current Balance</span>
            <span className="summary-value">{formatCurrency(currentBalance)}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Estimated Equity</span>
            <span className="summary-value">{formatCurrency(equity)}</span>
          </div>
          {activeLoan && (
            <>
              <div className="summary-card">
                <span className="summary-label">Interest Rate</span>
                <span className="summary-value">{activeLoan.interestRate}%</span>
              </div>
              <div className="summary-card">
                <span className="summary-label">Monthly Payment</span>
                <span className="summary-value">{formatCurrency(activeLoan.monthlyPI)}</span>
              </div>
            </>
          )}
          {ltv > 0 && (
            <div className="summary-card">
              <span className="summary-label">Loan-to-Value</span>
              <span className="summary-value">{ltv}%</span>
            </div>
          )}
          {paymentStats?.timeToPayoff && paymentStats.timeToPayoff !== '-' && (
            <div className="summary-card">
              <span className="summary-label">Time to Payoff</span>
              <span className="summary-value">{paymentStats.timeToPayoff}</span>
            </div>
          )}
        </div>
      )}

      <div className="view-toggle" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.id} className={`view-btn ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {!hasData && activeTab !== 'data' && (
        <EmptyState
          icon={'\u{1F3E0}'}
          message="No mortgage data yet."
          action={
            <div className="data-actions">
              <button className="btn-primary" onClick={() => jsonRef.current?.click()}>Import JSON</button>
              <input ref={jsonRef} type="file" accept=".json" onChange={handleImportJson} style={{ display: 'none' }} />
              <button className="btn-secondary" onClick={() => setActiveTab('data')}>Add Manually</button>
            </div>
          }
        />
      )}

      {activeTab === 'overview' && hasData && (
        <>
          {properties.map((p) => (
            <div key={p.id} className="card">
              <div className="amort-header">
                <h3>Property</h3>
                <button className="btn-icon" onClick={() => setModal({ type: 'property', editing: p })}>Edit</button>
              </div>
              <div className="mortgage-grid">
                <div><span className="label">Address</span><span className="value">{p.address}</span></div>
                <div><span className="label">Purchase Price</span><span className="value">{formatCurrency(p.purchasePrice)}</span></div>
                <div><span className="label">Estimated Value</span><span className="value">{formatCurrency(p.estimatedValue || p.purchasePrice)}</span></div>
                <div><span className="label">Purchase Date</span><span className="value">{p.purchaseDate}</span></div>
              </div>
            </div>
          ))}
          {paymentStats && payments.length > 0 && (
            <div className="card">
              <h3>Payment Summary</h3>
              <div className="mortgage-grid">
                <div><span className="label">Total Principal Paid</span><span className="value">{formatCurrency(paymentStats.totalPrincipalPaid)}</span></div>
                <div><span className="label">Total Interest Paid</span><span className="value">{formatCurrency(paymentStats.totalInterestPaid)}</span></div>
                <div><span className="label">Total Extra Payments</span><span className="value">{formatCurrency(paymentStats.totalExtraPaid)}</span></div>
              </div>
            </div>
          )}

          {paymentStats && payments.length > 0 && (
            <div className="card">
              <h3>Extra Payment Impact</h3>
              <div className="mortgage-grid">
                <div><span className="label">Original Projected Interest</span><span className="value">{formatCurrency(paymentStats.originalProjectedInterest)}</span></div>
                <div><span className="label">New Projected Interest</span><span className="value">{formatCurrency(paymentStats.newProjectedInterest)}</span></div>
                <div><span className="label">Projected Interest Saved</span><span className="value savings">{formatCurrency(paymentStats.interestSaved)}</span></div>
                <div><span className="label">Projected Time Saved</span><span className="value savings">{paymentStats.timeSavedLabel}</span></div>
              </div>
            </div>
          )}

          {loans.map((l) => <LoanSummary key={l.id} loan={l} onEdit={(loan) => setModal({ type: 'loan', editing: loan })} />)}
        </>
      )}

      {loans.map((loan) => {
        if (activeTab !== loan.id) return null;
        const ld = loanData[loan.id];
        if (!ld) return null;
        return (
          <div key={loan.id}>
            <BalanceChart
              title={`${loan.label} — Balance Over Time`}
              projected={ld.projectedTimeline}
              actual={ld.actualTimeline}
              extrapolated={ld.extrapolatedTimeline}
            />
            <AmortizationTable
              title={`${loan.label} Amortization`}
              schedule={ld.schedule}
              actualPayments={ld.loanPayments}
              isActive={loan.status === 'active'}
            />
          </div>
        );
      })}

      {activeTab === 'combined' && loans.length > 1 && (
        <div className="card">
          <h3>Combined Balance Over Time</h3>
          <p className="page-subtitle" style={{ marginBottom: 16 }}>All loans — projected vs actual</p>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={combinedData} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
              <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 11 }} angle={-45} textAnchor="end" height={60} />
              <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={100} />
              {refiDate && <ReferenceLine x={refiDate} stroke="#C97CE8" strokeDasharray="4 4" label={{ value: 'Refi', fill: '#C97CE8', fontSize: 12 }} />}
              <Tooltip
                formatter={(value, name) => {
                  const labels = { projected: 'Projected (Original Min)', actual: 'Actual Balance', extrapolated: 'New Trajectory (Min)' };
                  return [formatCurrency(value), labels[name] || name];
                }}
                contentStyle={{ backgroundColor: '#222228', border: '1px solid #333', borderRadius: 8 }}
                labelStyle={{ color: '#E8E4DD' }}
              />
              <Line type="monotone" dataKey="projected" name="projected" stroke="#6b7280" strokeWidth={2} strokeDasharray="6 3" dot={false} />
              <Line type="monotone" dataKey="actual" name="actual" stroke="#7CE8A3" strokeWidth={2.5} dot={{ r: 4 }} activeDot={{ r: 6 }} />
              <Line type="monotone" dataKey="extrapolated" name="extrapolated" stroke="#E8927C" strokeWidth={2} strokeDasharray="4 2" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {activeTab === 'combined' && combinedSchedule.length > 0 && (
        <CombinedAmortTable rows={combinedSchedule} />
      )}

      {activeTab === 'data' && (
        <>
          <div className="card">
            <h3>Upload Statement PDFs</h3>
            <p className="muted" style={{ marginBottom: 12 }}>Upload Lakeview or Rocket Mortgage monthly statements to extract payment data.</p>
            <FileDropZone onFiles={handlePdfUpload} multiple accept=".pdf" label="Drop statement PDFs here or" />
            {pdfResults.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h4>Extracted Payments</h4>
                <div className="amort-table-wrap">
                  <table className="amort-table">
                    <thead>
                      <tr><th>File</th><th>Servicer</th><th>Month</th><th>Principal</th><th>Interest</th><th>Extra</th><th>Balance</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      {pdfResults.map((r, i) => (
                        <tr key={i} className={r.isDuplicate ? 'row-duplicate' : r.parsed ? 'has-actual' : 'row-invalid'}>
                          <td>{r.fileName}</td>
                          <td>{r.servicer || '?'}</td>
                          <td>{r.payment?.forMonth || '-'}</td>
                          <td>{r.payment ? formatCurrency(r.payment.principal) : '-'}</td>
                          <td>{r.payment ? formatCurrency(r.payment.interest) : '-'}</td>
                          <td>{r.payment ? formatCurrency(r.payment.extraPrincipal || 0) : '-'}</td>
                          <td>{r.payment ? formatCurrency(r.payment.balanceAfter) : '-'}</td>
                          <td>
                            {r.isDuplicate && <span className="badge-warn">Duplicate</span>}
                            {!r.parsed && <span className="badge-error">Parse Error</span>}
                            {r.parsed && !r.isDuplicate && !r.loanId && <span className="badge-warn">No matching loan</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="modal-actions" style={{ marginTop: 12 }}>
                  <button className="btn-primary" onClick={handleImportPdfPayments}>
                    Import {pdfResults.filter((r) => r.parsed && !r.isDuplicate && r.loanId).length} Payments
                  </button>
                  <button className="btn-secondary" onClick={() => setPdfResults([])}>Clear</button>
                </div>
              </div>
            )}
          </div>

          {sortedPayments.length > 0 && (
            <div className="card">
              <h3>Payments ({sortedPayments.length})</h3>
              <div className="amort-table-wrap">
                <table className="amort-table">
                  <thead>
                    <tr><th>Month</th><th>Loan</th><th>Principal</th><th>Extra</th><th>Interest</th><th>Balance</th><th>Source</th><th></th></tr>
                  </thead>
                  <tbody>
                    {sortedPayments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.forMonth}</td>
                        <td className="desc-cell">{loanLabels[p.loanId] || '?'}</td>
                        <td>{formatCurrency(p.principal)}</td>
                        <td>{formatCurrency(p.extraPrincipal || 0)}</td>
                        <td>{formatCurrency(p.interest)}</td>
                        <td>{formatCurrency(p.balanceAfter)}</td>
                        <td>{p.source || '-'}</td>
                        <td><button className="btn-icon danger" onClick={() => finance.deleteMortgagePayment(p.id)}>Del</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <h3>Manual Entry</h3>
            <div className="data-actions">
              <button className="btn-secondary" onClick={() => setModal({ type: 'property' })}>+ Property</button>
              <button className="btn-secondary" onClick={() => setModal({ type: 'loan' })}>+ Loan</button>
              {loans.length > 0 && <button className="btn-secondary" onClick={() => setModal({ type: 'payment' })}>+ Payment</button>}
            </div>
          </div>

          <div className="card">
            <h3>JSON Import / Export</h3>
            <div className="data-actions">
              {hasData && <button className="btn-secondary" onClick={handleExportJson}>Export Mortgage JSON</button>}
              <button className="btn-secondary" onClick={() => jsonRef.current?.click()}>Import JSON</button>
              <input ref={jsonRef} type="file" accept=".json" onChange={handleImportJson} style={{ display: 'none' }} />
              {hasData && <button className="btn-danger" onClick={() => setShowClearConfirm(true)}>Clear All Mortgage Data</button>}
            </div>
            {showClearConfirm && (
              <div className="reset-confirm">
                <p>Are you sure? This will delete all properties, loans, and payments.</p>
                <button className="btn-danger" onClick={() => { finance.importMortgageData({ properties: [], loans: [], payments: [] }); setShowClearConfirm(false); }}>Yes, Clear Everything</button>
                <button className="btn-secondary" onClick={() => setShowClearConfirm(false)}>Cancel</button>
              </div>
            )}
          </div>
        </>
      )}

      <Modal isOpen={modal?.type === 'loan'} onClose={() => setModal(null)} title={modal?.editing ? 'Edit Loan' : 'Add Loan'}>
        <LoanForm loan={modal?.editing} onSave={handleSaveLoan} onDelete={modal?.editing ? handleDeleteLoan : null} properties={properties} />
      </Modal>
      <Modal isOpen={modal?.type === 'property'} onClose={() => setModal(null)} title={modal?.editing ? 'Edit Property' : 'Add Property'}>
        <PropertyForm property={modal?.editing} onSave={handleSaveProperty} onDelete={modal?.editing ? handleDeleteProperty : null} />
      </Modal>
      <Modal isOpen={modal?.type === 'payment'} onClose={() => setModal(null)} title="Add Payment">
        <PaymentForm loans={loans} onSave={handleSavePayment} />
      </Modal>
    </div>
  );
}
