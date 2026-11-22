import { useEffect, useMemo, useState } from 'react';
import SummaryCard from '../components/SummaryCard';
import FileDropZone from '../components/FileDropZone';
import Modal from '../components/Modal';
import ConfirmButton from '../components/ConfirmButton';
import { formatCurrency } from '../constants/categories';
import { addDays, todayISO } from '../utils/dates';
import { RECEIPT_CATEGORIES, missingReceipts, receiptTotals, receiptsOf, suggestPayments } from '../utils/hsa';
import { RECEIPT_ACCEPT, RECEIPT_MAX_BYTES, fileToBase64, receiptFileUrl, receiptsRequest } from '../utils/receiptsClient';

const BLANK = { provider: '', serviceDate: '', amount: '', patient: '', category: 'doctor', description: '', eligible: 'yes', notes: '', transactionId: '' };
const CATEGORY_NAME = Object.fromEntries(RECEIPT_CATEGORIES.map((c) => [c.id, c.name]));
const ELIGIBILITY = [
  { id: 'yes', name: 'Yes' },
  { id: 'unsure', name: 'Not sure' },
  { id: 'no', name: 'No' },
];
const MISSING_SHOWN = 20;

// Keys for receipts being added (not saved yet), unique within the page's lifetime
let pendingSeq = 0;
const pendingKey = () => `pending_${++pendingSeq}`;

// Claude's reading as form values (it checks dates and categories; the person checks the rest)
function fieldsFrom(read) {
  return {
    provider: read.provider || '',
    serviceDate: /^\d{4}-\d{2}-\d{2}$/.test(read.serviceDate || '') ? read.serviceDate : '',
    amount: read.amount > 0 ? String(read.amount) : '',
    patient: read.patient || '',
    category: CATEGORY_NAME[read.category] ? read.category : 'other',
    description: read.description || '',
    eligible: ['yes', 'no', 'unsure'].includes(read.eligible) ? read.eligible : 'unsure',
    notes: read.notes || '',
    transactionId: '',
  };
}

// Form values as the stored receipt fields
const receiptFrom = (form) => ({
  provider: form.provider.trim(),
  serviceDate: form.serviceDate || '',
  amount: Math.round((Number(form.amount) || 0) * 100) / 100,
  patient: form.patient.trim(),
  category: form.category,
  description: form.description.trim(),
  eligible: form.eligible,
  notes: form.notes.trim(),
  transactionId: form.transactionId || undefined,
});

const formFrom = (receipt) => ({ ...BLANK, ...receipt, amount: String(receipt.amount ?? ''), transactionId: receipt.transactionId || '' });

const paymentLabel = (tx) => `${tx.date} · ${tx.name} · ${formatCurrency(tx.amount)}`;

