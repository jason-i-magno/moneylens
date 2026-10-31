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

    const month = ((startMonth - 1 + i) % 12) + 1;
    const year = startYear + Math.floor((startMonth - 1 + i) / 12);
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

    timeline.push({ date: dateStr, balance });
  }

  return timeline;
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
