import { useEffect, useMemo, useState } from 'react';
import ConfirmButton from '../components/ConfirmButton';
import EmptyState from '../components/EmptyState';
import { BUILTIN_BANK_PROFILES } from '../constants/bankProfiles';
import { openPlaidLink, plaidRequest } from '../utils/plaidClient';
import {
  buildPlaidItem, defaultTargets, describePlaidAccount, latestImportedDate, plaidSourceId,
} from '../utils/plaidSync';

const TRIAL_LIMIT = 10;

// Errors that Plaid Link's update mode fixes by having the user log in or approve access again
const RECONNECT_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'ACCESS_NOT_GRANTED', 'ADDITIONAL_CONSENT_REQUIRED']);

const HISTORY_NOTES = {
  NOT_READY: "Plaid is still collecting this bank's transactions. Sync again in a few minutes.",
  INITIAL_UPDATE_COMPLETE: 'Recent transactions are in. Plaid is still loading older history (up to 2 years); sync again later to get it.',
};

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function summaryText(s) {
  const parts = [
    s.added && `${s.added} new`,
    s.updated && `${s.updated} updated`,
    s.removed && `${s.removed} removed`,
    s.skipped && `${s.skipped} already imported`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'nothing new';
}

const accountKind = (a) => [a.type, a.subtype].filter(Boolean).join(' · ');

export default function BankSync({ data, finance, plaidSync }) {
  const { server, refreshServer, syncItem, syncAll, syncingIds } = plaidSync;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingLink, setPendingLink] = useState(null); // a second connection to an already connected bank

  useEffect(() => {
    refreshServer();
  }, [refreshServer]);

  const profiles = useMemo(() => ({ ...BUILTIN_BANK_PROFILES, ...(data.bankProfiles || {}) }), [data.bankProfiles]);
  const items = data.plaid.items;
  const takenTargets = useMemo(
    () => new Set(items.flatMap((i) => i.accounts.map((a) => a.target)).filter(Boolean)),
    [items]
  );

  const ready = server.state === 'ready';
  const serverIds = new Set(server.items.map((i) => i.itemId));
  const mappedIds = new Set(items.map((i) => i.itemId));
  const needsSetup = server.items.filter((i) => !mappedIds.has(i.itemId));
  const connected = items.filter((i) => serverIds.has(i.itemId));
  const elsewhere = items.filter((i) => !serverIds.has(i.itemId));

  // Runs one user action with a busy flag and a single place for its error
  const run = async (action) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finishConnect = async ({ publicToken, metadata }) => {
    setPendingLink(null);
    await plaidRequest('exchange', {
      publicToken,
      institutionId: metadata.institution?.institution_id,
      institutionName: metadata.institution?.name,
    });
    await refreshServer();
  };

  const handleConnect = () => run(async () => {
    const { linkToken } = await plaidRequest('link-token');
    const linked = await openPlaidLink(linkToken);
    if (!linked) return;
    // Plaid counts a duplicate connection against the Trial limit, so ask before creating one
    const institutionId = linked.metadata.institution?.institution_id;
    const existing = institutionId && server.items.find((i) => i.institutionId === institutionId);
    if (existing) setPendingLink({ ...linked, institutionName: existing.institutionName });
    else await finishConnect(linked);
  });

  const handleStart = (item) => {
    finance.savePlaidItem(item);
    syncItem(item);
  };

  // Update mode keeps the same connection, so there's no token to exchange afterwards
  const handleReconnect = (item) => run(async () => {
    const { linkToken } = await plaidRequest('link-token', { itemId: item.itemId });
    if (!(await openPlaidLink(linkToken))) return;
    finance.setPlaidItemError(item.itemId, null);
    await syncItem({ ...item, lastError: null });
  });

  // Sandbox data is fake, so disconnecting deletes it; real transactions stay.
  // The server list is refreshed first: otherwise, for a moment, the connection would look like a
  // new one waiting for setup.
  const handleDisconnect = (itemId, env) => run(async () => {
    await plaidRequest('remove', { itemId });
    await refreshServer();
    finance.removePlaidItem(itemId, { deleteSyncedData: env !== 'production' });
  });

  // The connection stays on the server, so it comes back as "choose accounts"
  const handleRemap = (item) => finance.removePlaidItem(item.itemId, { deleteSyncedData: true });

  return (
    <div className="page bank-sync">
      <div className="page-header">
        <div>
          <h2>Bank Sync</h2>
          <p className="page-subtitle">Pull transactions and balances from your banks through Plaid instead of downloading CSVs.</p>
        </div>
        {ready && (
          <div className="page-header-actions">
            {connected.length > 0 && (
              <button className="btn-secondary" onClick={() => syncAll(serverIds)} disabled={syncingIds.length > 0}>
                {syncingIds.length > 0 ? 'Syncing…' : 'Sync All'}
              </button>
            )}
            <button className="btn-primary" onClick={handleConnect} disabled={busy}>+ Connect a Bank</button>
          </div>
        )}
      </div>

      <ServerStatus server={server} />
      {error && <p className="error-text">{error}</p>}

      {pendingLink && (
        <div className="card">
          <p className="warn-text">
            {pendingLink.institutionName} is already connected. Connecting it again creates a second connection
            {server.env === 'production' ? ', which uses another of your free Plaid Trial connections.' : '.'}
          </p>
          <div className="data-actions mt-12">
            <button className="btn-primary" onClick={() => run(() => finishConnect(pendingLink))} disabled={busy}>Connect Anyway</button>
            <button className="btn-secondary" onClick={() => setPendingLink(null)}>Cancel</button>
          </div>
        </div>
      )}

      {ready && needsSetup.map((s) => (
        <AccountSetup
          key={s.itemId}
          serverItem={s}
          env={server.env}
          transactions={data.transactions}
          profiles={profiles}
          takenTargets={takenTargets}
          busy={busy}
          onStart={handleStart}
          onDisconnect={() => handleDisconnect(s.itemId, server.env)}
        />
      ))}

      {ready && connected.map((item) => (
        <ConnectedBank
          key={item.itemId}
          item={item}
          profiles={profiles}
          syncing={syncingIds.includes(item.itemId)}
          busy={busy}
          onSync={() => syncItem(item)}
          onReconnect={() => handleReconnect(item)}
          onRemap={() => handleRemap(item)}
          onDisconnect={() => handleDisconnect(item.itemId, item.env)}
        />
      ))}

      {ready && elsewhere.map((item) => (
        <div key={item.itemId} className="card">
          <div className="bank-item-header">
            <h3>{item.institutionName}</h3>
            <ConfirmButton
              className="btn-secondary"
              label="Forget"
              confirmLabel="Forget it? Its transactions stay"
              onConfirm={() => finance.removePlaidItem(item.itemId)}
            />
          </div>
          <p className="muted">
            Not connected with the current Plaid keys. Bank access keys stay on the computer that made the
            connection{item.env !== server.env ? `, and this one was made in ${item.env}` : ''}.
          </p>
        </div>
      ))}

      {ready && needsSetup.length + items.length === 0 && (
        <div className="card">
          <EmptyState icon={'\u{1F3E6}'} message="No banks connected yet. Use Connect a Bank to link one through Plaid." />
        </div>
      )}
    </div>
  );
}

