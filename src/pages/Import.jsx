import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import FileDropZone from '../components/FileDropZone';
import ColumnMapper from '../components/ColumnMapper';
import ImportPreviewTable from '../components/ImportPreviewTable';
import { parseCSVFile, transformRows } from '../utils/csvParser';
import { categorizeBatch, getEffectiveKeywords } from '../utils/categorizer';
import { findDuplicates } from '../utils/duplicateDetector';
import { formatCurrency } from '../constants/categories';
import { BUILTIN_BANK_PROFILES, detectProfileFromFilename, PROFILE_ACCOUNT_MAP } from '../constants/bankProfiles';

const STEPS = ['Upload', 'Map Columns', 'Preview', 'Confirm'];

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function buildPreview(entries, keywords, existingTransactions) {
  let index = 0;
  const rows = entries.flatMap((entry) =>
    transformRows(entry.rawData.data, entry.mapping).map((tx) => ({
      ...tx,
      index: index++,
      sourceFile: entry.fileName,
      profileId: entry.profileId,
    }))
  );
  const categorized = categorizeBatch(rows, keywords);
  // Suspected duplicates start out skipped; the user can include them per row or all at once
  return findDuplicates(categorized, existingTransactions).map((tx) => ({ ...tx, skip: tx.isDuplicate }));
}

