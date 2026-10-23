import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaidClient, createPlaidHandler, createTokenStore, resolvePlaidConfig } from './plaidApi.js';

// Fake Plaid: each path maps to a function (body) => response JSON, or throws { status, json }
function fakePlaid(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, headers: init.headers });
    const route = routes[path];
    if (!route) return jsonResponse(404, { error_code: 'NOT_FOUND', error_message: path });
    try {
      return jsonResponse(200, route(body, calls));
    } catch (err) {
      return jsonResponse(err.status || 400, err.json);
    }
  };
  return { calls, call: createPlaidClient({ clientId: 'client-x', secret: 'secret-x', baseUrl: 'https://plaid.test', fetchImpl }) };
}

const jsonResponse = (status, json) => ({ ok: status < 400, status, json: async () => json });
const plaidError = (code, status = 400) => Object.assign(new Error(code), { status, json: { error_code: code, error_message: code } });

function request(handler, action, body = {}, { headers = {}, method = 'POST' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url: `/${action}`,
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers },
  });
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); },
    };
    handler(req, res);
  });
}

let dir;
let tokenFile;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'moneylens-plaid-'));
  tokenFile = join(dir, 'nested', 'plaid-tokens.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tx = (id, overrides = {}) => ({
  transaction_id: id,
  account_id: 'acc_1',
  date: '2026-03-02',
  amount: 12.5,
  name: 'Coffee Shop',
  merchant_name: 'Coffee Shop',
  original_description: 'SQ *COFFEE SHOP 123',
  pending: false,
  personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
  ...overrides,
});

function setup(routes, { env = 'sandbox', problem = null } = {}) {
  const plaid = fakePlaid(routes);
  const store = createTokenStore(tokenFile);
  const handler = createPlaidHandler({ env, problem, store, call: plaid.call });
  return { handler, store, calls: plaid.calls };
}

async function connect(handler) {
  return request(handler, 'exchange', { publicToken: 'public-1', institutionId: 'ins_1', institutionName: 'Test Bank' });
}

const exchangeRoute = () => ({ access_token: 'access-sandbox-1', item_id: 'item_1' });

describe('resolvePlaidConfig', () => {
  const ID = { PLAID_CLIENT_ID: 'client-x' };

  it('uses the secret named for PLAID_ENV', () => {
    const vars = { ...ID, PLAID_SECRET_SANDBOX: 'sb', PLAID_SECRET_PRODUCTION: 'prod' };
    expect(resolvePlaidConfig({ ...vars, PLAID_ENV: 'production' })).toMatchObject({ env: 'production', clientId: 'client-x', secret: 'prod', problem: null });
    expect(resolvePlaidConfig(vars)).toMatchObject({ env: 'sandbox', secret: 'sb', problem: null }); // sandbox by default
  });

  it('names the missing variable for the chosen environment', () => {
    expect(resolvePlaidConfig({ ...ID, PLAID_SECRET_SANDBOX: 'sb', PLAID_ENV: 'production' }).problem)
      .toBe('PLAID_SECRET_PRODUCTION is not set.');
    expect(resolvePlaidConfig({ PLAID_SECRET_SANDBOX: 'sb' }).problem).toBe('PLAID_CLIENT_ID is not set.');
  });

  it('asks to rename the old single PLAID_SECRET instead of guessing its environment', () => {
    const { problem, secret } = resolvePlaidConfig({ ...ID, PLAID_SECRET: 'old' });
    expect(secret).toBeUndefined();
    expect(problem).toMatch(/rename it to PLAID_SECRET_SANDBOX or PLAID_SECRET_PRODUCTION/);
  });

  it('rejects an unknown PLAID_ENV', () => {
    expect(resolvePlaidConfig({ ...ID, PLAID_ENV: 'development' }).problem).toMatch(/sandbox.*production/);
  });
});

