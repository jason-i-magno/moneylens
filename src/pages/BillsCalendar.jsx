import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import { CATEGORY_MAP, formatCurrency } from '../constants/categories';
import { addMonths, currentMonth, formatMonth, todayISO } from '../utils/dates';
import { billsForMonth, calendarWeeks, counts, monthTotals, offDayReason, paychecksForMonth } from '../utils/billCalendar';
import { sumAmounts } from '../utils/transactions';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Back over the months bills are found from, and a year ahead
const MONTHS_BACK = 3;
const MONTHS_AHEAD = 12;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS = {
  charged: { label: 'Charged', tone: 'good' },
  expected: { label: 'Expected', tone: 'info' },
  late: { label: 'Not charged yet', tone: 'warn' },
  due: { label: 'Was due', tone: 'muted' },
  paid: { label: 'Paid', tone: 'good' },
  unpaid: { label: 'Not paid yet', tone: 'warn' },
};
const PAY_STATUS = {
  received: { label: 'Received', tone: 'good' },
  expected: { label: 'Expected', tone: 'info' },
  late: { label: 'Not deposited yet', tone: 'warn' },
};
const statusOf = (entry) => (entry.income ? PAY_STATUS : STATUS)[entry.status];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const whole = (n) => formatCurrency(Math.round(n)).replace(/\.00$/, '');
const colorOf = (bill) => CATEGORY_MAP[bill.category]?.color || '#9CA3AF';
const amountText = (bill) => (bill.varies ? `about ${formatCurrency(bill.amount)}` : formatCurrency(bill.amount));
const shortDay = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const dayLabel = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function BillsCalendar({ data }) {
  const today = todayISO();
  const current = currentMonth();
  const first = addMonths(current, -MONTHS_BACK);
  const last = addMonths(current, MONTHS_AHEAD);
  const [params, setParams] = useSearchParams();
  const asked = params.get('month');
  const month = asked && MONTH.test(asked) && asked >= first && asked <= last ? asked : current;
  const months = useMemo(() => Array.from({ length: MONTHS_BACK + MONTHS_AHEAD + 1 }, (_, i) => addMonths(first, i)), [first]);
  const [selected, setSelected] = useState(null);

  const transactions = data.transactions;
  const subscriptions = data.subscriptions;
  const accounts = data.netWorth?.accounts;
  const mortgages = data.mortgages;
  const bills = useMemo(
    () => billsForMonth(transactions || [], subscriptions || [], month, today, accounts || [], mortgages),
    [transactions, subscriptions, month, today, accounts, mortgages]
  );
  const paychecks = useMemo(() => paychecksForMonth(transactions || [], month, today), [transactions, month, today]);
  // Paychecks first on their day, then the bills
  const entries = useMemo(
    () => [...paychecks, ...bills].sort((a, b) => a.date.localeCompare(b.date) || Number(Boolean(b.income)) - Number(Boolean(a.income))),
    [paychecks, bills]
  );
  const byDay = useMemo(() => {
    const map = new Map();
    for (const e of entries) map.set(e.date, [...(map.get(e.date) || []), e]);
    return map;
  }, [entries]);
  const totals = monthTotals(bills);
  const payTotal = sumAmounts(paychecks);
  const received = paychecks.filter((p) => p.status === 'received').length;
  const day = selected?.startsWith(month) ? selected : null;
  const dates = day ? [day] : [...byDay.keys()];

  const go = (m) => {
    setSelected(null);
    setParams(m === current ? {} : { month: m });
  };

  return (
    <div className="page bills-calendar">
      <div className="page-header">
        <div>
          <h2>Bills Calendar</h2>
          <p className="page-subtitle">The days recurring charges and paychecks land on</p>
        </div>
        <div className="page-header-actions">
          <button className="btn-secondary month-step" aria-label="Previous month" disabled={month <= first} onClick={() => go(addMonths(month, -1))}>‹</button>
          <select className="month-select" aria-label="Month" value={month} onChange={(e) => go(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}
          </select>
          <button className="btn-secondary month-step" aria-label="Next month" disabled={month >= last} onClick={() => go(addMonths(month, 1))}>›</button>
        </div>
      </div>

      <div className="summary-grid">
        <SummaryCard
          label="Bills This Month"
          value={whole(totals.total)}
          accent
          note={`${plural(bills.filter(counts).length, 'bill')}${month <= current && totals.charged > 0 ? `, ${whole(totals.charged)} charged${month === current ? ' so far' : ''}` : ''}`}
        />
        {month >= current && <SummaryCard label="Still to Come" value={whole(totals.toCome)} note={plural(totals.toComeCount, 'bill')} />}
        <SummaryCard
          label="Biggest Day"
          value={totals.biggestDay ? whole(totals.biggestDay.amount) : '-'}
          note={totals.biggestDay ? dayLabel(totals.biggestDay.date) : null}
        />
        {paychecks.length > 0 && (
          <SummaryCard
            label="Paychecks"
            value={whole(payTotal)}
            tone="good"
            note={`${plural(paychecks.length, 'payday')}${received && received < paychecks.length ? `, ${received} received` : ''} · `
              + `${whole(Math.abs(payTotal - totals.total))} ${payTotal >= totals.total ? 'more' : 'less'} than bills`}
          />
        )}
      </div>

      <div className="card">
        <div className="cal-head" aria-hidden="true">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
        {calendarWeeks(month).map((week) => (
          <div key={week.find(Boolean)} className="cal-week">
            {week.map((date, i) => {
              if (!date) return <span key={`blank-${i}`} className="cal-day empty" />;
              const dayEntries = byDay.get(date) || [];
              const dayBills = dayEntries.filter((e) => !e.income && counts(e));
              const dayPay = dayEntries.filter((e) => e.income);
              const label = [
                dayPay.length && `paycheck ${whole(sumAmounts(dayPay))}`,
                dayBills.length && `${plural(dayBills.length, 'bill')}, ${whole(sumAmounts(dayBills))}`,
              ].filter(Boolean).join('; ');
              const classes = ['cal-day', date === today && 'today', day === date && 'selected', dayEntries.length > 0 && 'has-bills'].filter(Boolean).join(' ');
              return (
                <button
                  key={date}
                  className={classes}
                  disabled={!dayEntries.length}
                  aria-label={label ? `${dayLabel(date)}: ${label}` : dayLabel(date)}
                  onClick={() => setSelected((s) => (s === date ? null : date))}
                >
                  <span className="cal-num">{Number(date.slice(8, 10))}</span>
                  <span className="cal-bills">
                    {dayEntries.slice(0, 3).map((e) => (
                      <span key={e.key} className={`cal-bill ${e.status} ${e.income ? 'cal-pay' : ''}`} style={{ borderLeftColor: colorOf(e) }}>
                        <span className="cal-name">{e.name}</span>
                        <span className="cal-amt">{e.income ? '+' : ''}{whole(e.amount)}</span>
                      </span>
                    ))}
                    {dayEntries.length > 3 && <span className="cal-more">+{dayEntries.length - 3} more</span>}
                  </span>
                  {dayEntries.length > 0 && (
                    <>
                      <span className="cal-dots">{dayEntries.map((e) => <span key={e.key} className={`cal-dot ${e.status}`} style={{ background: colorOf(e) }} />)}</span>
                      {dayPay.length > 0 && <span className="cal-income">+{whole(sumAmounts(dayPay))}</span>}
                      {dayBills.length > 0 && <span className="cal-total">{whole(sumAmounts(dayBills))}</span>}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="amort-header">
          <h3>{day ? dayLabel(day) : `${paychecks.length ? 'Bills and Paychecks' : 'Bills'} in ${formatMonth(month)}`}</h3>
          {day && <button className="btn-icon" onClick={() => setSelected(null)}>Show All</button>}
        </div>
        {entries.length === 0 ? (
          <p className="muted">No recurring bills found yet: a bill shows here once it has come on about the same day for three months in a row.</p>
        ) : dates.map((date) => (
          <div key={date} className="cal-group">
            {!day && <div className="cal-group-date">{dayLabel(date)}</div>}
            {(byDay.get(date) || []).map((b) => (
              <div key={b.key} className="item-row">
                <div className="item-main">
                  <div className="item-title"><span className="cal-dot" style={{ background: colorOf(b) }} />{b.name}</div>
                  <div className="item-meta">
                    {[
                      b.income ? b.payer : b.mortgage ? b.detail : CATEGORY_MAP[b.category]?.name,
                      b.manual && 'from Subscriptions',
                      b.movedFrom && `moved from ${shortDay(b.movedFrom)} (${offDayReason(b.movedFrom)})`,
                      b.paidOn && `paid ${shortDay(b.paidOn)}`,
                      b.forDue && `for the ${shortDay(b.forDue)} due date`,
                    ].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <div className="item-side">
                  <span className={`item-amount ${b.income ? 'income' : ''}`}>{b.income ? `${b.varies ? 'about ' : ''}+${formatCurrency(b.amount)}` : amountText(b)}</span>
                  <span className={`chip ${statusOf(b).tone}`}>{statusOf(b).label}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
        <p className="muted settings-help mt-12">
          Bills are charges from the same place on about the same day in each of the last three full months, plus the quarterly and yearly
          subscriptions on the Subscriptions page. One stops showing once a full month goes by without it. A bill due on a weekend or bank
          holiday moves the way it has before from the account it&apos;s paid from (bank accounts to the next business day if it never has). A
          mortgage shows on its due date, and each payment on the day you made it (matched by the loan&apos;s payment keywords); a due date
          you paid ahead isn&apos;t counted again. Paychecks come from your employer&apos;s deposits (Salary from whoever deposited most often
          lately) on the schedule they follow, a day early when payday is a weekend or bank holiday; they aren&apos;t in the bill totals.
        </p>
      </div>
    </div>
  );
}
