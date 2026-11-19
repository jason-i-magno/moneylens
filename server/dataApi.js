// Data storage: one copy of the app's data in a SQLite database on this computer, shared by every
// browser that opens the app through this server (localhost, or the address `tailscale serve` gives
// it). Runs inside the Vite dev/preview server like Bank Sync. The data stays one JSON document, the
// same shape the browser keeps, so none of the app's logic depends on where it's stored.
//
// Every save is a new version (gzipped). The newest KEEP_LATEST and the last one of each of the
// KEEP_DAYS most recent days are kept, so Settings can roll a bad change back.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiError, actionName, checkRequest, parseHostList, readJson, sendError, sendJson, sendJsonText } from './http.js';

// Outside the repo, next to the Bank Sync tokens: it can't be committed or served by Vite
export const DEFAULT_DATA_FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'moneylens',
  'moneylens.db'
);

export const KEEP_LATEST = 100;
export const KEEP_DAYS = 60;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

// Shown in the version list; counted here so listing versions doesn't unpack each one
function summarize(data, note) {
  return {
    transactions: data.transactions.length,
    accounts: data.netWorth?.accounts?.length || 0,
    ...(note && { note }),
  };
}

const isAppData = (data) => !!data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.transactions);

// file: a path, or ':memory:' for tests. `now` is injectable for tests.
export async function openDataStore(file, { now = () => new Date() } = {}) {
  // Loaded here, not at the top, so `vite build` never loads SQLite (Node 22 still calls it experimental)
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:' && !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600 }); // SQLite takes an empty file as a new database
  }
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS versions (
    rev INTEGER PRIMARY KEY,
    saved_at TEXT NOT NULL,
    summary TEXT NOT NULL,
    data BLOB NOT NULL
  )`);

  const latestRev = db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM versions');
  const latest = db.prepare('SELECT rev, saved_at AS savedAt, data FROM versions ORDER BY rev DESC LIMIT 1');
  const byRev = db.prepare('SELECT rev, saved_at AS savedAt, data FROM versions WHERE rev = ?');
  const insert = db.prepare('INSERT INTO versions (rev, saved_at, summary, data) VALUES (?, ?, ?, ?)');
  const list = db.prepare('SELECT rev, saved_at AS savedAt, summary FROM versions ORDER BY rev DESC');
  // saved_at is UTC, so "a day" here is a UTC day
  const prune = db.prepare(`DELETE FROM versions
    WHERE rev NOT IN (SELECT rev FROM versions ORDER BY rev DESC LIMIT ?)
      AND rev NOT IN (SELECT MAX(rev) FROM versions GROUP BY substr(saved_at, 1, 10) ORDER BY 1 DESC LIMIT ?)`);

  const currentRev = () => latestRev.get().rev;
  const unpack = (row) => ({ rev: row.rev, savedAt: row.savedAt, json: gunzipSync(row.data).toString('utf8') });

  return {
    currentRev,

    // { rev, savedAt, json } of the latest version (or of `rev`); null when there is none
    load(rev) {
      const row = rev ? byRev.get(rev) : latest.get();
      return row ? unpack(row) : null;
    },

    // Only on top of the version the browser last loaded or saved (baseRev), so a window with
    // stale data can't overwrite what another window saved since; 0 = the database is empty
    save(baseRev, data, note) {
      if (!isAppData(data)) throw new ApiError('BAD_REQUEST', "That isn't MoneyLens data.");
      db.exec('BEGIN IMMEDIATE');
      try {
        const rev = currentRev();
        if (baseRev !== rev) throw new ApiError('CONFLICT', 'The data was changed in another window.', 409);
        const savedAt = now().toISOString();
        insert.run(rev + 1, savedAt, JSON.stringify(summarize(data, note)), gzipSync(JSON.stringify(data)));
        prune.run(KEEP_LATEST, KEEP_DAYS);
        db.exec('COMMIT');
        return { rev: rev + 1, savedAt };
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    versions() {
      return list.all().map(({ rev, savedAt, summary }) => ({ rev, savedAt, ...JSON.parse(summary) }));
    },

    close: () => db.close(),
  };
}

const cleanNote = (note) => (typeof note === 'string' && note.trim() ? note.trim().slice(0, 100) : undefined);

// `store` is null when the database couldn't be opened (`openError` says why)
export function createDataHandler({ store, openError, allowedHosts = [] }) {
  const actions = {
    // { rev, savedAt, data }; data is null while the database is empty.
    // With `since`: { rev, unchanged: true } when nothing was saved after that version.
    load(req, res, { rev, since }) {
      if (Number.isInteger(since) && since === store.currentRev()) {
        return sendJson(req, res, 200, { rev: since, unchanged: true });
      }
      const version = store.load(Number.isInteger(rev) ? rev : undefined);
      if (!version) {
        if (rev) throw new ApiError('NOT_FOUND', `There is no version ${rev}.`, 404);
        return sendJson(req, res, 200, { rev: 0, savedAt: null, data: null });
      }
      // The stored JSON goes out as it is, without parsing it here
      sendJsonText(req, res, 200, `{"rev":${version.rev},"savedAt":${JSON.stringify(version.savedAt)},"data":${version.json}}`);
    },

    save(req, res, { baseRev, data, note }) {
      if (!Number.isInteger(baseRev)) throw new ApiError('BAD_REQUEST', 'baseRev is required.');
      sendJson(req, res, 200, store.save(baseRev, data, cleanNote(note)));
    },

    versions(req, res) {
      sendJson(req, res, 200, { versions: store.versions() });
    },
  };

  return async function handler(req, res) {
    try {
      checkRequest(req, allowedHosts);
      const name = actionName(req);
      if (!Object.hasOwn(actions, name)) throw new ApiError('NOT_FOUND', `Unknown action "${name}".`, 404);
      if (!store) throw new ApiError('STORAGE_UNAVAILABLE', `MoneyLens couldn't open its database: ${openError?.message}`, 500);
      const body = await readJson(req, MAX_BODY_BYTES);
      await actions[name](req, res, body);
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

// Vite plugin: mounts the API at /api/data on `npm run dev` and `npm run preview`. A static build has
// no server, so the app keeps its data in the browser there. `vars`: MONEYLENS_DB (the database
// file) and MONEYLENS_ALLOWED_HOSTS. `overrides.file` exists for testing.
export function dataApiPlugin(vars, overrides = {}) {
  const allowedHosts = parseHostList(vars.MONEYLENS_ALLOWED_HOSTS);
  const attach = async (server) => {
    const file = overrides.file || vars.MONEYLENS_DB || DEFAULT_DATA_FILE;
    // A broken database shouldn't stop the server: the app shows the error instead
    const opened = await openDataStore(file).then((store) => ({ store }), (openError) => ({ store: null, openError }));
    if (opened.openError) server.config.logger.error(`MoneyLens couldn't open ${file}: ${opened.openError.message}`);
    server.middlewares.use('/api/data', createDataHandler({ ...opened, allowedHosts }));
  };
  return { name: 'moneylens-data-api', configureServer: attach, configurePreviewServer: attach };
}
