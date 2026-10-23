// Local API for Bank Sync. It runs inside the Vite dev/preview server (see vite.config.js) so the
// Plaid secret and the per-bank access tokens never reach the browser. The browser keeps only the
// account mapping and sync cursor; this file keeps the tokens.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PLAID_HOSTS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

// Outside the repo on purpose: it can't be committed, served by Vite, or wiped by `git clean -x`.
// Losing it means reconnecting each bank, and every new connection uses up a Plaid Trial slot.
export const DEFAULT_TOKEN_FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'moneylens',
  'plaid-tokens.json'
);

// One client ID, one secret per environment; PLAID_ENV picks which secret is used
export const secretVarFor = (env) => `PLAID_SECRET_${env.toUpperCase()}`;

// PLAID_* variables → what the API needs, plus the problem to show on the setup page (or null)
export function resolvePlaidConfig(vars) {
  const env = vars.PLAID_ENV || 'sandbox';
  if (!PLAID_HOSTS[env]) {
    return { env, problem: `PLAID_ENV must be "sandbox" or "production" (got "${env}").` };
  }
  const secretVar = secretVarFor(env);
  const secret = vars[secretVar];
  const problems = [];
  if (!vars.PLAID_CLIENT_ID) problems.push('PLAID_CLIENT_ID is not set.');
  if (!secret && vars.PLAID_SECRET) {
    problems.push('PLAID_SECRET is no longer used: rename it to PLAID_SECRET_SANDBOX or PLAID_SECRET_PRODUCTION, matching the environment it belongs to.');
  } else if (!secret) {
    problems.push(`${secretVar} is not set.`);
  }
  return {
    env,
    clientId: vars.PLAID_CLIENT_ID,
    secret,
    tokenFile: vars.PLAID_TOKEN_FILE,
    problem: problems.join(' ') || null,
  };
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY_BYTES = 64 * 1024;

export class PlaidApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createPlaidClient({ clientId, secret, baseUrl, fetchImpl = fetch }) {
  return async function call(path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': clientId,
          'PLAID-SECRET': secret,
          'Plaid-Version': '2020-09-14',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new PlaidApiError('PLAID_UNREACHABLE', `Couldn't reach Plaid: ${err.message}`, 502);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = json.display_message || json.error_message || `Plaid returned HTTP ${res.status}`;
      throw new PlaidApiError(json.error_code || 'PLAID_ERROR', message, res.status >= 500 ? 502 : 400);
    }
    return json;
  };
}

// { environments: { sandbox: { createdCount, items: { [itemId]: { accessToken, institutionId, institutionName, createdAt } } } } }
// createdCount only goes up: Plaid's Trial counts every connection ever made, removed or not.
export function createTokenStore(file) {
  let queue = Promise.resolve();

  const read = async () => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return { environments: {} };
      throw err;
    }
  };

  const write = async (state) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  };

  // Read-modify-write cycles run one at a time so concurrent requests can't drop each other's changes
  const mutate = (fn) => {
    const run = queue.then(async () => {
      const state = await read();
      fn(state);
      await write(state);
    });
    queue = run.catch(() => {});
    return run;
  };

  const envState = (state, env) => {
    state.environments ??= {};
    return (state.environments[env] ??= { createdCount: 0, items: {} });
  };

  return {
    async get(env) {
      return envState(await read(), env);
    },
    addItem: (env, itemId, record) => mutate((state) => {
      const e = envState(state, env);
      e.items[itemId] = record;
      e.createdCount += 1;
    }),
    removeItem: (env, itemId) => mutate((state) => {
      delete envState(state, env).items[itemId];
    }),
  };
}

// Only the fields the app uses. `name` prefers the bank's raw description so it matches CSV
// exports and the keyword rules written for them.
function normalizeTransaction(t) {
  return {
    id: t.transaction_id,
    accountId: t.account_id,
    date: t.date,
    amount: t.amount, // Plaid: positive = money out, negative = money in
    name: t.original_description || t.name || t.merchant_name || 'Unknown',
    merchantName: t.merchant_name || null,
    category: t.personal_finance_category?.detailed || null,
  };
}

function normalizeAccount(a) {
  return {
    id: a.account_id,
    name: a.name,
    mask: a.mask || null,
    type: a.type,
    subtype: a.subtype || null,
    balance: a.balances?.current ?? null,
  };
}

async function syncTransactions(call, accessToken, cursor) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = { added: [], modified: [], removed: [], nextCursor: cursor, updateStatus: null };
      let hasMore = true;
      while (hasMore) {
        const page = await call('/transactions/sync', {
          access_token: accessToken,
          ...(out.nextCursor ? { cursor: out.nextCursor } : {}),
          count: 500,
          options: { include_original_description: true },
        });
        out.added.push(...page.added);
        out.modified.push(...page.modified);
        out.removed.push(...page.removed);
        out.nextCursor = page.next_cursor;
        out.updateStatus = page.transactions_update_status || null;
        hasMore = page.has_more;
      }
      return out;
    } catch (err) {
      // Plaid's data changed mid-pagination: the whole loop must restart from the first cursor
      if (err.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 3) continue;
      throw err;
    }
  }
}

const cleanString = (value, max = 100) => (typeof value === 'string' ? value.slice(0, max) : null);