// One receipt's details; suggests the payment it was paid with from same-amount spending around its date
function ReceiptForm({ initial, receiptId, receipts, transactions, today, preview, notice, saveLabel, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const suggestions = suggestPayments({ id: receiptId, amount: form.amount, serviceDate: form.serviceDate }, transactions, receipts, today);
  const linked = form.transactionId ? transactions.find((t) => t.id === form.transactionId) : null;
  const payments = linked && !suggestions.includes(linked) ? [linked, ...suggestions] : suggestions;
  const valid = form.provider.trim() && Number(form.amount) > 0;

  return (
    <div className="receipt-review">
      {preview && <div className="receipt-preview">{preview}</div>}
      <div>
        {notice && <p className="muted settings-help">{notice}</p>}
        <div className="receipt-form-grid">
          <div className="form-group"><label>Provider or store</label><input value={form.provider} onChange={set('provider')} placeholder="e.g. Family clinic" /></div>
          <div className="form-group"><label>Date of service</label><input type="date" value={form.serviceDate} onChange={set('serviceDate')} /></div>
          <div className="form-group"><label>Amount you paid</label><input type="number" step="0.01" min="0" value={form.amount} onChange={set('amount')} placeholder="45.00" /></div>
          <div className="form-group"><label>Patient</label><input value={form.patient} onChange={set('patient')} /></div>
          <div className="form-group">
            <label>Kind</label>
            <select value={form.category} onChange={set('category')}>
              {RECEIPT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>HSA eligible</label>
            <select value={form.eligible} onChange={set('eligible')}>
              {ELIGIBILITY.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="form-group receipt-form-wide"><label>Description</label><input value={form.description} onChange={set('description')} placeholder="e.g. Office visit copay" /></div>
          <div className="form-group receipt-form-wide">
            <label>Paid with</label>
            <select value={form.transactionId} onChange={set('transactionId')}>
              <option value="">{payments.length ? 'Not linked to a payment' : 'No matching payment found'}</option>
              {payments.map((tx) => <option key={tx.id} value={tx.id}>{paymentLabel(tx)}</option>)}
            </select>
          </div>
          <div className="form-group receipt-form-wide"><label>Notes</label><input value={form.notes} onChange={set('notes')} /></div>
        </div>
        <div className="data-actions">
          <button className="btn-primary" onClick={() => onSave(receiptFrom(form))} disabled={!valid}>{saveLabel}</button>
          <button className="btn-secondary" onClick={onCancel}>{receiptId ? 'Cancel' : 'Discard'}</button>
        </div>
      </div>
    </div>
  );
}

// A receipt's status, for the list
function statusOf(r) {
  if (r.reimbursedAt) return { label: `Reimbursed ${r.reimbursedAt}`, tone: 'done' };
  if (r.eligible === 'no') return { label: 'Not eligible', tone: 'off' };
  if (r.eligible === 'unsure') return { label: 'Check eligibility', tone: 'warn' };
  return { label: 'Can reimburse', tone: 'good' };
}

export default function HsaReceipts({ data, addReceipt, updateReceipt, deleteReceipt }) {
  const receipts = receiptsOf(data);
  const transactions = useMemo(() => data.transactions || [], [data.transactions]);
  const today = todayISO();
  const [server, setServer] = useState({ state: 'checking' });
  // Uploaded (or started by hand) but not saved yet: { key, fileId, fileName, mime, previewUrl, status, error, readBy, fields }
  const [pending, setPending] = useState([]);
  const [uploadError, setUploadError] = useState('');
  const [editing, setEditing] = useState(null);
  const [reimbursing, setReimbursing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    receiptsRequest('status').then(
      (status) => setServer({ state: 'ready', ...status }),
      (err) => setServer({ state: err.code === 'NO_SERVER' ? 'unavailable' : 'error', message: err.message })
    );
  }, []);

  const totals = receiptTotals(receipts);
  const missing = useMemo(() => missingReceipts(transactions, receipts, addDays(today, -730)), [transactions, receipts, today]);
  const txById = useMemo(() => new Map(transactions.map((t) => [t.id, t])), [transactions]);
  const sorted = [...receipts].sort((a, b) => (b.serviceDate || b.createdAt || '').localeCompare(a.serviceDate || a.createdAt || ''));

  const updatePending = (key, changes) => setPending((list) => list.map((p) => (p.key === key ? { ...p, ...changes } : p)));
  const dropPending = (item) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setPending((list) => list.filter((p) => p.key !== item.key));
  };

  const handleFiles = async (files) => {
    setUploadError('');
    for (const file of files) {
      if (!RECEIPT_ACCEPT.split(',').includes(file.type)) {
        setUploadError(`${file.name}: receipts can be JPEG, PNG, WebP or GIF photos, or PDFs.`);
        continue;
      }
      if (file.size > RECEIPT_MAX_BYTES) {
        setUploadError(`${file.name} is over 15 MB.`);
        continue;
      }
      const key = pendingKey();
      setPending((list) => [...list, { key, fileName: file.name, mime: file.type, previewUrl: URL.createObjectURL(file), status: 'uploading', fields: BLANK }]);
      try {
        const { fileId } = await receiptsRequest('upload', { name: file.name, mime: file.type, data: await fileToBase64(file) });
        updatePending(key, { fileId, status: server.reading ? 'reading' : 'ready' });
        if (!server.reading) continue;
        try {
          const read = await receiptsRequest('read', { fileId });
          updatePending(key, { status: 'ready', readBy: read.model, fields: fieldsFrom(read) });
        } catch (err) {
          updatePending(key, { status: 'ready', error: err.message });
        }
      } catch (err) {
        updatePending(key, { status: 'failed', error: err.message });
      }
    }
  };

  const addByHand = () => setPending((list) => [...list, { key: pendingKey(), status: 'ready', fields: BLANK }]);

  const savePending = (item, fields) => {
    addReceipt({ ...fields, ...(item.fileId && { fileId: item.fileId, fileName: item.fileName, mime: item.mime }), ...(item.readBy && { readBy: item.readBy }) });
    dropPending(item);
  };

  const discardPending = (item) => {
    if (item.fileId) receiptsRequest('delete', { fileId: item.fileId }).catch(() => {});
    dropPending(item);
  };

  const removeReceipt = async (receipt) => {
    setActionError('');
    try {
      if (receipt.fileId) await receiptsRequest('delete', { fileId: receipt.fileId });
      deleteReceipt(receipt.id);
    } catch (err) {
      setActionError(`Couldn't delete the receipt file: ${err.message}`);
    }
  };

  const viewReceipt = async (receipt) => {
    setActionError('');
    try {
      setViewing({ ...(await receiptFileUrl(receipt.fileId)), name: receipt.fileName || receipt.provider });
    } catch (err) {
      setActionError(`Couldn't open the receipt: ${err.message}`);
    }
  };

  const closeViewer = () => {
    if (viewing) URL.revokeObjectURL(viewing.url);
    setViewing(null);
  };

  const previewOf = (item) => {
    if (!item.previewUrl) return null;
    return item.mime === 'application/pdf'
      ? <a href={item.previewUrl} target="_blank" rel="noreferrer" className="receipt-pdf">PDF: {item.fileName}</a>
      : <img src={item.previewUrl} alt={item.fileName} />;
  };

  const noticeOf = (item) => {
    if (item.error) return item.error;
    if (item.readBy) return 'Read by Claude: check each field before saving.';
    if (item.fileId && !server.reading) return 'Enter the receipt details from the file.';
    return null;
  };

  return (
    <div className="page hsa-receipts">
      <div className="page-header">
        <div>
          <h2>HSA Receipts</h2>
          <p className="page-subtitle">
            Medical expenses you paid outside your HSA, after it was opened, can be reimbursed from it tax-free at any time, even years
            later, as long as you keep the receipt. Photos and PDFs are stored in MoneyLens&apos;s database on this computer, not in JSON
            exports.
          </p>
        </div>
      </div>

      <div className="summary-grid">
        <SummaryCard label="Can reimburse, tax-free" value={formatCurrency(totals.reimbursable)} accent note={totals.unsure > 0 ? `${formatCurrency(totals.unsure)} needs an eligibility check` : null} />
        <SummaryCard label="Reimbursed so far" value={formatCurrency(totals.reimbursed)} />
        <SummaryCard label="Receipts" value={String(totals.count)} />
      </div>

      <div className="card">
        <h3>Add Receipts</h3>
        {server.state === 'unavailable' || server.state === 'error' ? (
          <p className="error-text">{server.message}</p>
        ) : (
          <>
            {server.state === 'ready' && !server.reading && <p className="muted settings-help">{server.problem}</p>}
            {server.state === 'ready' && server.reading && (
              <p className="muted settings-help">Claude reads each receipt; you check the details before it&apos;s saved.</p>
            )}
            <FileDropZone onFiles={handleFiles} multiple accept={RECEIPT_ACCEPT} label="Drop receipt photos or PDFs here or" />
            {uploadError && <p className="error-text mt-12">{uploadError}</p>}
            <div className="data-actions mt-12">
              <button className="btn-secondary" onClick={addByHand}>Add by Hand</button>
            </div>
          </>
        )}
        {pending.map((item) => (
          <div key={item.key} className="receipt-pending">
            {item.status === 'uploading' && <p className="muted">Uploading {item.fileName}…</p>}
            {item.status === 'reading' && <p className="muted">Reading {item.fileName}…</p>}
            {item.status === 'failed' && (
              <div className="data-actions">
                <span className="error-text">{item.fileName}: {item.error}</span>
                <button className="btn-secondary" onClick={() => dropPending(item)}>Dismiss</button>
              </div>
            )}
            {item.status === 'ready' && (
              <ReceiptForm
                initial={item.fields}
                receipts={receipts}
                transactions={transactions}
                today={today}
                preview={previewOf(item)}
                notice={noticeOf(item)}
                saveLabel="Save Receipt"
                onSave={(fields) => savePending(item, fields)}
                onCancel={() => discardPending(item)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Receipts</h3>
        {actionError && <p className="error-text">{actionError}</p>}
        {sorted.length === 0 ? (
          <p className="muted">No receipts yet.</p>
        ) : (
          <div className="receipt-list">
            {sorted.map((r) => {
              const status = statusOf(r);
              const tx = r.transactionId ? txById.get(r.transactionId) : null;
              const meta = [r.serviceDate || 'No date', CATEGORY_NAME[r.category] || r.category, r.patient, tx && `paid ${tx.date} · ${tx.name}`];
              return (
                <div key={r.id} className="receipt-row">
                  <div className="receipt-main">
                    <div className="receipt-title">{r.provider}{r.description && <span className="muted"> · {r.description}</span>}</div>
                    <div className="receipt-meta">{meta.filter(Boolean).join(' · ')}</div>
                    {r.notes && <div className="receipt-meta">{r.notes}</div>}
                  </div>
                  <div className="receipt-side">
                    <span className="receipt-amount">{formatCurrency(r.amount)}</span>
                    <span className={`receipt-status ${status.tone}`}>{status.label}</span>
                  </div>
                  <div className="receipt-actions">
                    {r.fileId && <button className="btn-icon" onClick={() => viewReceipt(r)}>View</button>}
                    <button className="btn-icon" onClick={() => setEditing(r)}>Edit</button>
                    {r.reimbursedAt
                      ? <button className="btn-icon" onClick={() => updateReceipt(r.id, { reimbursedAt: undefined, reimbursedAmount: undefined })}>Undo</button>
                      : r.eligible !== 'no' && <button className="btn-icon" onClick={() => setReimbursing({ receipt: r, date: today, amount: String(r.amount) })}>Reimbursed</button>}
                    <ConfirmButton label="Del" confirmLabel="Delete receipt?" className="btn-icon danger" onConfirm={() => removeReceipt(r)} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {missing.length > 0 && (
        <div className="card">
          <h3>Medical Payments Without a Receipt</h3>
          <p className="muted settings-help">
            Health payments from the last two years with no receipt linked. Found one? Add it above: it suggests the matching payment.
          </p>
          {missing.slice(0, MISSING_SHOWN).map((tx) => (
            <div key={tx.id} className="profile-row">
              <span>{tx.date} · {tx.name}</span>
              <span>{formatCurrency(tx.amount)}</span>
            </div>
          ))}
          {missing.length > MISSING_SHOWN && <p className="muted mt-12">And {missing.length - MISSING_SHOWN} more.</p>}
        </div>
      )}

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title="Edit Receipt">
        {editing && (
          <ReceiptForm
            key={editing.id}
            initial={formFrom(editing)}
            receiptId={editing.id}
            receipts={receipts}
            transactions={transactions}
            today={today}
            saveLabel="Save Changes"
            onSave={(fields) => { updateReceipt(editing.id, fields); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>

      <Modal isOpen={!!reimbursing} onClose={() => setReimbursing(null)} title="Mark Reimbursed">
        {reimbursing && (
          <>
            <p className="muted settings-help">When you withdrew this from your HSA. Keep the receipt either way.</p>
            <div className="form-group"><label>Date</label><input type="date" value={reimbursing.date} onChange={(e) => setReimbursing((r) => ({ ...r, date: e.target.value }))} /></div>
            <div className="form-group"><label>Amount</label><input type="number" step="0.01" min="0" value={reimbursing.amount} onChange={(e) => setReimbursing((r) => ({ ...r, amount: e.target.value }))} /></div>
            <button
              className="btn-primary"
              disabled={!reimbursing.date || !(Number(reimbursing.amount) > 0)}
              onClick={() => {
                updateReceipt(reimbursing.receipt.id, { reimbursedAt: reimbursing.date, reimbursedAmount: Math.round(Number(reimbursing.amount) * 100) / 100 });
                setReimbursing(null);
              }}
            >Save</button>
          </>
        )}
      </Modal>

      <Modal isOpen={!!viewing} onClose={closeViewer} title={viewing?.name || 'Receipt'}>
        {viewing && (viewing.mime === 'application/pdf'
          ? <iframe className="receipt-viewer" src={viewing.url} title={viewing.name} />
          : <img className="receipt-viewer" src={viewing.url} alt={viewing.name} />)}
      </Modal>
    </div>
  );
}
