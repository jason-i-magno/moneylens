import { useState, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { formatCurrency } from '../constants/categories';
import { BUILTIN_BANK_PROFILES } from '../constants/bankProfiles';
import Modal from '../components/Modal';
import FileDropZone from '../components/FileDropZone';
import EmptyState from '../components/EmptyState';
import ConfirmButton from '../components/ConfirmButton';
import { buildBalanceTimeline, buildNetWorthHistory, loanBalancePoints } from '../utils/netWorth';
import { parseKeywordList } from '../utils/categorizer';
import { plaidSourceOptions } from '../utils/plaidSync';
import { todayISO } from '../utils/dates';

const ACCOUNT_CATEGORIES = [
  { id: 'bank', name: 'Bank Accounts', icon: '\u{1F3E6}', type: 'asset' },
  { id: 'investment', name: 'Investments', icon: '\u{1F4C8}', type: 'asset' },
  { id: 'property', name: 'Property', icon: '\u{1F3E0}', type: 'asset' },
  { id: 'debt', name: 'Debts', icon: '\u{1F4B3}', type: 'liability' },
];

const CATEGORY_MAP = Object.fromEntries(ACCOUNT_CATEGORIES.map((c) => [c.id, c]));

export default function NetWorth({ data, finance }) {
  const [modal, setModal] = useState(null);
  const [visible, setVisible] = useState({ netWorth: true, assets: false, liabilities: false });
  const [pdfResults, setPdfResults] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Both always exist: migrateData fills them in on load
  const nw = data.netWorth;
  const mortgages = data.mortgages;

  // Bank Sync sources too, so editing an account Bank Sync created keeps its link
  const bankProfileOptions = useMemo(
    () => [...Object.entries({ ...BUILTIN_BANK_PROFILES, ...(data.bankProfiles || {}) }), ...plaidSourceOptions(data.plaid)],
    [data.bankProfiles, data.plaid]
  );

  // Auto-derived values from mortgage data
  const autoDerived = useMemo(() => {
    const items = [];

    // Property values
    for (const prop of mortgages.properties) {
      items.push({
        id: `auto_prop_${prop.id}`,
        name: prop.address,
        type: 'asset',
        category: 'property',
        balance: prop.estimatedValue || prop.purchasePrice,
        date: prop.estimatedValueDate || prop.purchaseDate,
        auto: true,
      });
    }

    // Mortgage debts: the latest statement, or an estimate from the payments made since
    for (const loan of mortgages.loans) {
      if (loan.status !== 'active') continue;
      const latest = loanBalancePoints(loan, mortgages.payments, data.transactions || []).at(-1);
      items.push({
        id: `auto_loan_${loan.id}`,
        name: loan.label,
        type: 'liability',
        category: 'debt',
        balance: latest?.balance ?? loan.loanAmount,
        date: latest?.date ?? null,
        estimated: !!latest?.estimated,
        auto: true,
      });
    }

    return items;
  }, [mortgages, data.transactions]);

  // Snapshots plus, for linked accounts, transaction-derived daily balances
  const timelines = useMemo(() => {
    const transactions = data.transactions || [];
    return Object.fromEntries(nw.accounts.map((acct) => [acct.id, buildBalanceTimeline(acct, nw.snapshots, transactions)]));
  }, [nw.accounts, nw.snapshots, data.transactions]);

  // Accounts that single transfers are linked to (Other Account in the transaction edit form)
  const linkedTransferAccounts = useMemo(
    () => new Set((data.transactions || []).filter((t) => t.transferAccountId && t.category === 'transfers').map((t) => t.transferAccountId)),
    [data.transactions]
  );

  // All accounts with their most recent known balance
  const accountsWithBalances = useMemo(() => {
    const manual = nw.accounts.map((acct) => {
      const timeline = timelines[acct.id];
      const last = timeline[timeline.length - 1];
      return {
        ...acct,
        balance: last?.balance ?? 0,
        date: last?.date ?? null,
        auto: false,
      };
    });
    return [...manual, ...autoDerived];
  }, [nw.accounts, timelines, autoDerived]);

  // Totals
  const totalAssets = useMemo(
    () => accountsWithBalances.filter((a) => a.type === 'asset').reduce((s, a) => s + a.balance, 0),
    [accountsWithBalances]
  );
  const totalLiabilities = useMemo(
    () => accountsWithBalances.filter((a) => a.type === 'liability').reduce((s, a) => s + a.balance, 0),
    [accountsWithBalances]
  );
  const netWorthValue = totalAssets - totalLiabilities;

  // Chart data: each account's latest known balance on every date any of them changes
  const chartData = useMemo(
    () => buildNetWorthHistory(nw.accounts, timelines, mortgages, data.transactions || []),
    [nw.accounts, timelines, mortgages, data.transactions]
  );

  // Grouped accounts
  const grouped = useMemo(() => {
    const groups = {};
    for (const cat of ACCOUNT_CATEGORIES) {
      const accts = accountsWithBalances.filter((a) => a.category === cat.id);
      if (accts.length > 0) groups[cat.id] = accts;
    }
    return groups;
  }, [accountsWithBalances]);

  // Handlers
  const handleSaveAccount = (form) => {
    if (modal?.editing) {
      finance.updateAccount(modal.editing.id, form);
    } else {
      finance.addAccount(form);
    }
    setModal(null);
  };

  const handleSaveSnapshot = (form) => {
    finance.addSnapshots([{
      ...form,
      balance: parseFloat(form.balance) || 0,
      source: 'manual',
    }]);
    setModal(null);
  };

  const handlePdfUpload = async (files) => {
    setPdfLoading(true);
    setPdfResults([]);
    try {
      const { parseBankStatementPdfs } = await import('../utils/mortgagePdfParser.js');
      const results = await parseBankStatementPdfs(files);

      // Auto-match to existing accounts: by linked bank profile first, then name
      for (const r of results) {
        if (!r.parsed) continue;
        // Match by linked bank profile (e.g. 'usbank_checking')
        const profileMatch = r.bank ? nw.accounts.find((a) => a.linkedBankProfile === `${r.bank}_checking` || a.linkedBankProfile === `${r.bank}_credit`) : null;
        // Match by exact name
        const nameMatch = nw.accounts.find((a) => a.name === r.accountName);
        // Match by partial name (e.g. "US Bank Checking" matches "US Bank Checking 1234")
        const partialMatch = nw.accounts.find((a) => a.name && r.accountName && (a.name.includes(r.accountName) || r.accountName.includes(a.name)));
        r.matchedAccountId = profileMatch?.id || nameMatch?.id || partialMatch?.id || null;
      }
      setPdfResults(results);
    } catch (err) {
      setPdfResults(files.map((f) => ({ fileName: f.name, bank: 'unknown', parsed: false, snapshot: null, error: err.message })));
    }
    setPdfLoading(false);
  };

  const handleImportPdfSnapshots = () => {
    const createdByName = {}; // several statements for the same new account share one account
    const seen = new Set(nw.snapshots.map((s) => `${s.accountId}|${s.date}|${s.balance}`));
    const newSnapshots = [];

    for (const r of pdfResults.filter((res) => res.parsed)) {
      let accountId = r.matchedAccountId || createdByName[r.accountName];
      if (!accountId) {
        const linkedBankProfile = r.bank === 'usbank' ? 'usbank_checking' : null;
        accountId = finance.addAccount({ name: r.accountName, type: 'asset', category: 'bank', linkedBankProfile });
        createdByName[r.accountName] = accountId;
      }

      for (const snap of [r.beginSnapshot, r.snapshot]) {
        if (!snap) continue;
        const key = `${accountId}|${snap.date}|${snap.balance}`;
        if (seen.has(key)) continue; // same statement uploaded again
        seen.add(key);
        newSnapshots.push({ accountId, date: snap.date, balance: snap.balance, source: 'pdf_import' });
      }
    }

    finance.addSnapshots(newSnapshots);
    setPdfResults([]);
  };

  const toggle = (key) => setVisible((v) => ({ ...v, [key]: !v[key] }));

  const TOOLTIP_LABELS = { netWorth: 'Net Worth', assets: 'Total Assets', liabilities: 'Total Liabilities' };

  return (
    <div className="page net-worth">
      <h2>Net Worth</h2>

      <div className="summary-grid">
        <div className="summary-card">
          <span className="summary-label">Total Assets</span>
          <span className="summary-value">{formatCurrency(totalAssets)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Total Liabilities</span>
          <span className="summary-value">{formatCurrency(totalLiabilities)}</span>
        </div>
        <div className="summary-card accent">
          <span className="summary-label">Net Worth</span>
          <span className="summary-value">{formatCurrency(netWorthValue)}</span>
        </div>
      </div>

      {chartData.length > 1 && (
        <div className="card">
          <h3>Net Worth Over Time</h3>
          <div className="trends-toggles" style={{ marginBottom: 16 }}>
            <button
              className={`trend-toggle ${visible.netWorth ? 'active' : ''}`}
              style={visible.netWorth ? { backgroundColor: '#E8E4DD', color: '#1A1A1F' } : {}}
              onClick={() => toggle('netWorth')}
            >Net Worth</button>
            <button
              className={`trend-toggle ${visible.assets ? 'active' : ''}`}
              style={visible.assets ? { backgroundColor: '#7CE8A333', color: '#7CE8A3', borderColor: '#7CE8A3' } : {}}
              onClick={() => toggle('assets')}
            >Assets</button>
            <button
              className={`trend-toggle ${visible.liabilities ? 'active' : ''}`}
              style={visible.liabilities ? { backgroundColor: '#E8927C33', color: '#E8927C', borderColor: '#E8927C' } : {}}
              onClick={() => toggle('liabilities')}
            >Liabilities</button>
          </div>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={chartData} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333338" />
              <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#6b7280" width={100} />
              <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
              <Tooltip
                formatter={(value, name) => [formatCurrency(value), TOOLTIP_LABELS[name] || name]}
                contentStyle={{ backgroundColor: '#222228', border: '1px solid #333', borderRadius: 8 }}
                labelStyle={{ color: '#E8E4DD' }}
                itemSorter={(item) => -item.value}
              />
              {visible.netWorth && <Line type="monotone" dataKey="netWorth" name="netWorth" stroke="#E8E4DD" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />}
              {visible.assets && <Line type="monotone" dataKey="assets" name="assets" stroke="#7CE8A3" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}
              {visible.liabilities && <Line type="monotone" dataKey="liabilities" name="liabilities" stroke="#E8927C" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card">
        <h3>Upload Bank Statements</h3>
        <p className="muted" style={{ marginBottom: 12 }}>Upload US Bank statement PDFs to extract account balances.</p>
        <FileDropZone onFiles={handlePdfUpload} multiple accept=".pdf" label="Drop bank statement PDFs here or" />
        {pdfLoading && <p style={{ marginTop: 12 }}>Parsing PDF...</p>}
        {pdfResults.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h4>Extracted Balances</h4>
            <div className="amort-table-wrap">
              <table className="amort-table">
                <thead>
                  <tr><th>File</th><th>Account</th><th>Begin Balance</th><th>End Balance</th><th>End Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {pdfResults.map((r, i) => (
                    <tr key={i} className={r.parsed ? 'has-actual' : 'row-invalid'}>
                      <td>{r.fileName}</td>
                      <td>{r.accountName || '-'}</td>
                      <td>{r.beginSnapshot ? formatCurrency(r.beginSnapshot.balance) : '-'}</td>
                      <td>{r.snapshot ? formatCurrency(r.snapshot.balance) : '-'}</td>
                      <td>{r.snapshot?.date || '-'}</td>
                      <td>
                        {!r.parsed && <span className="badge-error">{r.error || 'Parse Error'}</span>}
                        {r.parsed && r.matchedAccountId && <span className="badge-active">Existing</span>}
                        {r.parsed && !r.matchedAccountId && <span className="tx-badge">New Account</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-actions" style={{ marginTop: 12 }}>
              <button className="btn-primary" onClick={handleImportPdfSnapshots}>
                Import {pdfResults.filter((r) => r.parsed).length} Balance{pdfResults.filter((r) => r.parsed).length !== 1 ? 's' : ''}
              </button>
              <button className="btn-secondary" onClick={() => setPdfResults([])}>Clear</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="amort-header">
          <h3>Accounts</h3>
          <button className="btn-primary" onClick={() => setModal({ type: 'account' })}>+ Account</button>
        </div>

        {accountsWithBalances.length === 0 ? (
          <EmptyState icon={'\u{1F4B0}'} message="No accounts yet. Add accounts to track your net worth." />
        ) : (
          Object.entries(grouped).map(([catId, accts]) => {
            const cat = CATEGORY_MAP[catId];
            return (
              <div key={catId} className="nw-category">
                <h4 className="nw-category-title">{cat.icon} {cat.name}</h4>
                {accts.map((acct) => (
                  <div key={acct.id} className="nw-account-row" onClick={() => !acct.auto && setModal({ type: 'snapshot', account: acct })}>
                    <div className="nw-account-info">
                      <span className="nw-account-name">{acct.name}</span>
                      <span className="nw-account-meta">
                        {acct.date ? `Updated ${acct.date}` : 'No data'}
                        {acct.auto && <span className="tx-badge">AUTO</span>}
                        {acct.estimated && <span className="tx-badge sub" title="Estimated from the payments made since the latest statement">EST</span>}
                        {acct.linkedBankProfile && <span className="tx-badge sub">LIVE</span>}
                        {(acct.transferKeywords?.length > 0 || linkedTransferAccounts.has(acct.id)) && (
                          <span className="tx-badge sub" title={acct.transferKeywords?.length ? `Follows transfers matching: ${acct.transferKeywords.join(', ')}` : 'Follows the transfers linked to it'}>FOLLOWS</span>
                        )}
                      </span>
                    </div>
                    <div className="nw-account-balance-wrap">
                      <span className={`nw-account-balance ${acct.type === 'liability' ? 'liability' : ''}`}>
                        {acct.type === 'liability' && acct.balance > 0 ? '-' : ''}{formatCurrency(acct.balance)}
                      </span>
                    </div>
                    {!acct.auto && (
                      <div className="tx-actions">
                        <button className="btn-icon" onClick={(e) => { e.stopPropagation(); setModal({ type: 'account', editing: acct }); }}>Edit</button>
                        <ConfirmButton
                          className="btn-icon danger"
                          label="Del"
                          confirmLabel="Delete account + balances?"
                          onConfirm={() => finance.deleteAccount(acct.id)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      <Modal isOpen={modal?.type === 'account'} onClose={() => setModal(null)} title={modal?.editing ? 'Edit Account' : 'Add Account'}>
        <AccountForm account={modal?.editing} bankProfiles={bankProfileOptions} onSave={handleSaveAccount} />
      </Modal>

      <Modal isOpen={modal?.type === 'snapshot'} onClose={() => setModal(null)} title={`Balances — ${modal?.account?.name || ''}`}>
        <SnapshotList
          snapshots={nw.snapshots.filter((s) => s.accountId === modal?.account?.id)}
          onDelete={finance.deleteSnapshot}
        />
        <SnapshotForm account={modal?.account} onSave={handleSaveSnapshot} />
      </Modal>
    </div>
  );
}

function SnapshotList({ snapshots, onDelete }) {
  if (snapshots.length === 0) return null;
  const sorted = [...snapshots].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="snapshot-list">
      {sorted.map((s) => (
        <div key={s.id} className="profile-row">
          <span>{s.date} &middot; {formatCurrency(s.balance)}{s.source === 'pdf_import' && <span className="tx-badge">PDF</span>}{s.source === 'plaid' && <span className="tx-badge">SYNC</span>}</span>
          <button className="btn-icon danger" onClick={() => onDelete(s.id)}>Del</button>
        </div>
      ))}
    </div>
  );
}

function AccountForm({ account, bankProfiles, onSave }) {
  const [form, setForm] = useState(account || { name: '', type: 'asset', category: 'bank', linkedBankProfile: '' });
  const [keywords, setKeywords] = useState((account?.transferKeywords || []).join(', '));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = () => onSave({ ...form, transferKeywords: parseKeywordList(keywords) });

  const handleCategoryChange = (e) => {
    const cat = CATEGORY_MAP[e.target.value];
    setForm((f) => ({ ...f, category: e.target.value, type: cat?.type || f.type }));
  };

  return (
    <>
      <div className="form-group"><label>Name</label><input value={form.name} onChange={set('name')} placeholder="e.g. US Bank Checking" /></div>
      <div className="form-group">
        <label>Category</label>
        <select value={form.category} onChange={handleCategoryChange}>
          {ACCOUNT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>Type</label>
        <select value={form.type} onChange={set('type')}>
          <option value="asset">Asset</option>
          <option value="liability">Liability</option>
        </select>
      </div>
      <div className="form-group">
        <label>Linked Bank Profile (auto-update balance from imports)</label>
        <select value={form.linkedBankProfile || ''} onChange={set('linkedBankProfile')}>
          <option value="">None</option>
          {bankProfiles.map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label>Follow transfers matching (keywords, comma-separated)</label>
        <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="e.g. 1234, my brokerage" />
        <p className="muted settings-help">
          For an account that isn&apos;t imported or synced: moves to or from it in your other accounts update its balance,
          so they don&apos;t look like money appearing or disappearing. Single transfers can also be linked to it when you edit them
          on the Spending or Income page. Add one balance you know afterwards (0 for a closed account).
        </p>
      </div>
      <button className="btn-primary" onClick={handleSave}>Save</button>
    </>
  );
}

function SnapshotForm({ account, onSave }) {
  const [form, setForm] = useState({
    accountId: account?.id || '',
    date: todayISO(),
    balance: '',
  });
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <div className="form-group"><label>Date</label><input type="date" value={form.date} onChange={set('date')} /></div>
      <div className="form-group"><label>Balance</label><input type="number" step="0.01" value={form.balance} onChange={set('balance')} placeholder="15000.00" /></div>
      <button className="btn-primary" onClick={() => onSave(form)}>Save</button>
    </>
  );
}
