import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/spending', label: 'Spending' },
  { to: '/income', label: 'Income' },
  { to: '/trends', label: 'Trends' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/mortgage', label: 'Mortgage' },
  { to: '/net-worth', label: 'Net Worth' },
  { to: '/import', label: 'Import' },
  { to: '/bank-sync', label: 'Bank Sync' },
  { to: '/settings', label: 'Settings' },
];

// bankSyncAlert: a connection failed its last sync (e.g. the bank wants the user to log in again)
export default function Layout({ bankSyncAlert }) {
  return (
    <div className="app-layout">
      <header className="app-header">
        <h1 className="app-logo">MoneyLens</h1>
        <nav className="app-nav">
          {NAV_ITEMS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              {label}
              {to === '/bank-sync' && bankSyncAlert && <span className="nav-alert" title="A bank needs attention" />}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="app-main">
        <Suspense fallback={<p className="muted">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
