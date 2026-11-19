// Shown while the data loads, or instead of the app when MoneyLens's server can't be reached
export default function StartupScreen({ error, onRetry }) {
  if (!error) {
    return (
      <div className="app-layout">
        <p className="muted startup-loading">Loading…</p>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <div className="card error-fallback">
        <h2>Can&apos;t load your data</h2>
        <p className="muted">
          This browser keeps its data on MoneyLens&apos;s server, and the server didn&apos;t answer. Make sure it&apos;s running
          (npm run dev, or the moneylens service) and, from another computer, that Tailscale is connected.
        </p>
        <pre className="error-detail">{error.message}</pre>
        <div className="data-actions">
          <button className="btn-primary" onClick={onRetry}>Try Again</button>
        </div>
      </div>
    </div>
  );
}
