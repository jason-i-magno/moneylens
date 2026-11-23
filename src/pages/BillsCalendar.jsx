import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import { CATEGORY_MAP, formatCurrency } from '../constants/categories';
import { addMonths, currentMonth, formatMonth, todayISO } from '../utils/dates';
import { billsForMonth, calendarWeeks, counts, monthTotals, offDayReason, otherPurchases, paychecksForMonth } from '../utils/billCalendar';
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
  // Other purchases on or off, kept in the address (?purchases=1) so it stays on from month to month
  const showPurchases = params.get('purchases') === '1';
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
  const purchases = useMemo(
    () => (showPurchases ? otherPurchases(transactions || [], month, today, bills) : []),
    [showPurchases, transactions, month, today, bills]
  );
  // On each day: paychecks, then bills, then other purchases
  const order = (e) => (e.income ? 0 : e.purchase ? 2 : 1);
  const entries = useMemo(
    () => [...paychecks, ...bills, ...purchases].sort((a, b) => a.date.localeCompare(b.date) || order(a) - order(b)),
    [paychecks, bills, purchases]
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

  const purchaseTotal = sumAmounts(purchases);
  const setView = (m, all) => setParams({ ...(m !== current && { month: m }), ...(all && { purchases: '1' }) });
  const go = (m) => {
    setSelected(null);
    setView(m, showPurchases);
  };

  return (
    <div className="page bills-calendar">
      <div className="page-header">
        <div>
          <h2>Bills Calendar</h2>
          <p className="page-subtitle">The days recurring charges and paychecks land on{showPurchases ? ', with everything else you bought' : ''}</p>
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
        {showPurchases ? (
          <SummaryCard
            label="Other Purchases"
            value={whole(purchaseTotal)}
            note={month > current ? 'none yet' : `${plural(purchases.length, 'purchase')}${month === current ? ' so far' : ''}`}
          />
        ) : (
          <SummaryCard
            label="Biggest Day"
            value={totals.biggestDay ? whole(totals.biggestDay.amount) : '-'}
            note={totals.biggestDay ? dayLabel(totals.biggestDay.date) : null}
          />
        )}
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
        <label className="cal-toggle">
          <input type="checkbox" checked={showPurchases} onChange={(e) => setView(month, e.target.checked)} />
          Show other purchases
        </label>
        <div className="cal-head" aria-hidden="true">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
        {calendarWeeks(month).map((week) => (
          <div key={week.find(Boolean)} className="cal-week">
            {week.map((date, i) => {
              if (!date) return <span key={`blank-${i}`} className="cal-day empty" />;
              const dayEntries = byDay.get(date) || [];
              const dayMain = dayEntries.filter((e) => !e.purchase);
              const dayBuys = dayEntries.filter((e) => e.purchase);
              const dayBills = dayMain.filter((e) => !e.income && counts(e));
              const dayPay = dayMain.filter((e) => e.income);
              const spent = sumAmounts(dayBills) + sumAmounts(dayBuys);
              const label = [
                dayPay.length && `paycheck ${whole(sumAmounts(dayPay))}`,
                dayBills.length && `${plural(dayBills.length, 'bill')}, ${whole(sumAmounts(dayBills))}`,
                dayBuys.length && `${plural(dayBuys.length, 'other purchase')}, ${whole(sumAmounts(dayBuys))}`,
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
                    {dayMain.slice(0, 3).map((e) => (
                      <span key={e.key} className={`cal-bill ${e.status} ${e.income ? 'cal-pay' : ''}`} style={{ borderLeftColor: colorOf(e) }}>
                        <span className="cal-name">{e.name}</span>
                        <span className="cal-amt">{e.income ? '+' : ''}{whole(e.amount)}</span>
                      </span>
                    ))}
                    {dayMain.length > 3 && <span className="cal-more">+{dayMain.length - 3} more</span>}
                    {dayBuys.length > 0 && (
                      <span className="cal-bill cal-buys">
                        <span className="cal-name">{plural(dayBuys.length, 'purchase')}</span>
                        <span className="cal-amt">{whole(sumAmounts(dayBuys))}</span>
                      </span>
                    )}
                  </span>
                  {dayEntries.length > 0 && (
                    <>
                      <span className="cal-dots">
                        {dayMain.map((e) => <span key={e.key} className={`cal-dot ${e.status}`} style={{ background: colorOf(e) }} />)}
                        {dayBuys.length > 0 && <span className="cal-dot cal-buys-dot" />}
                      </span>
                      {dayPay.length > 0 && <span className="cal-income">+{whole(sumAmounts(dayPay))}</span>}
                      {spent > 0 && <span className="cal-total">{whole(spent)}</span>}
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
          <h3>{day ? dayLabel(day) : `${showPurchases ? 'Everything' : paychecks.length ? 'Bills and Paychecks' : 'Bills'} in ${formatMonth(month)}`}</h3>
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
                  {!b.purchase && <span className={`chip ${statusOf(b).tone}`}>{statusOf(b).label}</span>}
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
          lately) on the schedule they follow, a day early when payday is a weekend or bank holiday; they aren&apos;t in the bill totals. Other
          purchases are everything else you spent (transfers, like card payments, left out).
        </p>
      </div>
    </div>
  );
}