function ServerStatus({ server }) {
  if (server.state === 'checking') {
    return <div className="card"><p className="muted">Checking the local server…</p></div>;
  }

  if (server.state === 'unavailable' || server.state === 'error') {
    return (
      <div className="card">
        <h3>Local server not reachable</h3>
        <p className="muted settings-help">{server.message}</p>
        <p className="muted">
          Bank Sync keeps your Plaid keys and bank access keys on this computer, so it only works when MoneyLens runs
          locally with <code>npm run dev</code> or <code>npm run preview</code>, not from a static website.
        </p>
      </div>
    );
  }

  if (server.state === 'unconfigured') {
    return (
      <div className="card">
        <h3>Set Up Plaid</h3>
        {server.problem && <p className="warn-text settings-help">{server.problem}</p>}
        <ol className="setup-steps">
          <li>
            Sign up at <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noreferrer">dashboard.plaid.com</a> and
            apply for the free Trial plan (no business verification needed).
          </li>
          <li>
            Copy <code>.env.example</code> to <code>.env.local</code> in the MoneyLens folder. From Plaid&apos;s Keys page, paste
            in the client ID, the sandbox secret as <code>PLAID_SECRET_SANDBOX</code>, and the production secret
            as <code>PLAID_SECRET_PRODUCTION</code>.
          </li>
          <li>Start with <code>PLAID_ENV=sandbox</code> to try fake banks, then change it to <code>production</code> for your real banks.</li>
          <li>Restart <code>npm run dev</code> and reload this page.</li>
        </ol>
      </div>
    );
  }

  const production = server.env === 'production';
  return (
    <div className="card bank-status">
      <span className={production ? 'badge-active' : 'badge-warn'}>{production ? 'Production' : 'Sandbox'}</span>
      <span className="muted">
        {production
          ? `${server.createdCount} of the ${TRIAL_LIMIT} connections in Plaid's free Trial used. Disconnecting a bank doesn't give one back.`
          : "Sandbox banks are fake: log in with user_good / pass_good. Their data stays apart from your real banks and is deleted when you disconnect."}
      </span>
    </div>
  );
}

