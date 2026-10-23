import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { useFinanceData } from './hooks/useFinanceData';
import { usePlaidSync } from './hooks/usePlaidSync';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const Spending = lazy(() => import('./pages/Spending'));
const Income = lazy(() => import('./pages/Income'));
const Trends = lazy(() => import('./pages/Trends'));
const Budgets = lazy(() => import('./pages/Budgets'));
const Mortgage = lazy(() => import('./pages/Mortgage'));
const NetWorth = lazy(() => import('./pages/NetWorth'));
const Import = lazy(() => import('./pages/Import'));
const BankSync = lazy(() => import('./pages/BankSync'));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  const finance = useFinanceData();
  const { data } = finance;
  const plaidSync = usePlaidSync(finance);
  const bankSyncAlert = data.plaid.items.some((i) => i.lastError);

  return (
    <Routes>
      <Route element={<Layout bankSyncAlert={bankSyncAlert} />}>
        <Route path="/dashboard" element={<Dashboard data={data} />} />
        <Route
          path="/subscriptions"
          element={
            <Subscriptions
              data={data}
              addSubscription={finance.addSubscription}
              updateSubscription={finance.updateSubscription}
              deleteSubscription={finance.deleteSubscription}
            />
          }
        />
        <Route
          path="/spending"
          element={
            <Spending
              data={data}
              addTransaction={finance.addTransaction}
              updateTransaction={finance.updateTransaction}
              deleteTransaction={finance.deleteTransaction}
            />
          }
        />
        <Route
          path="/income"
          element={
            <Income
              data={data}
              updateTransaction={finance.updateTransaction}
              deleteTransaction={finance.deleteTransaction}
            />
          }
        />
        <Route path="/trends" element={<Trends data={data} />} />
        <Route
          path="/budgets"
          element={
            <Budgets
              data={data}
              setBudget={finance.setBudget}
              deleteBudget={finance.deleteBudget}
            />
          }
        />
        <Route path="/mortgage" element={<Mortgage data={data} finance={finance} />} />
        <Route path="/net-worth" element={<NetWorth data={data} finance={finance} />} />
        <Route path="/import" element={<Import data={data} finance={finance} />} />
        <Route path="/bank-sync" element={<BankSync data={data} finance={finance} plaidSync={plaidSync} />} />
        <Route
          path="/settings"
          element={
            <Settings
              data={data}
              setKeywordOverrides={finance.setKeywordOverrides}
              updateTransactions={finance.updateTransactions}
              deleteBankProfile={finance.deleteBankProfile}
              exportData={finance.exportData}
              importData={finance.importData}
              resetData={finance.resetData}
            />
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