describe('plaid API: request checks', () => {
  it('reports the configuration problem without calling Plaid', async () => {
    const { handler, calls } = setup({}, { problem: 'PLAID_SECRET_SANDBOX is not set.' });
    const res = await request(handler, 'status');
    expect(res.body).toEqual({ configured: false, env: 'sandbox', problem: 'PLAID_SECRET_SANDBOX is not set.' });
    const blocked = await request(handler, 'link-token');
    expect(blocked.body.error).toEqual({ code: 'NOT_CONFIGURED', message: 'PLAID_SECRET_SANDBOX is not set.' });
    expect(calls).toHaveLength(0);
  });

  it('refuses non-localhost hosts, other origins, non-POST and non-JSON requests', async () => {
    const { handler } = setup({});
    const cases = [
      { headers: { host: 'evil.example:5173' }, status: 403 },
      { headers: { origin: 'https://evil.example' }, status: 403 },
      { method: 'GET', status: 405 },
      { headers: { 'content-type': 'text/plain' }, status: 415 },
    ];
    for (const { status, ...opts } of cases) {
      expect((await request(handler, 'status', {}, opts)).status).toBe(status);
    }
  });

  it('does not treat inherited object keys as actions', async () => {
    const { handler } = setup({});
    expect((await request(handler, 'constructor')).status).toBe(404);
  });
});