function AccountSetup({ serverItem, env, transactions, profiles, takenTargets, busy, onStart, onDisconnect }) {
  const [accounts, setAccounts] = useState(null);
  const [choices, setChoices] = useState({}); // accountId → target the user picked
  const [error, setError] = useState('');
  const { itemId, institutionName } = serverItem;

  useEffect(() => {
    let cancelled = false;
    plaidRequest('accounts', { itemId })
      .then((res) => !cancelled && setAccounts(res.accounts))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const defaults = useMemo(
    () => (accounts ? defaultTargets(accounts, { institutionName, env, takenTargets }) : {}),
    [accounts, institutionName, env, takenTargets]
  );
  const chosen = Object.fromEntries((accounts || []).map((a) => [a.id, a.id in choices ? choices[a.id] : defaults[a.id]]));
  const used = Object.values(chosen).filter(Boolean);
  const clash = used.length !== new Set(used).size;
  const profileEntries = Object.entries(profiles);

  return (
    <div className="card">
      <div className="bank-item-header">
        <h3>{institutionName}</h3>
        <span className="badge-warn">Choose accounts</span>
      </div>
      <p className="muted settings-help">
        Pick where each account&apos;s transactions go.
        {env === 'production' && ' To continue a bank you already import by CSV, choose its profile: Bank Sync then adds only transactions after your last import.'}
      </p>
      {error && <p className="error-text">{error}</p>}
      {!accounts && !error && <p className="muted">Loading accounts…</p>}

      {accounts?.map((a) => {
        const target = chosen[a.id] || '';
        const startDate = target ? latestImportedDate(transactions, target) : null;
        return (
          <div key={a.id} className="bank-account-row">
            <div className="bank-account-info">
              <span className="bank-account-name">{describePlaidAccount(a)}</span>
              <span className="muted">{accountKind(a)}</span>
            </div>
            <select value={target} onChange={(e) => setChoices((c) => ({ ...c, [a.id]: e.target.value || null }))}>
              <option value="">Don&apos;t sync</option>
              <option value={plaidSourceId(a.id)}>New account in MoneyLens</option>
              {env === 'production' && profileEntries.map(([id, p]) => (
                <option key={id} value={id} disabled={takenTargets.has(id)}>Continue {p.name}</option>
              ))}
            </select>
            {startDate && <p className="bank-account-note muted">Already imported through {startDate}. Only newer transactions will be added.</p>}
            {(a.type === 'loan' || a.type === 'investment') && !target && (
              <p className="bank-account-note muted">Not synced by default: loan payments and trades would show up as income and spending.</p>
            )}
          </div>
        );
      })}

      {clash && <p className="error-text mt-12">Two accounts can&apos;t sync into the same place.</p>}
      <div className="data-actions mt-12">
        <button
          className="btn-primary"
          disabled={!accounts || clash || used.length === 0 || busy}
          onClick={() => onStart(buildPlaidItem({ itemId, institutionName, env }, accounts, chosen, transactions))}
        >
          Start Syncing
        </button>
        <ConfirmButton
          className="btn-secondary"
          label="Disconnect"
          confirmLabel={env === 'production' ? "Disconnect? The Trial connection isn't refunded" : 'Disconnect?'}
          onConfirm={onDisconnect}
        />
      </div>
    </div>
  );
}

function ConnectedBank({ item, profiles, syncing, busy, onSync, onReconnect, onRemap, onDisconnect }) {
  const needsLogin = RECONNECT_CODES.has(item.lastError?.code);
  const historyNote = item.lastSyncAt && !item.lastError && HISTORY_NOTES[item.historyStatus];
  const targetLabel = (target) => (target ? `Syncs into ${profiles[target]?.name || 'its own account'}` : 'Not synced');

  return (
    <div className="card">
      <div className="bank-item-header">
        <div>
          <h3>
            {item.institutionName}
            {item.env !== 'production' && <span className="tx-badge">SANDBOX</span>}
          </h3>
          <span className="muted">
            Last synced {formatTime(item.lastSyncAt)}
            {item.lastSummary && ` · ${summaryText(item.lastSummary)}`}
          </span>
        </div>
        {needsLogin ? (
          <button className="btn-primary" onClick={onReconnect} disabled={busy}>Reconnect</button>
        ) : (
          <button className="btn-secondary" onClick={onSync} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Now'}</button>
        )}
      </div>

      {item.lastError && (
        <p className="error-text">
          {needsLogin ? `${item.institutionName} needs you to log in again. Click Reconnect.` : item.lastError.message}
        </p>
      )}
      {historyNote && <p className="muted settings-help">{historyNote}</p>}

      {item.accounts.map((a) => (
        <div key={a.id} className="bank-account-row">
          <div className="bank-account-info">
            <span className="bank-account-name">{describePlaidAccount(a)}</span>
            <span className="muted">{accountKind(a)}</span>
          </div>
          <span className="muted">{targetLabel(a.target)}</span>
        </div>
      ))}

      <div className="data-actions mt-12">
        <ConfirmButton
          className="btn-secondary"
          label="Change Accounts"
          confirmLabel="Delete its synced transactions and choose again?"
          onConfirm={onRemap}
        />
        <ConfirmButton
          className="btn-secondary"
          label="Disconnect"
          confirmLabel={item.env === 'production'
            ? "Disconnect? Transactions stay; the Trial connection isn't refunded"
            : 'Disconnect and delete its test data?'}
          onConfirm={onDisconnect}
        />
      </div>
    </div>
  );
}
