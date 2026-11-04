import { addMonths } from './dates';

export function generateAmortization(loanAmount, annualRate, termYears, startDate) {
  const monthlyRate = annualRate / 100 / 12;
  const numPayments = termYears * 12;
  const monthlyPayment = loanAmount * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
    (Math.pow(1 + monthlyRate, numPayments) - 1);

  const schedule = [];
  let balance = loanAmount;
  const [startYear, startMonth] = startDate.split('-').map(Number);

  for (let i = 0; i < numPayments; i++) {
    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.round((monthlyPayment - interest) * 100) / 100;
    balance = Math.round((balance - principal) * 100) / 100;
    if (balance < 0) balance = 0;

    // Payment 1 is due the month after the loan starts (interest is paid in arrears), the last on the maturity date
    const month = ((startMonth + i) % 12) + 1;
    const year = startYear + Math.floor((startMonth + i) / 12);
    const dateStr = `${year}-${String(month).padStart(2, '0')}`;

    schedule.push({
      paymentNumber: i + 1,
      date: dateStr,
      principal,
      interest,
      totalPayment: Math.round(monthlyPayment * 100) / 100,
      balance,
    });
  }

  return schedule;
}

// Generate projected payoff from a given balance forward using minimum payments, plus optional extra principal:
// `extraMonthly` with every payment and `oneTime` ({ month: 'YYYY-MM', amount }) once. `principal` includes the extra.
export function extrapolateFromBalance(currentBalance, annualRate, monthlyPayment, startMonth, { extraMonthly = 0, oneTime = null } = {}) {
  const monthlyRate = annualRate / 100 / 12;
  const timeline = [];
  let balance = currentBalance;
  const [startYear, startMo] = startMonth.split('-').map(Number);

  for (let i = 0; balance > 0 && i < 360; i++) {
    const month = ((startMo - 1 + i) % 12) + 1;
    const year = startYear + Math.floor((startMo - 1 + i) / 12);
    const dateStr = `${year}-${String(month).padStart(2, '0')}`;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const extra = extraMonthly + (oneTime?.month === dateStr ? oneTime.amount : 0);
    const principal = Math.min(Math.round((monthlyPayment - interest + extra) * 100) / 100, balance);
    balance = Math.round((balance - principal) * 100) / 100;
    if (balance < 0) balance = 0;

    timeline.push({ date: dateStr, principal, interest, balance });
  }

  return timeline;
}

// Where a loan's New Trajectory starts: the month after its latest payment, at that payment's balance, or the
// first scheduled month at the loan amount when it has no payments yet
export function trajectoryStart(loan, payments) {
  const latest = payments.reduce((a, p) => (!a || p.forMonth > a.forMonth ? p : a), null);
  return latest
    ? { month: addMonths(latest.forMonth, 1), balance: latest.balanceAfter }
    : { month: addMonths(loan.startDate.slice(0, 7), 1), balance: loan.loanAmount };
}

// The New Trajectory (minimum payments from the latest balance) with and without extra payments
// (`extraMonthly`, `oneTime` as in extrapolateFromBalance). Each side has its timeline, number of payments, payoff
// month (null when not paid off within 30 years) and total interest.
export function compareExtraPayments(loan, payments, extra = {}) {
  const start = trajectoryStart(loan, payments);
  const run = (options) => {
    const timeline = extrapolateFromBalance(start.balance, loan.interestRate, loan.monthlyPI, start.month, options);
    const last = timeline.at(-1);
    return {
      timeline,
      months: timeline.length,
      payoffMonth: last?.balance === 0 ? last.date : null,
      interest: Math.round(timeline.reduce((sum, t) => sum + t.interest, 0) * 100) / 100,
    };
  };
  const base = run();
  const withExtra = run(extra);
  return {
    start,
    base,
    withExtra,
    monthsSaved: base.months - withExtra.months,
    interestSaved: Math.round((base.interest - withExtra.interest) * 100) / 100,
  };
}

// Average extra principal a month over the latest `count` payments (by installment month)
export function averageExtraPrincipal(payments, count = 6) {
  const latest = [...payments].sort((a, b) => b.forMonth.localeCompare(a.forMonth)).slice(0, count);
  if (latest.length === 0) return 0;
  return Math.round((latest.reduce((sum, p) => sum + (p.extraPrincipal || 0), 0) / latest.length) * 100) / 100;
}

// The amortization table's rows, one per installment month: the original schedule, the actual payment for
// that month (by `forMonth`; principal includes extra principal), the new trajectory (`extrapolateFromBalance`),
// and the same with the Extra Payment Calculator's extra payments (`withExtra`, principal including the extra).
// Trajectory months past the original maturity (a loan behind schedule) are added at the end without
// scheduled values.
export function amortizationRows(schedule, payments, trajectory = [], withExtra = []) {
  const actualByMonth = new Map(payments.map((p) => [p.forMonth, p]));
  const trajectoryByMonth = new Map(trajectory.map((t) => [t.date, t]));
  const withExtraByMonth = new Map(withExtra.map((t) => [t.date, t]));
  const lastScheduled = schedule.at(-1)?.date ?? '';
  const beyond = [...new Set([...trajectory, ...withExtra].map((t) => t.date).filter((d) => d > lastScheduled))]
    .sort()
    .map((date, i) => ({ paymentNumber: schedule.length + i + 1, date, principal: null, interest: null, balance: null }));

  return [...schedule, ...beyond].map((row) => {
    const actual = actualByMonth.get(row.date);
    const next = trajectoryByMonth.get(row.date);
    const extra = withExtraByMonth.get(row.date);
    return {
      ...row,
      actualPrincipal: actual ? actual.principal + (actual.extraPrincipal || 0) : null,
      actualInterest: actual ? actual.interest : null,
      actualBalance: actual ? actual.balanceAfter : null,
      hasActual: !!actual,
      trajectoryPrincipal: next ? next.principal : null,
      trajectoryInterest: next ? next.interest : null,
      trajectoryBalance: next ? next.balance : null,
      hasTrajectory: !!next,
      withExtraPrincipal: extra ? extra.principal : null,
      withExtraInterest: extra ? extra.interest : null,
      withExtraBalance: extra ? extra.balance : null,
      hasWithExtra: !!extra,
    };
  });
}

export function buildActualTimeline(payments, startBalance, startDate) {
  const timeline = [{ date: startDate, balance: startBalance }];
  const sorted = [...payments].sort((a, b) => a.forMonth.localeCompare(b.forMonth));
  for (const p of sorted) {
    timeline.push({ date: p.forMonth, balance: p.balanceAfter });
  }
  return timeline;
}

// A loan's servicers, oldest first: the past ones (`pastServicers`, each serving `until` the day the next
// one took over), then the current one from the loan's own fields. A servicing transfer changes who
// collects the payments and the loan number, not the loan.
export function loanServicers(loan) {
  const past = [...(loan.pastServicers || [])].sort((a, b) => (a.until || '').localeCompare(b.until || ''));
  return [...past, { servicer: loan.servicer, servicerType: loan.servicerType, loanNumber: loan.loanNumber, until: null }];
}

// The servicer a payment on `date` went to
export function servicerOn(loan, date) {
  return loanServicers(loan).find((s) => !s.until || date < s.until);
}
