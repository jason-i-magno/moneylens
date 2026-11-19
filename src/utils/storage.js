// Where the app's data is kept. Through MoneyLens's server (npm run dev / npm run preview, opened at
// localhost or through `tailscale serve`) there is one copy, in its database (server/dataApi.js),
// shared by every browser. Without the server (a static host), or until this browser's data is moved
// there, the data stays in this browser's localStorage.
//
// Both kinds of store have the same shape: { mode, initialData, save(data, note), subscribe(fn),
// onState(fn), hasUnsaved() }, plus extras per mode (see below).
import { createDefaultData, migrateData } from './migrate';

const STORAGE_KEY = 'moneylens-data';
// Set once the server has answered in this browser. From then on, when it can't be reached, the app
// says so instead of falling back to this browser's own storage (old or empty data, edits kept apart).
const SERVER_KEY = 'moneylens-server';
// This browser's own copy from before it used the server: set aside, never used again, not deleted
const SET_ASIDE_KEY = 'moneylens-data-before-server';

// How often an open window checks for changes saved by another one (also on focus)
const REFRESH_EVERY_MS = 60 * 1000;

const readLocal = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode, site data off)
  }
};

const writeLocal = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // only for markers and the set-aside copy: the app works without them
  }
};

// The latest data handed to the store, for the crash screen's "Download Backup"
let current = null;
export const backupJson = () => (current ? JSON.stringify(current, null, 2) : readLocal(STORAGE_KEY) || '{}');

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NO_SERVER = "MoneyLens's server isn't answering.";

// Bodies over a few KB (a save is the whole data) are gzipped where the browser can
async function packBody(body) {
  const text = JSON.stringify(body);
  if (text.length < 4096 || typeof CompressionStream === 'undefined') return { body: text, headers: {} };
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return { body: await new Response(stream).arrayBuffer(), headers: { 'Content-Encoding': 'gzip' } };
}

