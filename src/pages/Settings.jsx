import { useState, useRef, useMemo } from 'react';
import { CATEGORY_MAP } from '../constants/categories';
import { diffKeywords, getEffectiveKeywords, recategorizeStored } from '../utils/categorizer';

const formatKeywords = (added, removed) => JSON.stringify(getEffectiveKeywords(added, removed), null, 2);

export default function Settings({
  data,
  setKeywordOverrides,
  updateTransactions,
  deleteBankProfile,
  exportData,
  importData,
  resetData,
}) {
  const [keywords, setKeywords] = useState(() => formatKeywords(data.categoryKeywords, data.removedKeywords));
  const [keywordsError, setKeywordsError] = useState('');
  const [keywordsSaved, setKeywordsSaved] = useState(false);
  const [recatChanges, setRecatChanges] = useState(null);
  const [importError, setImportError] = useState('');
  const [showReset, setShowReset] = useState(false);
  const fileRef = useRef(null);

  const effectiveKeywords = useMemo(
    () => getEffectiveKeywords(data.categoryKeywords, data.removedKeywords),
    [data.categoryKeywords, data.removedKeywords]
  );

  const handleSaveKeywords = () => {
    try {
      const parsed = JSON.parse(keywords);
      const valid = parsed && typeof parsed === 'object' && Object.values(parsed).every(Array.isArray);
      if (!valid) throw new Error('shape');
      const { added, removed } = diffKeywords(parsed);
      setKeywordOverrides(added, removed);
      setKeywords(formatKeywords(added, removed));
      setKeywordsError('');
      setKeywordsSaved(true);
    } catch {
      setKeywordsError('Must be valid JSON: { "categoryId": ["keyword", ...], ... }');
      setKeywordsSaved(false);
    }
  };

  const handleResetKeywords = () => {
    setKeywordOverrides({}, {});
    setKeywords(formatKeywords({}, {}));
    setKeywordsError('');
    setKeywordsSaved(true);
  };

  // Re-run auto-categorization on imported and synced transactions and propose the differences.
  // Manual transactions are left alone; the user unticks any row they corrected by hand.
  const handlePreviewRecategorize = () => {
    const imported = data.transactions.filter((tx) => tx.source === 'csv_import' || tx.source === 'plaid');
    const recategorized = recategorizeStored(imported, effectiveKeywords);
    const changes = recategorized
      .map((r, i) => ({ tx: imported[i], category: r.category, isSubscription: r.isSubscription }))
      .filter(({ tx, category, isSubscription }) => tx.category !== category || !!tx.isSubscription !== isSubscription)
      .map((c) => ({ ...c, apply: true }));
    setRecatChanges(changes);
  };

  const toggleRecatChange = (id) => {
    setRecatChanges((prev) => prev.map((c) => (c.tx.id === id ? { ...c, apply: !c.apply } : c)));
  };

  const handleApplyRecategorize = () => {
    const changesById = {};
    for (const c of recatChanges) {
      if (c.apply) changesById[c.tx.id] = { category: c.category, isSubscription: c.isSubscription };
    }
    updateTransactions(changesById);
    setRecatChanges(null);
  };

  const handleExport = () => {
    const json = exportData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'moneylens-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (importData(ev.target.result)) {
        window.location.reload();
      } else {
        setImportError(`Couldn't read ${file.name} — it isn't a MoneyLens JSON backup.`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleReset = () => {
    resetData();
    setShowReset(false);
    window.location.reload();
  };

  const profiles = Object.entries(data.bankProfiles || {});
  const applyCount = recatChanges?.filter((c) => c.apply).length || 0;

  return (
    <div className="page settings">
      <h2>Settings</h2>

      <div className="card">
        <h3>Bank Profiles</h3>
        {profiles.length === 0 ? (
          <p className="muted">No saved bank profiles. Import a CSV to create one.</p>
        ) : (
          profiles.map(([id, p]) => (
            <div key={id} className="profile-row">
              <span>{p.name}</span>
              <button className="btn-icon danger" onClick={() => deleteBankProfile(id)}>Delete</button>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h3>Category Keywords</h3>
        <p className="muted settings-help">
          Case-insensitive. A keyword must start at the beginning of a word, and the longest matching keyword wins.
          Only your changes from the built-in defaults are saved, so new defaults still apply.
        </p>
        <textarea
          className="keywords-editor"
          value={keywords}
          onChange={(e) => { setKeywords(e.target.value); setKeywordsSaved(false); }}
          rows={12}
        />
        {keywordsError && <p className="error-text">{keywordsError}</p>}
        <div className="data-actions">
          <button className="btn-primary" onClick={handleSaveKeywords}>Save Keywords</button>
          <button className="btn-secondary" onClick={handleResetKeywords}>Reset to Defaults</button>
          {keywordsSaved && <span className="muted inline-status">Saved</span>}
        </div>
      </div>

      <div className="card">
        <h3>Re-categorize Imported Transactions</h3>
        <p className="muted settings-help">
          Keyword changes only apply to new imports. Preview what the current keywords would change on transactions you already imported or synced.
        </p>
        {recatChanges === null ? (
          <button className="btn-secondary" onClick={handlePreviewRecategorize}>Preview Changes</button>
        ) : recatChanges.length === 0 ? (
          <div className="data-actions">
            <span className="muted inline-status">Everything already matches the current keywords.</span>
            <button className="btn-secondary" onClick={() => setRecatChanges(null)}>Done</button>
          </div>
        ) : (
          <>
            <div className="import-preview">
              <table>
                <thead>
                  <tr><th>Apply</th><th>Date</th><th>Description</th><th>Current</th><th>Proposed</th></tr>
                </thead>
                <tbody>
                  {recatChanges.map(({ tx, category, isSubscription, apply }) => (
                    <tr key={tx.id}>
                      <td><input type="checkbox" checked={apply} onChange={() => toggleRecatChange(tx.id)} /></td>
                      <td>{tx.date}</td>
                      <td className="desc-cell">{tx.name}</td>
                      <td>{CATEGORY_MAP[tx.category]?.name || tx.category}{tx.isSubscription ? ' · SUB' : ''}</td>
                      <td>{CATEGORY_MAP[category]?.name || category}{isSubscription ? ' · SUB' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={handleApplyRecategorize} disabled={applyCount === 0}>
                Apply {applyCount} Change{applyCount !== 1 ? 's' : ''}
              </button>
              <button className="btn-secondary" onClick={() => setRecatChanges(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h3>Data Management</h3>
        <div className="data-actions">
          <button className="btn-secondary" onClick={handleExport}>Export JSON</button>
          <button className="btn-secondary" onClick={() => { setImportError(''); fileRef.current?.click(); }}>
            Import JSON
          </button>
          <input ref={fileRef} type="file" accept=".json" onChange={handleImportFile} hidden />
          <button className="btn-danger" onClick={() => setShowReset(true)}>Reset All Data</button>
        </div>
        {importError && <p className="error-text mt-12">{importError}</p>}
        {showReset && (
          <div className="reset-confirm">
            <p>Are you sure? This will delete all your data.</p>
            <button className="btn-danger" onClick={handleReset}>Yes, Reset Everything</button>
            <button className="btn-secondary" onClick={() => setShowReset(false)}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
