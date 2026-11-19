import { useState, useRef, useMemo } from 'react';
import ConfirmButton from '../components/ConfirmButton';
import { CATEGORY_MAP } from '../constants/categories';
import { diffKeywords, getEffectiveKeywords, proposeRecategorization } from '../utils/categorizer';

const formatKeywords = (added, removed) => JSON.stringify(getEffectiveKeywords(added, removed), null, 2);

function downloadJson(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const formatSavedAt = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export default function Settings({
  data,
  setKeywordOverrides,
  updateTransactions,
  deleteBankProfile,
  exportData,
  importData,
  resetData,
  storage,
  restoreVersion,
  moveToServer,
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
  // Manual transactions and categories set by hand are left out.
  const handlePreviewRecategorize = () => {
    setRecatChanges(proposeRecategorization(data.transactions, effectiveKeywords).map((c) => ({ ...c, apply: true })));
  };

  const toggleRecatChange = (id) => {
    setRecatChanges((prev) => prev.map((c) => (c.tx.id === id ? { ...c, apply: !c.apply } : c)));
  };

  // An unticked row keeps its category as the user's own, so it isn't proposed again
  const handleApplyRecategorize = () => {
    const changesById = {};
    for (const c of recatChanges) {
      changesById[c.tx.id] = c.apply ? { category: c.category, isSubscription: c.isSubscription } : { categorySetByUser: true };
    }
    updateTransactions(changesById);
    setRecatChanges(null);
  };

  const handleExport = () => downloadJson(exportData(), 'moneylens-backup.json');

  // The page reloads only once the new data is saved
  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      if (await importData(await file.text())) window.location.reload();
      else setImportError(`Couldn't read ${file.name} — it isn't a MoneyLens JSON backup.`);
    } catch (err) {
      setImportError(`Couldn't save the backup: ${err.message}`);
    }
  };

  const handleReset = async () => {
    try {
      await resetData();
      window.location.reload();
    } catch (err) {
      setImportError(`Couldn't reset: ${err.message}`);
      setShowReset(false);
    }
  };

  const profiles = Object.entries(data.bankProfiles || {});
  const applyCount = recatChanges?.filter((c) => c.apply).length || 0;
  const keepCount = (recatChanges?.length || 0) - applyCount;

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
          Categories you changed by hand are never touched. Untick a row to keep its category as yours: it won&apos;t be suggested again.
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
              <button className="btn-primary" onClick={handleApplyRecategorize}>
                Apply {applyCount} Change{applyCount !== 1 ? 's' : ''}{keepCount > 0 && `, Keep ${keepCount}`}
              </button>
              <button className="btn-secondary" onClick={() => setRecatChanges(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>

      <StorageCard data={data} storage={storage} restoreVersion={restoreVersion} moveToServer={moveToServer} />

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

// Where the data is kept: this browser, or MoneyLens's server (with its earlier versions)
function StorageCard({ data, storage, restoreVersion, moveToServer }) {
  const [versions, setVersions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ownCopy, setOwnCopy] = useState(() => storage.ownCopyFromBefore?.() || null);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleMove = () => run(async () => {
    try {
      await moveToServer();
    } catch (err) {
      throw err.code === 'CONFLICT'
        ? new Error('Another browser moved its data to the server first. Reload this page to use that data.')
        : err;
    }
    window.location.reload();
  });

  const handleShowVersions = () => run(async () => setVersions(await storage.versions()));

  const handleRestore = (v) => run(async () => {
    await restoreVersion(v.rev, `Restored the version from ${formatSavedAt(v.savedAt)}`);
    window.location.reload();
  });

  const handleDiscardOwnCopy = () => {
    storage.discardOwnCopy();
    setOwnCopy(null);
  };

  if (storage.mode === 'local') {
    const hasData = data.transactions.length > 0 || data.netWorth.accounts.length > 0 || data.mortgages.loans.length > 0;
    return (
      <div className="card">
        <h3>Storage</h3>
        {!storage.serverAvailable ? (
          <p className="muted">Your data is saved in this browser only.</p>
        ) : (
          <>
            <p className="muted settings-help">
              Your data is saved in this browser only. MoneyLens&apos;s server can keep it in its database instead: one copy that
              every browser opening the app through the server shares, on this computer or another one, with earlier versions kept.
              This browser&apos;s own copy is set aside, not deleted.
            </p>
            <button className="btn-primary" onClick={handleMove} disabled={busy || !hasData}>
              Move This Browser&apos;s Data to the Server
            </button>
            {!hasData && <p className="muted mt-12">There&apos;s nothing in this browser to move yet.</p>}
          </>
        )}
        {error && <p className="error-text mt-12">{error}</p>}
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Storage</h3>
      <p className="muted settings-help">
        Your data is saved in MoneyLens&apos;s database on the computer running the server. Every browser that opens the app through it
        shares the same copy, and each save is kept as a version you can go back to.
      </p>
      {versions === null ? (
        <button className="btn-secondary" onClick={handleShowVersions} disabled={busy}>Show Earlier Versions</button>
      ) : (
        <div className="import-preview storage-versions">
          <table>
            <thead>
              <tr><th>Saved</th><th>Transactions</th><th>Accounts</th><th>Note</th><th></th></tr>
            </thead>
            <tbody>
              {versions.map((v, i) => (
                <tr key={v.rev}>
                  <td>{formatSavedAt(v.savedAt)}</td>
                  <td>{v.transactions}</td>
                  <td>{v.accounts}</td>
                  <td className="desc-cell">{v.note || ''}</td>
                  <td>
                    {i === 0 ? <span className="muted">Current</span> : (
                      <ConfirmButton label="Restore" confirmLabel="Replace current data?" className="btn-icon" onConfirm={() => handleRestore(v)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ownCopy && (
        <div className="mt-12">
          <p className="muted settings-help">This browser&apos;s own copy from before it used the server is still kept here.</p>
          <div className="data-actions">
            <button className="btn-secondary" onClick={() => downloadJson(ownCopy, 'moneylens-browser-copy.json')}>Download It</button>
            <ConfirmButton label="Delete It" confirmLabel="Delete this browser's copy?" onConfirm={handleDiscardOwnCopy} />
          </div>
        </div>
      )}
      {error && <p className="error-text mt-12">{error}</p>}
    </div>
  );
}