export default function Import({ data, finance }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  // Each entry: { fileName, rawData, profileId, mapping, saveName }
  const [fileEntries, setFileEntries] = useState([]);
  const [mappingIndex, setMappingIndex] = useState(null);
  const [transactions, setTransactions] = useState([]);

  const allProfiles = useMemo(() => ({
    ...BUILTIN_BANK_PROFILES,
    ...(data.bankProfiles || {}),
  }), [data.bankProfiles]);

  const profileEntries = Object.entries(allProfiles);

  const keywords = useMemo(
    () => getEffectiveKeywords(data.categoryKeywords, data.removedKeywords),
    [data.categoryKeywords, data.removedKeywords]
  );

  // Step 0: Add files
  const handleFiles = async (files) => {
    const newEntries = [];
    for (const file of files) {
      const rawData = await parseCSVFile(file);
      const detectedId = detectProfileFromFilename(file.name);
      newEntries.push({
        fileName: file.name,
        rawData,
        profileId: detectedId,
        mapping: allProfiles[detectedId] || null,
        saveName: '',
      });
    }
    setFileEntries((prev) => [...prev, ...newEntries]);
  };

  const handleProfileChange = (index, profileId) => {
    setFileEntries((prev) => prev.map((entry, i) => (
      i === index ? { ...entry, profileId, mapping: allProfiles[profileId] || null, saveName: '' } : entry
    )));
  };

  const removeFile = (index) => {
    setFileEntries((prev) => prev.filter((_, i) => i !== index));
  };

  // Always build from the entries passed in — state set in the same handler isn't visible yet
  const goToPreview = (entries) => {
    setTransactions(buildPreview(entries, keywords, data.transactions));
    setStep(2);
  };

  const handleContinue = () => {
    const idx = fileEntries.findIndex((e) => !e.mapping);
    if (idx !== -1) {
      setMappingIndex(idx);
      setStep(1);
    } else {
      goToPreview(fileEntries);
    }
  };

  // Step 1: Column mapping for files without a profile
  const handleMapping = (mapping, saveName) => {
    const profileId = saveName ? slugify(saveName) : '';
    const next = fileEntries.map((entry, i) => (
      i === mappingIndex ? { ...entry, mapping, profileId, saveName: profileId ? saveName : '' } : entry
    ));
    setFileEntries(next);

    const nextIdx = next.findIndex((e) => !e.mapping);
    if (nextIdx !== -1) {
      setMappingIndex(nextIdx);
    } else {
      goToPreview(next);
    }
  };

  // Step 2: Preview
  const handleCategoryChange = (index, category) => {
    setTransactions((prev) =>
      prev.map((tx) => (tx.index === index ? { ...tx, category } : tx))
    );
  };

  const handleToggleSkip = (index) => {
    setTransactions((prev) =>
      prev.map((tx) => (tx.index === index ? { ...tx, skip: !tx.skip } : tx))
    );
  };

  const setDuplicatesSkipped = (skip) => {
    setTransactions((prev) => prev.map((tx) => (tx.isDuplicate ? { ...tx, skip } : tx)));
  };

  const importable = useMemo(
    () => transactions.filter((tx) => tx.valid && !tx.skip),
    [transactions]
  );

  const duplicateCount = transactions.filter((tx) => tx.isDuplicate).length;
  const skippedDuplicateCount = transactions.filter((tx) => tx.isDuplicate && tx.skip).length;

  const totalAmount = useMemo(
    () => importable.reduce((s, tx) => s + tx.amount, 0),
    [importable]
  );

  const profilesToSave = fileEntries.filter((e) => e.saveName && e.mapping);

  // Step 3: Confirm & import
  const handleImport = () => {
    finance.importTransactions(importable);

    for (const entry of profilesToSave) {
      const m = entry.mapping;
      finance.saveBankProfile(entry.profileId, {
        name: entry.saveName,
        dateColumn: m.dateColumn,
        descriptionColumn: m.descriptionColumn,
        amountColumn: m.amountColumn,
        amountFormat: m.amountFormat,
        dateFormat: m.dateFormat,
        categoryColumn: m.categoryColumn || null,
        debitColumn: m.debitColumn || null,
        creditColumn: m.creditColumn || null,
        skipHeaderRows: 0,
      });
    }

    // Auto-create a linked net worth account the first time a known bank is imported
    const linkedProfiles = new Set(data.netWorth.accounts.map((a) => a.linkedBankProfile));
    const usedProfiles = new Set(fileEntries.map((e) => e.profileId).filter(Boolean));
    for (const profileId of usedProfiles) {
      const acctMeta = PROFILE_ACCOUNT_MAP[profileId];
      if (!acctMeta || linkedProfiles.has(profileId)) continue;
      finance.addAccount({ ...acctMeta, linkedBankProfile: profileId });
    }

    navigate('/spending');
  };

  const currentMappingEntry = mappingIndex !== null ? fileEntries[mappingIndex] : null;
  const fileCountLabel = `${fileEntries.length} file${fileEntries.length > 1 ? 's' : ''}`;

  return (
    <div className="page import">
      <h2>Import Transactions</h2>

      <div className="steps-bar">
        {STEPS.map((s, i) => (
          <span key={s} className={`step ${i === step ? 'active' : i < step ? 'done' : ''}`}>
            {s}
          </span>
        ))}
      </div>

      {step === 0 && (
        <div className="card">
          <FileDropZone onFiles={handleFiles} multiple />

          {fileEntries.length > 0 && (
            <div className="file-list">
              {fileEntries.map((entry, i) => (
                <div key={i} className="file-entry">
                  <div className="file-entry-header">
                    <span className="file-name">{entry.fileName}</span>
                    <button className="btn-icon danger" onClick={() => removeFile(i)}>Remove</button>
                  </div>
                  <div className="form-group">
                    <label>Bank Profile</label>
                    <select value={entry.profileId} onChange={(e) => handleProfileChange(i, e.target.value)}>
                      <option value="">New Bank (manual mapping)</option>
                      {entry.saveName && <option value={entry.profileId}>{entry.saveName} (new)</option>}
                      {profileEntries.map(([id, p]) => (
                        <option key={id} value={id}>{p.name}{p.builtin ? ' (built-in)' : ''}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
              <button className="btn-primary" onClick={handleContinue}>
                Continue
              </button>
            </div>
          )}
        </div>
      )}

      {step === 1 && currentMappingEntry && (
        <div className="card">
          <h3>Map Columns — {currentMappingEntry.fileName}</h3>
          <ColumnMapper
            key={mappingIndex}
            headers={currentMappingEntry.rawData.meta.fields || []}
            rows={currentMappingEntry.rawData.data}
            onSubmit={handleMapping}
          />
          <button className="btn-secondary mt-12" onClick={() => setStep(0)}>Back</button>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>Preview ({transactions.length} transactions from {fileCountLabel})</h3>
          <p className="preview-summary">
            {importable.length} to import &middot; {formatCurrency(totalAmount)} total
            {duplicateCount > 0 && <span className="badge-warn"> &middot; {duplicateCount} suspected duplicates</span>}
          </p>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setStep(0)}>Back</button>
            <button className="btn-primary" onClick={() => setStep(3)}>Continue</button>
          </div>
          <ImportPreviewTable
            transactions={transactions}
            onCategoryChange={handleCategoryChange}
            onToggleSkip={handleToggleSkip}
          />
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setStep(0)}>Back</button>
            <button className="btn-primary" onClick={() => setStep(3)}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3>Confirm Import</h3>
          <p>Importing <strong>{importable.length}</strong> transactions totaling <strong>{formatCurrency(totalAmount)}</strong> from {fileCountLabel}.</p>
          {duplicateCount > 0 && (
            <div className="duplicate-choice">
              <p className="warn-text">
                {skippedDuplicateCount > 0
                  ? `${skippedDuplicateCount} of ${duplicateCount} suspected duplicates will be skipped.`
                  : `All ${duplicateCount} suspected duplicates will be imported.`}
              </p>
              {skippedDuplicateCount > 0 && (
                <button className="btn-secondary" onClick={() => setDuplicatesSkipped(false)}>Import duplicates anyway</button>
              )}
              {skippedDuplicateCount < duplicateCount && (
                <button className="btn-secondary" onClick={() => setDuplicatesSkipped(true)}>Skip all duplicates</button>
              )}
            </div>
          )}
          {profilesToSave.length > 0 && (
            <p className="muted">Will save bank profile{profilesToSave.length > 1 ? 's' : ''}: {profilesToSave.map((e) => e.saveName).join(', ')}</p>
          )}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={() => setStep(2)}>Back</button>
            <button className="btn-primary" onClick={handleImport}>
              Import {importable.length} Transactions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
