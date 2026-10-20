export default function SummaryCard({ label, value, accent }) {
  return (
    <div className={`summary-card ${accent ? 'accent' : ''}`}>
      <span className="summary-label">{label}</span>
      <span className="summary-value">{value}</span>
    </div>
  );
}
