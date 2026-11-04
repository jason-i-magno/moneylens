// `tone` ('good' | 'bad') colors the value; `note` is a small line under it
export default function SummaryCard({ label, value, accent, tone, note }) {
  return (
    <div className={`summary-card ${accent ? 'accent' : ''}`}>
      <span className="summary-label">{label}</span>
      <span className={`summary-value ${tone || ''}`}>{value}</span>
      {note && <span className="summary-note">{note}</span>}
    </div>
  );
}
