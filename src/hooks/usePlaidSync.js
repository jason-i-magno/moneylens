import { useState, useCallback, useEffect, useRef } from 'react';
import { plaidRequest } from '../utils/plaidClient';

// Plaid refreshes 1–4 times a day, so syncing on app open more often than this finds nothing new
const AUTO_SYNC_AFTER_MS = 6 * 60 * 60 * 1000;

// Talks to the local Bank Sync server and feeds results into useFinanceData.
// Syncs due connections once when the app opens.
export function usePlaidSync({ data, applyPlaidSync, setPlaidItemError }) {
  // state: 'checking' | 'unavailable' | 'unconfigured' | 'ready' | 'error'
  const [server, setServer] = useState({ state: 'checking', items: [] });
  const [syncingIds, setSyncingIds] = useState([]);
  const inFlight = useRef(new Set());
  const itemsRef = useRef(data.plaid.items);

  useEffect(() => {
    itemsRef.current = data.plaid.items;
  }, [data.plaid.items]);

  const refreshServer = useCallback(async () => {
    try {
      const status = await plaidRequest('status');
      setServer({ ...status, state: status.configured ? 'ready' : 'unconfigured', items: status.items || [] });
      return status;
    } catch (err) {
      setServer({ state: err.code === 'NO_SERVER' ? 'unavailable' : 'error', message: err.message, items: [] });
      return null;
    }
  }, []);

  // Takes the item itself (not its ID) so a connection saved a moment ago can sync right away
  const syncItem = useCallback(async (item) => {
    if (inFlight.current.has(item.itemId)) return;
    inFlight.current.add(item.itemId);
    setSyncingIds([...inFlight.current]);
    try {
      const result = await plaidRequest('sync', { itemId: item.itemId, cursor: item.cursor });
      applyPlaidSync(item.itemId, result);
    } catch (err) {
      setPlaidItemError(item.itemId, { code: err.code, message: err.message, at: new Date().toISOString() });
    } finally {
      inFlight.current.delete(item.itemId);
      setSyncingIds([...inFlight.current]);
    }
  }, [applyPlaidSync, setPlaidItemError]);

  const syncAll = useCallback(async (connectedIds) => {
    for (const item of itemsRef.current.filter((i) => connectedIds.has(i.itemId))) {
      await syncItem(item);
    }
  }, [syncItem]);

  useEffect(() => {
    if (itemsRef.current.length === 0) return; // no connections: don't touch the server at all
    let cancelled = false;
    (async () => {
      const status = await refreshServer();
      if (cancelled || !status?.configured) return;
      const connected = new Set(status.items.map((i) => i.itemId));
      const due = itemsRef.current.filter((i) => connected.has(i.itemId)
        && (!i.lastSyncAt || Date.now() - Date.parse(i.lastSyncAt) > AUTO_SYNC_AFTER_MS));
      for (const item of due) await syncItem(item);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshServer, syncItem]);

  return { server, refreshServer, syncItem, syncAll, syncingIds };
}
