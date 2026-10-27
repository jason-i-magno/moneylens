import { useState, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { CATEGORIES, INCOME_CATEGORIES, SPENDING_CATEGORIES, formatCurrency } from '../constants/categories';
import EmptyState from '../components/EmptyState';
import { isIncome, isSpending } from '../utils/transactions';
import { buildCategoryData, buildNetData } from '../utils/trends';

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

// One toggle per series; doubles as the legend. A `strong` series (Total, Net) gets a solid chip.
function SeriesToggles({ series, visible, onToggle }) {
  return (
    <div className="trends-toggles">
      {series.map((s) => (
        <button
          key={s.key}
          className={`trend-toggle ${visible[s.key] ? 'active' : ''}`}
          style={visible[s.key]
            ? (s.strong ? { backgroundColor: s.color, color: '#1A1A1F' } : { backgroundColor: s.color + '33', color: s.color, borderColor: s.color })
            : {}}
          onClick={() => onToggle(s.key)}
        >
          {s.icon ? `${s.icon} ${s.name}` : s.name}
        </button>
      ))}
    </div>
  );
}

const TOTAL = { key: 'total', name: 'Total', color: '#E8E4DD', strong: true };

// Total, then one series per category that has data
const categorySeries = (categories) => [
  TOTAL,
  ...categories.map((c) => ({ key: c.id, name: c.name, color: c.color, icon: c.icon })),
];

const NET_SERIES = [
  { key: 'income', name: 'Income', color: '#7CE8A3' },
  { key: 'spending', name: 'Spending', color: '#E8927C' },
  { key: 'net', name: 'Net', color: '#E8E4DD', strong: true },
];

const toggledOn = (series, visible) => series.filter((s) => visible[s.key]);
const flip = (setVisible) => (key) => setVisible((prev) => ({ ...prev, [key]: !prev[key] }));

// Running totals read as lines; each period's own total as bars (24px at most, rounded at the data end)
function TrendChart({ data, series, groupBy, cumulative, height, zeroLine = false }) {
  const names = Object.fromEntries(series.map((s) => [s.key, s.name]));
  const monthly = groupBy === 'monthly';
  const Chart = cumulative ? LineChart : BarChart;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart data={data} margin={{ left: 10, right: 20, top: 10, bottom: 10 }} {...(cumulative ? {} : { barGap: 2, barCategoryGap: '20%' })}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
        <XAxis {...XAXIS_PROPS(groupBy)} padding={cumulative ? { left: 24, right: 24 } : undefined} />
        <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={90} />
        {zeroLine && <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />}
        <Tooltip
          formatter={(value, key) => [formatCurrency(value), names[key] || key]}
          cursor={cumulative ? true : { fill: '#E8E4DD', fillOpacity: 0.06 }}
          {...TOOLTIP_STYLE}
          itemSorter={(item) => -item.value}
        />
        {series.map((s) => (cumulative ? (
          <Line
            key={s.key} type="monotone" dataKey={s.key} name={s.key} stroke={s.color} strokeWidth={s.strong ? 2.5 : 2}
            dot={monthly ? { r: s.strong ? 4 : 3 } : false} activeDot={{ r: s.strong ? 6 : 5 }}
          />
        ) : (
          <Bar key={s.key} dataKey={s.key} name={s.key} fill={s.color} maxBarSize={24} radius={[4, 4, 0, 0]} />
        )))}
      </Chart>
    </ResponsiveContainer>
  );
}

export default function Trends({ data }) {
  const [visible, setVisible] = useState({ total: true });
  const [incomeVisible, setIncomeVisible] = useState({ total: true });
  const [netVisible, setNetVisible] = useState({ income: true, spending: true, net: true });
  const [groupBy, setGroupBy] = useState('monthly');
  const [cumulative, setCumulative] = useState(false);

  const spendingData = useMemo(
    () => buildCategoryData(data.transactions, isSpending, { groupBy, cumulative }),
    [data.transactions, groupBy, cumulative]
  );

  const incomeData = useMemo(
    () => buildCategoryData(data.transactions, isIncome, { groupBy, cumulative }),
    [data.transactions, groupBy, cumulative]
  );

  const netData = useMemo(
    () => buildNetData(data.transactions, { groupBy, cumulative }),
    [data.transactions, groupBy, cumulative]
  );

  const activeCategories = useMemo(() => {
    return CATEGORIES.filter((c) =>
      spendingData.some((d) => d[c.id] > 0)
    );
  }, [spendingData]);

  // Income categories first; any other category on income (e.g. Other before re-categorizing) after
  const activeIncomeCategories = useMemo(() => {
    return [...INCOME_CATEGORIES, ...SPENDING_CATEGORIES].filter((c) =>
      incomeData.some((d) => d[c.id] > 0)
    );
  }, [incomeData]);

  const hasData = spendingData.length > 0 || incomeData.length > 0;

  if (!hasData) {
    return (
      <div className="page trends">
        <h2>Trends</h2>
        <EmptyState message="No data yet. Import a CSV or add transactions." />
      </div>
    );
  }

  const chartProps = { groupBy, cumulative };

  return (
    <div className="page trends">
      <div className="page-header">
        <h2>Trends</h2>
        <div className="page-header-actions">
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
          <div className="view-toggle">
            <button className={`view-btn ${!cumulative ? 'active' : ''}`} onClick={() => setCumulative(false)}>
              {groupBy === 'monthly' ? 'Per month' : 'Per day'}
            </button>
            <button className={`view-btn ${cumulative ? 'active' : ''}`} onClick={() => setCumulative(true)}>
              Cumulative
            </button>
          </div>
        </div>
      </div>

      {spendingData.length > 0 && (
        <div className="card">
          <h3>Spending</h3>
          <SeriesToggles series={categorySeries(activeCategories)} visible={visible} onToggle={flip(setVisible)} />
          <TrendChart data={spendingData} series={toggledOn(categorySeries(activeCategories), visible)} height={400} {...chartProps} />
        </div>
      )}

      {incomeData.length > 0 && (
        <div className="card">
          <h3>Income</h3>
          <SeriesToggles series={categorySeries(activeIncomeCategories)} visible={incomeVisible} onToggle={flip(setIncomeVisible)} />
          <TrendChart data={incomeData} series={toggledOn(categorySeries(activeIncomeCategories), incomeVisible)} height={350} {...chartProps} />
        </div>
      )}

      {netData.length > 0 && (
        <div className="card">
          <h3>Net</h3>
          <SeriesToggles series={NET_SERIES} visible={netVisible} onToggle={flip(setNetVisible)} />
          <TrendChart data={netData} series={toggledOn(NET_SERIES, netVisible)} height={350} zeroLine {...chartProps} />
        </div>
      )}
    </div>
  );
}
