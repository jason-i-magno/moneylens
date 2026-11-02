// Props for a Recharts <Tooltip> in the app's dark style that stays inside its chart on a phone.
// Recharts never starts a tooltip left of the plot area, so on a narrow chart a wide one would stick out past
// the chart's right edge and make the page scroll sideways. `plotLeft` is the chart's left margin plus its
// Y axis width; the tooltip is capped to the room right of that, and .chart-tooltip (App.css) then wraps a
// value under its name instead of letting the row run wider.
export const chartTooltipProps = (plotLeft) => ({
  separator: ': ',
  wrapperClassName: 'chart-tooltip',
  wrapperStyle: { maxWidth: `calc(100% - ${plotLeft}px)` },
  contentStyle: { backgroundColor: '#222228', border: '1px solid #333', borderRadius: 8 },
  labelStyle: { color: '#E8E4DD' },
});
