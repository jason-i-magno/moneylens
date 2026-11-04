// Spending against a budget; `marker` (0–1 of the budget) draws a line where an even pace would be by today
export default function MiniBar({ spent, budget, color, marker = null }) {
  const pct = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
  const over = spent > budget && budget > 0;

  return (
    <div className="mini-bar">
      <div className="mini-bar-track">
        <div
          className={`mini-bar-fill ${over ? 'over-budget' : ''}`}
          style={{ width: `${pct}%`, backgroundColor: over ? '#ef4444' : color }}
        />
      </div>
      {marker != null && <div className="mini-bar-marker" style={{ left: `${marker * 100}%` }} title="Even pace by today" />}
    </div>
  );
}