describe('plaid API: connecting', () => {
  it('sends the keys as headers and requests 2 years of transactions', async () => {
    const { handler, calls } = setup({ '/link/token/create': () => ({ link_token: 'link-1' }) });
    expect((await request(handler, 'link-token')).body).toEqual({ linkToken: 'link-1' });
    expect(calls[0].headers).toMatchObject({ 'PLAID-CLIENT-ID': 'client-x', 'PLAID-SECRET': 'secret-x' });
    expect(calls[0].body).toMatchObject({ products: ['transactions'], transactions: { days_requested: 730 } });
    expect(calls[0].body).not.toHaveProperty('access_token');
  });

  it('stores the access token on disk, never in the response, and counts the connection', async () => {
    const { handler } = setup({ '/item/public_token/exchange': exchangeRoute });
    const res = await connect(handler);
    expect(res.body).toEqual({ itemId: 'item_1' });
    expect(JSON.stringify(res.body)).not.toContain('access-sandbox-1');

    const saved = JSON.parse(await readFile(tokenFile, 'utf8'));
    expect(saved.environments.sandbox.items.item_1).toMatchObject({ accessToken: 'access-sandbox-1', institutionName: 'Test Bank' });
    expect(saved.environments.sandbox.createdCount).toBe(1);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

    const status = await request(handler, 'status');
    expect(status.body).toMatchObject({ configured: true, createdCount: 1, items: [{ itemId: 'item_1', institutionId: 'ins_1', institutionName: 'Test Bank' }] });
    expect(JSON.stringify(status.body)).not.toContain('access-sandbox-1');
  });

  it('explains rejected keys in terms of the environment secret', async () => {
    const { handler } = setup({ '/link/token/create': () => { throw plaidError('INVALID_API_KEYS'); } });
    const res = await request(handler, 'link-token');
    expect(res.body.error.code).toBe('INVALID_API_KEYS');
    expect(res.body.error.message).toMatch(/PLAID_SECRET_SANDBOX in \.env\.local is the sandbox secret/);
  });

  it('uses the stored token for update mode, without products', async () => {
    const { handler, calls } = setup({
      '/item/public_token/exchange': exchangeRoute,
      '/link/token/create': () => ({ link_token: 'link-2' }),
    });
    await connect(handler);
    await request(handler, 'link-token', { itemId: 'item_1' });
    const body = calls.find((c) => c.path === '/link/token/create').body;
    expect(body.access_token).toBe('access-sandbox-1');
    expect(body).not.toHaveProperty('products');
  });

  it('keeps sandbox and production connections apart', async () => {
    const { handler } = setup({ '/item/public_token/exchange': exchangeRoute });
    await connect(handler);
    const prod = createPlaidHandler({ env: 'production', problem: null, store: createTokenStore(tokenFile), call: async () => ({}) });
    expect((await request(prod, 'status')).body).toMatchObject({ createdCount: 0, items: [] });
  });

  it('keeps the slot count after a connection is removed', async () => {
    const { handler, store } = setup({
      '/item/public_token/exchange': exchangeRoute,
      '/item/remove': () => ({}),
    });
    await connect(handler);
    expect((await request(handler, 'remove', { itemId: 'item_1' })).body).toEqual({ ok: true });
    expect(await store.get('sandbox')).toEqual({ createdCount: 1, items: {} });
  });

  it('answers 404 for a connection this computer does not have', async () => {
    const { handler } = setup({});
    const res = await request(handler, 'sync', { itemId: 'item_missing' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_ITEM');
  });
});

describe('plaid API: sync', () => {
  const accountsRoute = () => ({
    accounts: [{ account_id: 'acc_1', name: 'Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1000.5 } }],
    item: { item_id: 'item_1' },
  });

  it('follows pages, skips pending transactions and trims fields', async () => {
    const pages = [
      { added: [tx('t1'), tx('t2', { pending: true })], modified: [], removed: [], next_cursor: 'c1', has_more: true },
      { added: [tx('t3', { amount: -500, original_description: undefined, name: 'PAYROLL' })], modified: [tx('t0')], removed: [{ transaction_id: 't9' }], next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    ];
    const { handler, calls } = setup({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': () => pages.shift(),
      '/accounts/get': accountsRoute,
    });
    await connect(handler);
    const res = await request(handler, 'sync', { itemId: 'item_1', cursor: '' });

    const syncCalls = calls.filter((c) => c.path === '/transactions/sync');
    expect(syncCalls[0].body).not.toHaveProperty('cursor');
    expect(syncCalls[1].body.cursor).toBe('c1');
    expect(syncCalls[0].body.options).toEqual({ include_original_description: true });

    expect(res.body).toMatchObject({ fromCursor: '', nextCursor: 'c2', updateStatus: 'HISTORICAL_UPDATE_COMPLETE', removed: ['t9'] });
    expect(res.body.added.map((t) => t.id)).toEqual(['t1', 't3']);
    expect(res.body.added[0]).toEqual({
      id: 't1', accountId: 'acc_1', date: '2026-03-02', amount: 12.5,
      name: 'SQ *COFFEE SHOP 123', merchantName: 'Coffee Shop', category: 'FOOD_AND_DRINK_COFFEE',
    });
    expect(res.body.added[1].name).toBe('PAYROLL');
    expect(res.body.modified.map((t) => t.id)).toEqual(['t0']);
    expect(res.body.accounts).toEqual([{ id: 'acc_1', name: 'Checking', mask: '0000', type: 'depository', subtype: 'checking', balance: 1000.5 }]);
  });

  it('restarts from the first cursor when data changes mid-pagination', async () => {
    let n = 0;
    const { handler, calls } = setup({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': (body) => {
        n++;
        if (n === 2) throw plaidError('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
        return body.cursor === 'start'
          ? { added: [tx('t1')], modified: [], removed: [], next_cursor: 'p2', has_more: true }
          : { added: [tx('t2')], modified: [], removed: [], next_cursor: 'end', has_more: false };
      },
      '/accounts/get': accountsRoute,
    });
    await connect(handler);
    const res = await request(handler, 'sync', { itemId: 'item_1', cursor: 'start' });
    expect(calls.filter((c) => c.path === '/transactions/sync').map((c) => c.body.cursor)).toEqual(['start', 'p2', 'start', 'p2']);
    expect(res.body.added.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(res.body.nextCursor).toBe('end');
  });

  it('passes Plaid errors through with their code', async () => {
    const { handler } = setup({
      '/item/public_token/exchange': exchangeRoute,
      '/transactions/sync': () => { throw plaidError('ITEM_LOGIN_REQUIRED'); },
    });
    await connect(handler);
    const res = await request(handler, 'sync', { itemId: 'item_1', cursor: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ITEM_LOGIN_REQUIRED');
  });
});
