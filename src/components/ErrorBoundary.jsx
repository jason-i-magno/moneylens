import { Component } from 'react';
import { backupJson } from '../utils/storage';

// The latest data, even a change the server hasn't saved yet
function downloadBackup() {
  const url = URL.createObjectURL(new Blob([backupJson()], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'moneylens-backup.json';
  a.click();
  URL.revokeObjectURL(url);
}

// The one class component in the app: React only supports error boundaries as classes
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('MoneyLens crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app-layout">
        <div className="card error-fallback">
          <h2>Something went wrong</h2>
          <p className="muted">Your saved data is untouched. Download a backup before trying anything else.</p>
          <pre className="error-detail">{String(this.state.error?.message || this.state.error)}</pre>
          <div className="data-actions">
            <button className="btn-primary" onClick={downloadBackup}>Download Backup</button>
            <button className="btn-secondary" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
