import { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { CATEGORIES, CATEGORY_MAP, formatCurrency } from '../constants/categories';
import EmptyState from '../components/EmptyState';
import { isIncome, isSpending, isTransfer } from '../utils/transactions';

function buildSpendingData(transactions, groupBy) {
  const buckets = {};

  transactions
    .filter(isSpending)
    .forEach((tx) => {
      if (!tx.date) return;
      const key = groupBy === 'daily' ? tx.date : tx.date.slice(0, 7);
      if (!buckets[key]) {
        buckets[key] = { label: key, total: 0 };
        CATEGORIES.forEach((c) => { buckets[key][c.id] = 0; });
      }
      buckets[key][tx.category] = (buckets[key][tx.category] || 0) + tx.amount;
      buckets[key].total += tx.amount;
    });

  for (const b of Object.values(buckets)) {
    b.total = Math.round(b.total * 100) / 100;
    CATEGORIES.forEach((c) => {
      b[c.id] = Math.round(b[c.id] * 100) / 100;
    });
  }

  const sorted = Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));

  if (groupBy === 'daily') {
    let runTotal = 0;
    const runCats = {};
    CATEGORIES.forEach((c) => { runCats[c.id] = 0; });
    for (const row of sorted) {
      runTotal += row.total;
      row.total = Math.round(runTotal * 100) / 100;
      CATEGORIES.forEach((c) => {
        runCats[c.id] += row[c.id];
        row[c.id] = Math.round(runCats[c.id] * 100) / 100;
      });
    }
  }

  return sorted;
}

function buildIncomeData(transactions, groupBy) {
  const buckets = {};

  transactions
    .filter(isIncome)
    .forEach((tx) => {
      if (!tx.date) return;
      const key = groupBy === 'daily' ? tx.date : tx.date.slice(0, 7);
      if (!buckets[key]) {
        buckets[key] = { label: key, total: 0 };
      }
      buckets[key].total += tx.amount;
    });

  for (const b of Object.values(buckets)) {
    b.total = Math.round(b.total * 100) / 100;
  }

  const sorted = Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));

  if (groupBy === 'daily') {
    let runTotal = 0;
    for (const row of sorted) {
      runTotal += row.total;
      row.total = Math.round(runTotal * 100) / 100;
    }
  }

  return sorted;
}

function buildNetData(transactions, groupBy) {
  const buckets = {};

  transactions
    .filter((tx) => !isTransfer(tx))
    .forEach((tx) => {
      if (!tx.date) return;
      const key = groupBy === 'daily' ? tx.date : tx.date.slice(0, 7);
      if (!buckets[key]) {
        buckets[key] = { label: key, income: 0, spending: 0, net: 0 };
      }
      if (isIncome(tx)) {
        buckets[key].income += tx.amount;
      } else {
        buckets[key].spending += tx.amount;
      }
    });

  for (const b of Object.values(buckets)) {
    b.income = Math.round(b.income * 100) / 100;
    b.spending = Math.round(b.spending * 100) / 100;
    b.net = Math.round((b.income - b.spending) * 100) / 100;
  }

  const sorted = Object.values(buckets).sort((a, b) => a.label.localeCompare(b.label));

  if (groupBy === 'daily') {
    let runIncome = 0;
    let runSpending = 0;
    for (const row of sorted) {
      runIncome += row.income;
      runSpending += row.spending;
      row.income = Math.round(runIncome * 100) / 100;
      row.spending = Math.round(runSpending * 100) / 100;
      row.net = Math.round((runIncome - runSpending) * 100) / 100;
    }
  }

  return sorted;
}

const TOOLTIP_STYLE = {
  contentStyle: { backgroundColor: '#222228', border: '1px solid #333', borderRadius: 8 },
  labelStyle: { color: '#E8E4DD' },
};

const XAXIS_PROPS = (groupBy) => ({
  dataKey: 'label',
  stroke: '#6b7280',
  tick: { fontSize: 12 },
  angle: groupBy === 'daily' ? -45 : 0,
  textAnchor: groupBy === 'daily' ? 'end' : 'middle',
  height: groupBy === 'daily' ? 60 : 30,
});