export async function dataRequest(action, body = {}, { timeoutMs = 20000 } = {}) {
  const { body: payload, headers } = await packBody(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`/api/data/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
      signal: controller.signal,
    });
  } catch {
    throw new StorageError('NO_SERVER', NO_SERVER);
  } finally {
    clearTimeout(timer);
  }
  // A static host (or `tailscale serve` with nothing behind it) answers with HTML or plain text
  const json = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!json) throw new StorageError('NO_SERVER', NO_SERVER);
  if (!res.ok) throw new StorageError(json.error?.code || 'ERROR', json.error?.message || `Request failed (${res.status})`);
  return json;
}

// Sends saves one at a time, each on top of the version the previous one made. The data is the whole
// document, so a save still waiting is replaced by a newer one. A failed save is retried; a conflict
// (another window saved first) drops this window's unsaved changes, since they can't be merged.
// onState({ status: 'saving' | 'saved' | 'retrying' | 'conflict', message?, rev?, savedAt? })
export function createSaver({ request, rev, onState = () => {}, retryDelays = [1000, 3000, 10000, 30000] }) {
  let baseRev = rev;
  let waiting = null; // { data, note, waiters: [{ resolve, reject }] }
  let sending = false;
  let retryTimer = null;
  let failures = 0;

  async function flush() {
    if (sending || retryTimer || !waiting) return;
    const job = waiting;
    waiting = null;
    sending = true;
    onState({ status: 'saving' });
    try {
      const out = await request('save', { baseRev, data: job.data, ...(job.note && { note: job.note }) });
      baseRev = out.rev;
      failures = 0;
      job.waiters.forEach((w) => w.resolve(out));
      if (!waiting) onState({ status: 'saved', rev: out.rev, savedAt: out.savedAt });
    } catch (err) {
      if (err.code === 'CONFLICT') {
        const dropped = [...job.waiters, ...(waiting?.waiters || [])];
        waiting = null;
        dropped.forEach((w) => w.reject(err));
        onState({ status: 'conflict', message: err.message });
      } else {
        // Newer data already waiting includes these changes; otherwise this one is sent again
        if (waiting) {
          waiting.waiters.unshift(...job.waiters);
          waiting.note ||= job.note;
        } else {
          waiting = job;
        }
        const delay = retryDelays[Math.min(failures, retryDelays.length - 1)];
        failures += 1;
        onState({ status: 'retrying', message: err.message });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flush();
        }, delay);
      }
    } finally {
      sending = false;
    }
    flush();
  }

  return {
    // Resolves once this data (or newer data that replaced it) is saved; rejects on a conflict
    save(data, note) {
      const done = new Promise((resolve, reject) => {
        waiting = { data, note: note || waiting?.note, waiters: [...(waiting?.waiters || []), { resolve, reject }] };
        flush();
      });
      done.catch(() => {}); // most saves aren't awaited; a conflict is reported through onState
      return done;
    },
    get rev() {
      return baseRev;
    },
    // After loading a newer version (only while nothing is unsaved)
    setRev(next) {
      baseRev = next;
    },
    hasUnsaved: () => sending || !!waiting,
    // Skips the wait before the next retry (the window got focus, the network came back)
    retryNow() {
      if (!retryTimer) return;
      clearTimeout(retryTimer);
      retryTimer = null;
      flush();
    },
  };
}

function parseOwnData(raw) {
  if (!raw) return createDefaultData();
  try {
    return migrateData(JSON.parse(raw));
  } catch {
    return createDefaultData();
  }
}

// This browser's localStorage. serverAvailable: the server is there with an empty database, so
// Settings offers to move this browser's data to it.
function createLocalStore(raw, serverAvailable) {
  const initialData = parseOwnData(raw);
  current = initialData;
  return {
    mode: 'local',
    serverAvailable,
    initialData,
    save(data) {
      current = data;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); // a full storage throws, as it always has
      return Promise.resolve();
    },
    subscribe: () => () => {},
    onState: () => () => {},
    hasUnsaved: () => false,
    // Fails with CONFLICT when another browser moved its data there first
    async moveToServer(data) {
      await dataRequest('save', { baseRev: 0, data, note: 'Moved from a browser' });
      writeLocal(SET_ASIDE_KEY, JSON.stringify(data));
      writeLocal(STORAGE_KEY, null);
    },
  };
}

function createServerStore(remote) {
  const initialData = migrateData(remote.data);
  current = initialData;
  const listeners = new Set();
  const stateListeners = new Set();
  let state = { status: 'saved', rev: remote.rev, savedAt: remote.savedAt };
  const setState = (next) => {
    state = next;
    stateListeners.forEach((fn) => fn(next));
  };

  const saver = createSaver({
    request: dataRequest,
    rev: remote.rev,
    onState: (next) => {
      setState(next);
      if (next.status === 'conflict') refresh('conflict');
    },
  });

  // Loads what another window saved since, unless this one still has changes to send
  // (after a conflict those changes are gone, so it loads anyway)
  async function refresh(reason) {
    if (reason !== 'conflict' && saver.hasUnsaved()) return;
    let out;
    try {
      out = await dataRequest('load', { since: saver.rev });
    } catch {
      return; // tried again on the next focus or tick
    }
    if (out.unchanged || !out.data) return;
    if (reason !== 'conflict' && saver.hasUnsaved()) return; // changed here while loading
    saver.setRev(out.rev);
    current = migrateData(out.data);
    listeners.forEach((fn) => fn({ data: current, reason }));
    setState({ status: 'saved', rev: out.rev, savedAt: out.savedAt });
  }

  const onFocus = () => {
    saver.retryNow();
    if (document.visibilityState === 'visible') refresh('refresh');
  };
  let ticker = null;
  const watch = () => {
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    ticker = setInterval(() => document.visibilityState === 'visible' && refresh('refresh'), REFRESH_EVERY_MS);
  };
  const unwatch = () => {
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    clearInterval(ticker);
  };

  return {
    mode: 'server',
    initialData,
    get state() {
      return state;
    },
    save(data, note) {
      current = data;
      return saver.save(data, note);
    },
    // fn({ data, reason: 'refresh' | 'conflict' }) when data saved elsewhere replaces this window's
    subscribe(fn) {
      if (listeners.size === 0) watch();
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) unwatch();
      };
    },
    onState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    hasUnsaved: saver.hasUnsaved,
    // [{ rev, savedAt, transactions, accounts, note? }], newest first
    versions: async () => (await dataRequest('versions')).versions,
    loadVersion: async (rev) => {
      const out = await dataRequest('load', { rev });
      return { ...out, data: migrateData(out.data) };
    },
    ownCopyFromBefore: () => readLocal(SET_ASIDE_KEY),
    discardOwnCopy: () => writeLocal(SET_ASIDE_KEY, null),
  };
}

// Resolves the store to use, or rejects (StorageError) when this browser uses the server and it
// can't be reached; the start-up screen then offers to try again.
export async function openStorage() {
  const ownRaw = readLocal(STORAGE_KEY);
  let remote;
  try {
    remote = await dataRequest('load');
  } catch (err) {
    if (err.code === 'NO_SERVER' && !readLocal(SERVER_KEY)) return createLocalStore(ownRaw, false);
    throw err;
  }
  writeLocal(SERVER_KEY, '1');
  if (!remote.data) return createLocalStore(ownRaw, true);
  if (ownRaw) {
    writeLocal(SET_ASIDE_KEY, ownRaw);
    writeLocal(STORAGE_KEY, null);
  }
  return createServerStore(remote);
}
