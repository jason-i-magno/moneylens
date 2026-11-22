import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import MonthSelect from '../components/MonthSelect';
import { CATEGORY_MAP, formatCurrency } from '../constants/categories';
import { addMonths, currentMonth, daysInMonth, formatMonth, getMonthOptions, todayISO } from '../utils/dates';
import { buildMonthlyReview, reviewFacts } from '../utils/review';
import { reviewRequest } from '../utils/reviewClient';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const shortDate = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatCurrency(Math.abs(n))}`;
// A difference from the usual worth pointing out: at least $50 and a quarter of the usual
const notable = (diff, usual) => Math.abs(diff) >= Math.max(50, 0.25 * (usual || 0));

function Category({ c }) {
  const cat = CATEGORY_MAP[c.id];
  const diff = c.average === null ? null : c.spent - c.average;
  const over = c.budget ? c.spent - c.budget : null;
  const usual = c.average === null ? 'no usual yet' : `usual ${formatCurrency(c.average)}`;
  return (
    <div className="item-row">
      <div className="item-main">
        <div className="item-title"><span className="item-icon">{cat?.icon}</span>{cat?.name || c.id}</div>
        <div className="item-meta">
          {usual}
          {over !== null && (over > 0
            ? <> · <span className="over">{formatCurrency(over)} over budget</span></>
            : ` · ${formatCurrency(-over)} of ${formatCurrency(c.budget)} budget left`)}
        </div>
      </div>
      <div className="item-side">
        <span className="item-amount">{formatCurrency(c.spent)}</span>
        {diff !== null && notable(diff, c.average) && <span className={`chip ${diff > 0 ? 'warn' : 'good'}`}>{signed(diff)} vs usual</span>}
      </div>
    </div>
  );
}

// Things worth a look: price increases, unusual charges, new recurring charges
function lookItems(review) {
  return [
    ...review.increases.map((i) => ({ key: `inc:${i.transactionId}`, chip: 'Price up', tone: 'warn', name: i.name, amount: i.to, detail: `was ${formatCurrency(i.from)} · ${shortDate(i.date)}` })),
    ...review.unusual.map((u) => ({
      key: `odd:${u.transactionId}`,
      chip: u.kind === 'new' ? 'New merchant' : 'Unusual',
      tone: 'info',
      name: u.name,
      amount: u.amount,
      detail: `${u.kind === 'new' ? 'first charge in a year' : `usually about ${formatCurrency(u.usual)}`} · ${shortDate(u.date)}`,
    })),
    ...review.newRecurring.map((r) => ({
      key: `new:${r.name}`,
      chip: r.subscription ? 'New subscription' : 'New recurring',
      tone: 'info',
      name: r.name,
      amount: r.amount,
      detail: r.subscription ? 'first charge in a year' : `monthly since ${formatMonth(r.since)}`,
    })),
  ];
}

export default function Review({ data }) {
  const today = todayISO();
  const lastMonth = addMonths(currentMonth(), -1);
  const [params, setParams] = useSearchParams();
  const asked = params.get('month');
  const month = asked && MONTH.test(asked) ? asked : lastMonth;
  const transactions = data.transactions;
  const months = useMemo(() => {
    const list = getMonthOptions(transactions || []);
    return list.includes(month) ? list : [...list, month].sort().reverse();
  }, [transactions, month]);

  const review = useMemo(() => buildMonthlyReview(data, month, today), [data, month, today]);
  const factsKey = useMemo(() => JSON.stringify(reviewFacts(review)), [review]);

  const [server, setServer] = useState({ state: 'checking' });
  const [summary, setSummary] = useState({ state: 'idle' });
  const [test, setTest] = useState({ state: 'idle' });

  useEffect(() => {
    reviewRequest('status').then(
      (status) => setServer({ state: 'ready', ...status }),
      (err) => setServer({ state: err.code === 'NO_SERVER' ? 'unavailable' : 'error', message: err.message })
    );
  }, []);

  // The month's written summary: the stored one, or for last month (once it's over), written the first time
  // it's opened. Older months and changed figures wait for the button, so nothing is paid for unasked.
  useEffect(() => {
    if (server.state !== 'ready' || !review.complete) return undefined;
    let cancelled = false;
    const facts = JSON.parse(factsKey);
    setSummary({ state: 'loading' });
    reviewRequest('get', { month, facts })
      .then(async (got) => {
        if (cancelled) return;
        if (got.summary || !server.writing || month !== lastMonth) {
          setSummary({ state: 'ready', ...got });
          return;
        }
        setSummary({ state: 'writing' });
        const written = await reviewRequest('write', { month, facts });
        if (!cancelled) setSummary({ state: 'ready', ...written });
      })
      .catch((err) => !cancelled && setSummary({ state: 'error', message: err.message }));
    return () => {
      cancelled = true;
    };
  }, [server.state, server.writing, month, lastMonth, factsKey, review.complete]);

  const write = async () => {
    setSummary((s) => ({ ...s, state: 'writing' }));
    try {
      setSummary({ state: 'ready', ...(await reviewRequest('write', { month, facts: JSON.parse(factsKey) })) });
    } catch (err) {
      setSummary({ state: 'error', message: err.message });
    }
  };

  const sendTest = async () => {
    setTest({ state: 'sending' });
    try {
      await reviewRequest('test-notify');
      setTest({ state: 'sent' });
    } catch (err) {
      setTest({ state: 'error', message: err.message });
    }
  };

  const kept = review.income - review.spending;
  const items = lookItems(review);
  const upcomingTotal = review.upcoming.reduce((s, b) => s + b.amount, 0);
  const { plan } = review;
  const day = Math.round(review.progress * daysInMonth(month));

  const summaryBody = () => {
    if (!review.complete) return <p className="muted">The summary is written once the month is over.</p>;
    if (server.state === 'checking' || summary.state === 'loading' || summary.state === 'idle') return <p className="muted">Loading…</p>;
    if (server.state !== 'ready') return <p className="muted">{server.message}</p>;
    if (summary.state === 'writing') return <p className="muted">Claude is writing the summary…</p>;
    if (summary.state === 'error') {
      return (
        <>
          <p className="error-text">{summary.message}</p>
          {server.writing && <button className="btn-secondary" onClick={write}>Try Again</button>}
        </>
      );
    }
    if (!summary.summary) {
      return server.writing
        ? <button className="btn-secondary" onClick={write}>Write Summary</button>
        : <p className="muted">{server.problem}</p>;
    }
    const s = summary.summary;
    return (
      <>
        <p className="review-headline">{s.headline}</p>
        <p className="review-summary-text">{s.summary}</p>
        {s.lookAt.length > 0 && <ul className="review-look-list">{s.lookAt.map((item) => <li key={item}>{item}</li>)}</ul>}
        <p className="review-written muted">
          Written by Claude on {shortDate(summary.writtenAt.slice(0, 10))} from the figures below.
          {!summary.current && ' The figures have changed since.'}
        </p>
        {!summary.current && server.writing && <button className="btn-secondary mt-12" onClick={write}>Rewrite</button>}
      </>
    );
  };

  return (
    <div className="page review">
      <div className="page-header">
        <div>
          <h2>Monthly Review</h2>
          <p className="page-subtitle">
            {formatMonth(month)}
            {!review.complete && (review.progress > 0 ? ` · in progress, day ${day} of ${daysInMonth(month)}` : ' · not started')}
          </p>
        </div>
        <div className="page-header-actions">
          <MonthSelect months={months} value={month} onChange={(m) => setParams(m === lastMonth ? {} : { month: m })} />
        </div>
      </div>

      <div className="card review-summary">
        {summaryBody()}
      </div>

      <div className="summary-grid">
        <SummaryCard
          label="Income"
          value={formatCurrency(review.income)}
          note={`${formatMonth(addMonths(month, -1)).split(' ')[0]}: ${formatCurrency(review.previous.income)}`}
        />
        <SummaryCard
          label="Spending"
          value={formatCurrency(review.spending)}
          note={review.averageSpending === null ? null : `usual ${formatCurrency(review.averageSpending)} a month`}
        />
        <SummaryCard label="Kept" value={formatCurrency(kept)} tone={kept < 0 ? 'bad' : 'good'} accent note="income minus spending" />
        {review.netWorth && (
          <SummaryCard
            label="Net Worth"
            value={review.netWorth.change === null ? formatCurrency(review.netWorth.end) : signed(review.netWorth.change)}
            tone={review.netWorth.change > 0 ? 'good' : review.netWorth.change < 0 ? 'bad' : undefined}
            note={review.netWorth.change === null ? 'at the end of the month' : `${formatCurrency(review.netWorth.end)} at the end of the month`}
          />
        )}
      </div>

      <div className="card">
        <h3>Worth a Look</h3>
        {items.length === 0 ? (
          <p className="muted">Nothing unusual: no price increases, unusual charges or new recurring charges.</p>
        ) : items.map((i) => (
          <div key={i.key} className="item-row">
            <div className="item-main">
              <div className="item-title"><span className={`chip ${i.tone}`}>{i.chip}</span>{i.name}</div>
              <div className="item-meta">{i.detail}</div>
            </div>
            <div className="item-side"><span className="item-amount">{formatCurrency(i.amount)}</span></div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Spending by Category</h3>
        {review.budgets && (
          <p className="muted settings-help">
            Budgets: {formatCurrency(review.budgets.spent)} of {formatCurrency(review.budgets.budgeted)}
            {review.budgets.left < 0 ? `, ${formatCurrency(-review.budgets.left)} over` : `, ${formatCurrency(review.budgets.left)} left`}.
            {review.averageMonths > 0 && ` Usual = the average of the ${review.averageMonths} months before.`}
          </p>
        )}
        {review.categories.length === 0 ? <p className="muted">No spending this month.</p> : review.categories.map((c) => <Category key={c.id} c={c} />)}
      </div>

      <div className="card">
        <h3>Against Your Projection</h3>
        <p className="muted settings-help">
          The month next to the monthly figures your net worth projection runs on
          {plan.planSet.takeHome && plan.planSet.spending ? ' (your settings)' : ' (your settings, else your average of the last 12 months)'}.
          The projection pays the mortgage separately.
        </p>
        <div className="item-row">
          <div className="item-main"><div className="item-title">Take-home</div><div className="item-meta">projection {formatCurrency(plan.planTakeHome)}</div></div>
          <div className="item-side">
            <span className="item-amount">{formatCurrency(plan.takeHome)}</span>
            {review.complete && <span className={`chip ${plan.takeHome >= plan.planTakeHome ? 'good' : 'warn'}`}>{signed(plan.takeHome - plan.planTakeHome)}</span>}
          </div>
        </div>
        <div className="item-row">
          <div className="item-main"><div className="item-title">Spending without the mortgage</div><div className="item-meta">projection {formatCurrency(plan.planSpending)}</div></div>
          <div className="item-side">
            <span className="item-amount">{formatCurrency(plan.spending)}</span>
            {review.complete && <span className={`chip ${plan.spending <= plan.planSpending ? 'good' : 'warn'}`}>{signed(plan.spending - plan.planSpending)}</span>}
          </div>
        </div>
        {plan.mortgage > 0 && (
          <div className="item-row">
            <div className="item-main"><div className="item-title">Mortgage payments</div><div className="item-meta">matched by the loans&apos; payment keywords</div></div>
            <div className="item-side"><span className="item-amount">{formatCurrency(plan.mortgage)}</span></div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Expected in {formatMonth(addMonths(month, 1))}</h3>
        {review.upcoming.length === 0 ? (
          <p className="muted">No regular bills found yet: a bill shows here after three months in a row.</p>
        ) : (
          <>
            <p className="muted settings-help">
              {formatCurrency(upcomingTotal)} in charges that came on about the same day for the last three months, and yearly or quarterly subscriptions due.
            </p>
            {review.upcoming.map((b) => (
              <div key={b.key} className="item-row">
                <div className="item-main">
                  <div className="item-title">{b.name}</div>
                  <div className="item-meta">{shortDate(b.date)}{b.manual ? ' · from Subscriptions' : ''}</div>
                </div>
                <div className="item-side"><span className="item-amount">{b.varies ? `about ${formatCurrency(b.amount)}` : formatCurrency(b.amount)}</span></div>
              </div>
            ))}
          </>
        )}
      </div>

      {server.state === 'ready' && (
        <div className="card">
          <h3>Notification</h3>
          {server.notify ? (
            <>
              <p className="muted settings-help">
                A notification goes to your phone through ntfy on the {ordinal(server.noticeDay)} of each month around {server.noticeHour} AM, once the month&apos;s
                last charges have posted. It says only that the review is ready, with no amounts or merchants.
              </p>
              <div className="data-actions">
                <button className="btn-secondary" onClick={sendTest} disabled={test.state === 'sending'}>Send a Test</button>
                {test.state === 'sent' && <span className="muted">Sent. Check your phone.</span>}
                {test.state === 'error' && <span className="error-text">{test.message}</span>}
              </div>
            </>
          ) : (
            <p className="muted">{server.notifyProblem}</p>
          )}
        </div>
      )}
    </div>
  );
}