export default function Trends({ data }) {
  const [visible, setVisible] = useState(() => {
    const init = { total: true };
    CATEGORIES.forEach((c) => { init[c.id] = false; });
    return init;
  });
  const [groupBy, setGroupBy] = useState('monthly');

  const toggle = (key) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const spendingData = useMemo(
    () => buildSpendingData(data.transactions, groupBy),
    [data.transactions, groupBy]
  );

  const incomeData = useMemo(
    () => buildIncomeData(data.transactions, groupBy),
    [data.transactions, groupBy]
  );

  const netData = useMemo(
    () => buildNetData(data.transactions, groupBy),
    [data.transactions, groupBy]
  );

  const activeCategories = useMemo(() => {
    return CATEGORIES.filter((c) =>
      spendingData.some((d) => d[c.id] > 0)
    );
  }, [spendingData]);

  const hasData = spendingData.length > 0 || incomeData.length > 0;

  if (!hasData) {
    return (
      <div className="page trends">
        <h2>Trends</h2>
        <EmptyState message="No data yet. Import a CSV or add transactions." />
      </div>
    );
  }

  const dotProps = groupBy === 'monthly' ? { r: 4 } : false;
  const dotPropsSmall = groupBy === 'monthly' ? { r: 3 } : false;

  return (
    <div className="page trends">
      <div className="page-header">
        <h2>Trends</h2>
        <div className="view-toggle">
          <button
            className={`view-btn ${groupBy === 'monthly' ? 'active' : ''}`}
            onClick={() => setGroupBy('monthly')}
          >
            Monthly
          </button>
          <button
            className={`view-btn ${groupBy === 'daily' ? 'active' : ''}`}
            onClick={() => setGroupBy('daily')}
          >
            Daily
          </button>
        </div>
      </div>

      {spendingData.length > 0 && (
        <div className="card">
          <h3>Spending</h3>
          <div className="trends-toggles">
            <button
              className={`trend-toggle ${visible.total ? 'active' : ''}`}
              style={visible.total ? { backgroundColor: '#E8E4DD', color: '#1A1A1F' } : {}}
              onClick={() => toggle('total')}
            >
              Total
            </button>
            {activeCategories.map((c) => (
              <button
                key={c.id}
                className={`trend-toggle ${visible[c.id] ? 'active' : ''}`}
                style={visible[c.id] ? { backgroundColor: c.color + '33', color: c.color, borderColor: c.color } : {}}
                onClick={() => toggle(c.id)}
              >
                {c.icon} {c.name}
              </button>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={spendingData} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
              <XAxis {...XAXIS_PROPS(groupBy)} />
              <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={90} />
              <Tooltip
                formatter={(value, name) => [formatCurrency(value), name === 'total' ? 'Total' : (CATEGORY_MAP[name]?.name || name)]}
                {...TOOLTIP_STYLE}
                itemSorter={(item) => -item.value}
              />
              {visible.total && (
                <Line type="monotone" dataKey="total" name="total" stroke="#E8E4DD" strokeWidth={2.5} dot={dotProps} activeDot={{ r: 6 }} />
              )}
              {activeCategories.map((c) =>
                visible[c.id] ? (
                  <Line key={c.id} type="monotone" dataKey={c.id} name={c.id} stroke={c.color} strokeWidth={2} dot={dotPropsSmall} activeDot={{ r: 5 }} />
                ) : null
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {incomeData.length > 0 && (
        <div className="card">
          <h3>Income</h3>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={incomeData} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
              <XAxis {...XAXIS_PROPS(groupBy)} />
              <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={90} />
              <Tooltip
                formatter={(value) => [formatCurrency(value), 'Income']}
                {...TOOLTIP_STYLE}
              />
              <Line type="monotone" dataKey="total" name="Income" stroke="#7CE8A3" strokeWidth={2.5} dot={dotProps} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {netData.length > 0 && (
        <div className="card">
          <h3>Net</h3>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={netData} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
              <XAxis {...XAXIS_PROPS(groupBy)} />
              <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={90} />
              <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
              <Tooltip
                formatter={(value, name) => {
                  const labels = { income: 'Income', spending: 'Spending', net: 'Net' };
                  return [formatCurrency(value), labels[name] || name];
                }}
                {...TOOLTIP_STYLE}
                itemSorter={(item) => -item.value}
              />
              <Line type="monotone" dataKey="income" name="income" stroke="#7CE8A3" strokeWidth={2} dot={dotPropsSmall} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="spending" name="spending" stroke="#E8927C" strokeWidth={2} dot={dotPropsSmall} activeDot={{ r: 5 }} />
              <Line type="monotone" dataKey="net" name="net" stroke="#E8E4DD" strokeWidth={2.5} dot={dotProps} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
