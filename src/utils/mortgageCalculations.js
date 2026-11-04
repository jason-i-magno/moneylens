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

// Generate projected payoff from a given balance forward using minimum payments
export function extrapolateFromBalance(currentBalance, annualRate, monthlyPayment, startMonth) {
  const monthlyRate = annualRate / 100 / 12;
  const timeline = [];
  let balance = currentBalance;
  const [startYear, startMo] = startMonth.split('-').map(Number);

  for (let i = 0; balance > 0 && i < 360; i++) {
    const month = ((startMo - 1 + i) % 12) + 1;
    const year = startYear + Math.floor((startMo - 1 + i) / 12);
    const dateStr = `${year}-${String(month).padStart(2, '0')}`;

    const interest = Math.round(balance * monthlyRate * 100) / 100;
    const principal = Math.min(Math.round((monthlyPayment - interest) * 100) / 100, balance);
    balance = Math.round((balance - principal) * 100) / 100;
    if (balance < 0) balance = 0;

    timeline.push({ date: dateStr, principal, interest, balance });
  }

  return timeline;
}

// The amortization table's rows, one per installment month: the original schedule, the actual payment for
// that month (by `forMonth`; principal includes extra principal), and the new trajectory (`extrapolateFromBalance`).
// Trajectory months past the original maturity (a loan behind schedule) are added at the end without
// scheduled values.
export function amortizationRows(schedule, payments, trajectory = []) {
  const actualByMonth = new Map(payments.map((p) => [p.forMonth, p]));
  const trajectoryByMonth = new Map(trajectory.map((t) => [t.date, t]));
  const lastScheduled = schedule.at(-1)?.date ?? '';
  const beyond = trajectory
    .filter((t) => t.date > lastScheduled)
    .map((t, i) => ({ paymentNumber: schedule.length + i + 1, date: t.date, principal: null, interest: null, balance: null }));

  return [...schedule, ...beyond].map((row) => {
    const actual = actualByMonth.get(row.date);
    const next = trajectoryByMonth.get(row.date);
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
