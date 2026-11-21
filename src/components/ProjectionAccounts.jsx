import { Fragment } from 'react';
import { formatCompactCurrency } from '../constants/categories';

// The projection by account: each account's, loan's and savings pool's balance at a few points in time,
// grouped, with net worth at the bottom. `rows` are { key, name, group }; `groups` is [group, title] in
// order; `columns` are { m (months from today), label }; `valueOf(row, m)` gives a balance (today's dollars
// when those are shown). Clicking a name charts it (`onChart(key)`); `chartedKey` is the one charted.
export default function ProjectionAccounts({ rows, groups, columns, valueOf, total, chartedKey, onChart }) {
  return (
    <>
      <div className="import-preview projection-accounts-table">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              {columns.map((c) => <th key={c.m}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, title]) => {
              const items = rows.filter((r) => r.group === group);
              if (items.length === 0) return null;
              return (
                <Fragment key={group}>
                  <tr className="projection-group-row">
                    <td colSpan={columns.length + 1}>{title}</td>
                  </tr>
                  {items.map((r) => (
                    <tr key={r.key} className={r.key === chartedKey ? 'charted' : ''}>
                      <td>
                        <button className="projection-chart-link" onClick={() => onChart(r.key)} title="Show it on the chart">{r.name}</button>
                      </td>
                      {columns.map((c) => (
                        <td key={c.m} className={group === 'owed' ? 'owed' : ''}>{formatCompactCurrency(valueOf(r, c.m))}</td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
            <tr className={`projection-total-row ${chartedKey === total.key ? 'charted' : ''}`}>
              <td>
                <button className="projection-chart-link" onClick={() => onChart(total.key)} title="Show it on the chart">{total.name}</button>
              </td>
              {columns.map((c) => <td key={c.m}>{formatCompactCurrency(valueOf(total, c.m))}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted settings-help mt-12">
        Amounts owed are subtracted from net worth. &ldquo;Saved as cash&rdquo; and &ldquo;Saved and invested&rdquo; are what the projection saves
        from your take-home pay (cash up to the cushion, then invested); in retirement they are drawn on first. Click a name to chart it.
      </p>
    </>
  );
}
