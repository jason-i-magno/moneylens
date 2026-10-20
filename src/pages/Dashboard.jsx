import { useMemo } from 'react';
import SummaryCard from '../components/SummaryCard';
import CategoryChart from '../components/CategoryChart';
import TransactionRow from '../components/TransactionRow';
import EmptyState from '../components/EmptyState';
import { formatCurrency } from '../constants/categories';
import { getMonthlyAmount } from '../utils/subscriptions';
import { currentMonth } from '../utils/dates';
import { isIncome, isSpending, sumAmounts, sumByCategory } from '../utils/transactions';

export default function Dashboard({ data }) {
  const month = currentMonth();

  const monthTransactions = useMemo(
    () => data.transactions.filter((tx) => tx.date?.startsWith(month)),
    [data.transactions, month]
  );

  const monthlyIncome = useMemo(() => sumAmounts(monthTransactions.filter(isIncome)), [monthTransactions]);
  const spendingTxs = useMemo(() => monthTransactions.filter(isSpending), [monthTransactions]);
  const totalSpending = useMemo(() => sumAmounts(spendingTxs), [spendingTxs]);

  // Manual subscriptions are informational: imported bank transactions already contain those
  // charges, so adding them to spending would count them twice.
  const activeSubs = data.subscriptions;
  const monthlySubCost = useMemo(
    () => activeSubs.reduce((sum, s) => sum + getMonthlyAmount(s.amount, s.frequency), 0),
    [activeSubs]
  );
  const yearlySubCost = monthlySubCost * 12;

  const remaining = monthlyIncome - totalSpending;

  const spendingByCategory = useMemo(() => sumByCategory(spendingTxs), [spendingTxs]);

  const recentTransactions = useMemo(
    () => [...monthTransactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    [monthTransactions]
  );

  return (
    <div className="page dashboard">
      <h2>Dashboard</h2>

      <div className="summary-grid">
        <SummaryCard label="Monthly Income" value={formatCurrency(monthlyIncome)} />
        <SummaryCard label="Total Spending" value={formatCurrency(totalSpending)} accent />
        <SummaryCard label="Remaining" value={formatCurrency(remaining)} />
      </div>

      <div className="card">
        <h3>Recurring Costs</h3>
        <div className="recurring-stats">
          <span>{activeSubs.length} active subscriptions</span>
          <span>{formatCurrency(monthlySubCost)}/mo</span>
          <span>{formatCurrency(yearlySubCost)}/yr</span>
        </div>
      </div>

      <div className="card">
        <h3>Spending by Category</h3>
        {Object.keys(spendingByCategory).length > 0 ? (
          <CategoryChart spending={spendingByCategory} budgets={data.budgets} />
        ) : (
          <EmptyState message="No spending data yet. Import a CSV or add transactions." />
        )}
      </div>

      <div className="card">
        <h3>Recent Transactions</h3>
        {recentTransactions.length > 0 ? (
          recentTransactions.map((tx) => <TransactionRow key={tx.id} transaction={tx} />)
        ) : (
          <EmptyState message="No transactions this month." />
        )}
      </div>
    </div>
  );
}
