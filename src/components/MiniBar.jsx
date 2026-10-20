export default function MiniBar({ spent, budget, color }) {
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
    </div>
  );
}
