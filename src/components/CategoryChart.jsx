import { BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ReferenceLine, ResponsiveContainer } from 'recharts';
import { SPENDING_CATEGORIES, formatCurrency } from '../constants/categories';
import { chartTooltipProps } from '../constants/chartTooltip';

const CHART_MARGIN = { left: 100, right: 30, top: 10, bottom: 10 };
const Y_AXIS_WIDTH = 90;

export default function CategoryChart({ spending, budgets = {} }) {
  const chartData = SPENDING_CATEGORIES
    .map((cat) => ({
      name: cat.name,
      id: cat.id,
      amount: spending[cat.id] || 0,
      color: cat.color,
      budget: budgets[cat.id] || 0,
    }))
    .filter((d) => d.amount > 0 || d.budget > 0)
    .sort((a, b) => b.amount - a.amount);

  if (chartData.length === 0) return null;

  const maxValue = Math.max(...chartData.map((d) => Math.max(d.amount, d.budget)));

  return (
    <ResponsiveContainer width="100%" height={chartData.length * 50 + 40}>
      <BarChart data={chartData} layout="vertical" margin={CHART_MARGIN}>
        <XAxis type="number" domain={[0, maxValue * 1.1]} tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" />
        <YAxis type="category" dataKey="name" width={Y_AXIS_WIDTH} stroke="#6b7280" />
        <Tooltip
          formatter={(value) => formatCurrency(value)}
          {...chartTooltipProps(CHART_MARGIN.left + Y_AXIS_WIDTH)}
          itemStyle={{ color: '#E8E4DD' }}
        />
        <Bar dataKey="amount" radius={[0, 6, 6, 0]} barSize={24}>
          {chartData.map((entry) => (
            <Cell key={entry.id} fill={entry.color} />
          ))}
        </Bar>
        {chartData.map((entry) =>
          entry.budget > 0 ? (
            <ReferenceLine
              key={`budget-${entry.id}`}
              x={entry.budget}
              stroke="#E8E4DD"
              strokeDasharray="4 4"
              strokeWidth={2}
            />
          ) : null
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