// `problem` comes from resolvePlaidConfig: when set, only `status` works and it reports the problem
export function createPlaidHandler({ env, problem, store, call }) {
  const configured = !problem;

  const requireItem = async (itemId) => {
    const item = typeof itemId === 'string' ? (await store.get(env)).items[itemId] : null;
    if (!item) throw new PlaidApiError('UNKNOWN_ITEM', "This bank connection isn't stored on this computer.", 404);
    return item;
  };

  const actions = {
    async status() {
      if (!configured) return { configured: false, env, problem };
      const { createdCount, items } = await store.get(env);
      return {
        configured: true,
        env,
        createdCount,
        items: Object.entries(items).map(([itemId, i]) => ({
          itemId,
          institutionId: i.institutionId,
          institutionName: i.institutionName,
        })),
      };
    },

    // With itemId: update mode, to fix a connection that needs the user to log in again
    async 'link-token'({ itemId }) {
      const base = {
        client_name: 'MoneyLens',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: 'moneylens-local-user' },
      };
      const body = itemId
        ? { ...base, access_token: (await requireItem(itemId)).accessToken }
        : { ...base, products: ['transactions'], transactions: { days_requested: 730 } };
      const { link_token } = await call('/link/token/create', body);
      return { linkToken: link_token };
    },

    async exchange({ publicToken, institutionId, institutionName }) {
      if (typeof publicToken !== 'string' || !publicToken) {
        throw new PlaidApiError('BAD_REQUEST', 'publicToken is required.');
      }
      const { access_token, item_id } = await call('/item/public_token/exchange', { public_token: publicToken });
      await store.addItem(env, item_id, {
        accessToken: access_token,
        institutionId: cleanString(institutionId),
        institutionName: cleanString(institutionName) || 'Bank',
        createdAt: new Date().toISOString(),
      });
      return { itemId: item_id };
    },

    async accounts({ itemId }) {
      const { accessToken } = await requireItem(itemId);
      const { accounts } = await call('/accounts/get', { access_token: accessToken });
      return { accounts: accounts.map(normalizeAccount) };
    },

    async sync({ itemId, cursor }) {
      const { accessToken } = await requireItem(itemId);
      const fromCursor = typeof cursor === 'string' ? cursor : '';
      const tx = await syncTransactions(call, accessToken, fromCursor);
      // Cached balances (free); refreshed by Plaid whenever it pulls new transactions
      const { accounts } = await call('/accounts/get', { access_token: accessToken });
      return {
        fromCursor,
        nextCursor: tx.nextCursor,
        updateStatus: tx.updateStatus,
        // Pending transactions are skipped: once posted, Plaid sends them again under a new ID
        added: tx.added.filter((t) => !t.pending).map(normalizeTransaction),
        modified: tx.modified.filter((t) => !t.pending).map(normalizeTransaction),
        removed: tx.removed.map((r) => r.transaction_id),
        accounts: accounts.map(normalizeAccount),
      };
    },

    async remove({ itemId }) {
      const { accessToken } = await requireItem(itemId);
      try {
        await call('/item/remove', { access_token: accessToken });
      } catch (err) {
        if (!['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'].includes(err.code)) throw err;
      }
      await store.removeItem(env, itemId);
      return { ok: true };
    },
  };

  return async function handler(req, res) {
    try {
      const host = req.headers.host || '';
      // Refuse other hosts (DNS rebinding) and other sites' pages (cross-site requests)
      if (!LOCAL_HOST.test(host)) {
        throw new PlaidApiError('FORBIDDEN', 'Bank sync only answers requests to localhost.', 403);
      }
      const { origin } = req.headers;
      if (origin && origin !== `http://${host}` && origin !== `https://${host}`) {
        throw new PlaidApiError('FORBIDDEN', 'Cross-origin requests are not allowed.', 403);
      }
      if (req.method !== 'POST') throw new PlaidApiError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
      if (!(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new PlaidApiError('UNSUPPORTED_MEDIA_TYPE', 'Send JSON.', 415);
      }

      const name = (req.url || '').replace(/^\/+|\?.*$/g, '');
      if (!Object.hasOwn(actions, name)) throw new PlaidApiError('NOT_FOUND', `Unknown action "${name}".`, 404);
      if (name !== 'status' && !configured) {
        throw new PlaidApiError('NOT_CONFIGURED', problem);
      }

      const body = await readJson(req);
      sendJson(res, 200, await actions[name](body));
    } catch (err) {
      const status = err instanceof PlaidApiError ? err.status : 500;
      // Usually the other environment's secret pasted into this environment's variable
      const message = err.code === 'INVALID_API_KEYS'
        ? `Plaid rejected the keys for ${env}. Make sure ${secretVarFor(env)} in .env.local is the ${env} secret from Plaid's Keys page (each environment has its own).`
        : err.message;
      sendJson(res, status, { error: { code: err.code || 'SERVER_ERROR', message } });
    }
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PlaidApiError('TOO_LARGE', 'Request body too large.', 413));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new PlaidApiError('BAD_REQUEST', 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Vite plugin: mounts the API at /api/plaid on `npm run dev` and `npm run preview`.
// A static build (dist/) has no server, so Bank Sync shows setup instructions there instead.
// `vars` = the PLAID_* variables; `overrides` (baseUrl, tokenFile) exist for testing.
export function plaidApiPlugin(vars, overrides = {}) {
  const { env, clientId, secret, problem, tokenFile } = resolvePlaidConfig(vars);
  const attach = (server) => {
    const store = createTokenStore(overrides.tokenFile || tokenFile || DEFAULT_TOKEN_FILE);
    const call = createPlaidClient({ clientId, secret, baseUrl: overrides.baseUrl || PLAID_HOSTS[env] });
    server.middlewares.use('/api/plaid', createPlaidHandler({ env, problem, store, call }));
  };
  return { name: 'moneylens-plaid-api', configureServer: attach, configurePreviewServer: attach };
}
