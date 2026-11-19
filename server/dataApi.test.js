import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { KEEP_DAYS, KEEP_LATEST, createDataHandler, openDataStore } from './dataApi.js';

function request(handler, action, body = {}, { headers = {}, method = 'POST', raw } = {}) {
  const req = Readable.from([raw ?? Buffer.from(JSON.stringify(body))]);
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
      end(out) {
        const text = this.headers['content-encoding'] === 'gzip' ? gunzipSync(out).toString('utf8') : out;
        resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(text) });
      },
    };
    handler(req, res);
  });
}

const appData = (n = 1, extra = {}) => ({
  version: 3,
  transactions: Array.from({ length: n }, (_, i) => ({ id: `tx_${i}`, name: 'TEST STORE', amount: 10 })),
  netWorth: { accounts: [{ id: 'acct_1', name: 'Test Checking' }], snapshots: [] },
  ...extra,
});

let store;
let handler;
let clock;

beforeEach(async () => {
  clock = new Date('2026-03-01T12:00:00Z');
  store = await openDataStore(':memory:', { now: () => clock });
  handler = createDataHandler({ store });
});

afterEach(() => store.close());

describe('data API: saving and loading', () => {
  it('starts empty', async () => {
    expect((await request(handler, 'load')).body).toEqual({ rev: 0, savedAt: null, data: null });
  });

  it('saves on top of the version the browser has and loads it back', async () => {
    const first = await request(handler, 'save', { baseRev: 0, data: appData(1) });
    expect(first.body).toEqual({ rev: 1, savedAt: '2026-03-01T12:00:00.000Z' });
    const second = await request(handler, 'save', { baseRev: 1, data: appData(2) });
    expect(second.body.rev).toBe(2);

    const loaded = await request(handler, 'load');
    expect(loaded.body).toEqual({ rev: 2, savedAt: '2026-03-01T12:00:00.000Z', data: appData(2) });
    expect((await request(handler, 'load', { since: 2 })).body).toEqual({ rev: 2, unchanged: true });
    expect((await request(handler, 'load', { since: 1 })).body.data).toEqual(appData(2));
  });

  it("refuses a save from a window that hasn't seen the latest version", async () => {
    await request(handler, 'save', { baseRev: 0, data: appData(1) });
    await request(handler, 'save', { baseRev: 1, data: appData(2) });
    const stale = await request(handler, 'save', { baseRev: 1, data: appData(5) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    // A second browser moving its data to a server that already has some is refused the same way
    expect((await request(handler, 'save', { baseRev: 0, data: appData(5) })).status).toBe(409);
    expect((await request(handler, 'load')).body.data).toEqual(appData(2));
  });

  it("refuses data that isn't MoneyLens data or has no base version", async () => {
    expect((await request(handler, 'save', { baseRev: 0, data: { hello: 'world' } })).body.error.code).toBe('BAD_REQUEST');
    expect((await request(handler, 'save', { baseRev: 0, data: [] })).body.error.code).toBe('BAD_REQUEST');
    expect((await request(handler, 'save', { data: appData() })).body.error.code).toBe('BAD_REQUEST');
    expect((await request(handler, 'load')).body.rev).toBe(0);
  });

  it('takes a gzipped body and gzips a large response for browsers that accept it', async () => {
    const data = appData(200);
    const raw = gzipSync(JSON.stringify({ baseRev: 0, data }));
    const saved = await request(handler, 'save', {}, { raw, headers: { 'content-encoding': 'gzip' } });
    expect(saved.body.rev).toBe(1);
    const loaded = await request(handler, 'load', {}, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(loaded.headers['content-encoding']).toBe('gzip');
    expect(loaded.body.data).toEqual(data);
    expect((await request(handler, 'load')).headers['content-encoding']).toBeUndefined();
  });
});

describe('data API: earlier versions', () => {
  it('lists versions newest first with counts and notes, and loads one by number', async () => {
    await request(handler, 'save', { baseRev: 0, data: appData(1), note: 'Moved from a browser' });
    clock = new Date('2026-03-02T08:00:00Z');
    await request(handler, 'save', { baseRev: 1, data: appData(3) });

    const { versions } = (await request(handler, 'versions')).body;
    expect(versions).toEqual([
      { rev: 2, savedAt: '2026-03-02T08:00:00.000Z', transactions: 3, accounts: 1 },
      { rev: 1, savedAt: '2026-03-01T12:00:00.000Z', transactions: 1, accounts: 1, note: 'Moved from a browser' },
    ]);
    expect((await request(handler, 'load', { rev: 1 })).body.data).toEqual(appData(1));
    expect((await request(handler, 'load', { rev: 9 })).status).toBe(404);
  });

  it(`keeps the newest ${KEEP_LATEST} and the last version of each of the latest ${KEEP_DAYS} days`, async () => {
    let rev = 0;
    const saveOn = async (iso) => {
      clock = new Date(iso);
      rev = (await request(handler, 'save', { baseRev: rev, data: appData(rev + 1) })).body.rev;
      return rev;
    };
    // Three saves on each of 70 days, then 120 more today
    const lastOfDay = [];
    for (let d = 0; d < 70; d++) {
      const day = new Date(Date.UTC(2026, 0, 1 + d)).toISOString().slice(0, 10);
      await saveOn(`${day}T09:00:00Z`);
      await saveOn(`${day}T12:00:00Z`);
      lastOfDay.push(await saveOn(`${day}T18:00:00Z`));
    }
    for (let i = 0; i < 120; i++) await saveOn(`2026-03-12T10:${String(i % 60).padStart(2, '0')}:00Z`);

    const kept = (await request(handler, 'versions')).body.versions.map((v) => v.rev);
    const newest = Array.from({ length: KEEP_LATEST }, (_, i) => rev - i);
    // Today is one of the 60 days, so 59 earlier days keep their last version
    const daily = lastOfDay.slice(-(KEEP_DAYS - 1)).reverse();
    expect(kept).toEqual([...newest, ...daily]);
    expect((await request(handler, 'load')).body.rev).toBe(rev);
  });
});

describe('data API: requests', () => {
  it('answers the extra hosts it was given, and refuses others, other origins, non-POST and non-JSON', async () => {
    const tailnet = createDataHandler({ store, allowedHosts: ['box.example.ts.net'] });
    const ok = await request(tailnet, 'load', {}, { headers: { host: 'box.example.ts.net:8443', origin: 'https://box.example.ts.net:8443' } });
    expect(ok.status).toBe(200);

    const cases = [
      { headers: { host: 'evil.example:5173' }, status: 403 },
      { headers: { host: 'box.example.ts.net.evil.example' }, status: 403 },
      { headers: { origin: 'https://evil.example' }, status: 403 },
      { method: 'GET', status: 405 },
      { headers: { 'content-type': 'text/plain' }, status: 415 },
    ];
    for (const { status, ...opts } of cases) {
      expect((await request(tailnet, 'load', {}, opts)).status).toBe(status);
    }
    expect((await request(handler, 'load', {}, { headers: { host: 'box.example.ts.net' } })).status).toBe(403);
  });

  it('does not treat inherited object keys as actions', async () => {
    expect((await request(handler, 'constructor')).status).toBe(404);
  });

  it("explains a database that couldn't be opened", async () => {
    const broken = createDataHandler({ store: null, openError: new Error('disk I/O error') });
    const res = await request(broken, 'load');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'STORAGE_UNAVAILABLE', message: "MoneyLens couldn't open its database: disk I/O error" });
  });
});

describe('data API: database file', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'moneylens-data-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the file readable only by its owner and keeps data across restarts', async () => {
    const file = join(dir, 'nested', 'moneylens.db');
    const first = await openDataStore(file);
    first.save(0, appData(2));
    first.close();
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const again = await openDataStore(file);
    expect(JSON.parse(again.load().json)).toEqual(appData(2));
    expect(again.currentRev()).toBe(1);
    again.close();
  });
});
