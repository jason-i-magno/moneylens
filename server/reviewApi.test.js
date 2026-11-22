import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  createReviewHandler, createReviewWriter, hashFacts, noticeDue, noticeFor, ntfyNotifier, openReviewStore, startReviewNotices,
} from './reviewApi.js';

function request(handler, action, body = {}, { headers = {} } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: 'POST',
    url: `/${action}`,
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers },
  });
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); },
    };
    handler(req, res);
  });
}

const FACTS = { month: 'October 2026', income: 5000, spending: 4200 };
const SUMMARY = { headline: 'A steady month.', summary: 'Spending was close to usual.', lookAt: ['A streaming price went up.'] };

let store;
beforeEach(async () => {
  store = await openReviewStore(':memory:');
});
afterEach(() => store.close());

describe('review API', () => {
  it('says what is set up', async () => {
    const off = await request(createReviewHandler({ store }), 'status');
    expect(off.body).toMatchObject({ writing: false, notify: false, noticeDay: 2, noticeHour: 9 });
    expect(off.body.problem).toMatch(/ANTHROPIC_API_KEY/);
    expect(off.body.notifyProblem).toMatch(/MONEYLENS_NTFY_TOPIC/);
    const on = await request(createReviewHandler({ store, write: async () => ({}), notifier: { send: async () => {} } }), 'status');
    expect(on.body).toMatchObject({ writing: true, model: 'claude-opus-5-5', problem: null, notify: true, notifyProblem: null });
  });

  it("writes a month's summary once, keeps it, and says when the figures have changed since", async () => {
    let calls = 0;
    const write = async (facts) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { ...SUMMARY, headline: `${facts.month}: a steady month.`, model: 'claude-opus-5-5' };
    };
    const handler = createReviewHandler({ store, write });
    expect((await request(handler, 'get', { month: '2026-10', facts: FACTS })).body).toEqual({ summary: null });

    // Two windows asking at once pay for one summary
    const [a, b] = await Promise.all([request(handler, 'write', { month: '2026-10', facts: FACTS }), request(handler, 'write', { month: '2026-10', facts: FACTS })]);
    expect(calls).toBe(1);
    expect(a.body).toMatchObject({ summary: { ...SUMMARY, headline: 'October 2026: a steady month.' }, model: 'claude-opus-5-5', current: true });
    expect(b.body.summary).toEqual(a.body.summary);

    expect((await request(handler, 'get', { month: '2026-10', facts: FACTS })).body.current).toBe(true);
    expect((await request(handler, 'get', { month: '2026-10', facts: { ...FACTS, spending: 4300 } })).body.current).toBe(false);
    await request(handler, 'write', { month: '2026-10', facts: { ...FACTS, spending: 4300 } });
    expect(calls).toBe(2);
    expect((await request(handler, 'get', { month: '2026-10', facts: { ...FACTS, spending: 4300 } })).body.current).toBe(true);
  });

  it('refuses bad months and facts, writing without Claude, and passes errors on', async () => {
    const handler = createReviewHandler({ store });
    expect((await request(handler, 'get', { month: '2026-13', facts: FACTS })).status).toBe(400);
    expect((await request(handler, 'get', { month: '2026-10', facts: [1] })).status).toBe(400);
    expect((await request(handler, 'write', { month: '2026-10', facts: FACTS })).body.error.code).toBe('NOT_CONFIGURED');
    const failing = createReviewHandler({ store, write: async () => { throw new Error('boom'); } });
    expect((await request(failing, 'write', { month: '2026-10', facts: FACTS })).status).toBe(500);
    expect((await request(handler, 'status', {}, { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('sends a test notification, or says why it can not', async () => {
    const sent = [];
    const handler = createReviewHandler({ store, notifier: { send: async (n) => sent.push(n) }, appUrl: 'https://box.example.ts.net:8443/' });
    expect((await request(handler, 'test-notify')).body).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ title: 'MoneyLens', click: 'https://box.example.ts.net:8443/review' });
    const broken = createReviewHandler({ store, notifier: { send: async () => { throw new Error('ntfy answered 403'); } } });
    expect((await request(broken, 'test-notify')).body.error).toEqual({ code: 'NOTIFY_FAILED', message: "The notification couldn't be sent: ntfy answered 403" });
    expect((await request(createReviewHandler({ store }), 'test-notify')).status).toBe(400);
  });
});

describe('monthly notification', () => {
  const at = (y, m, d, h) => new Date(y, m - 1, d, h);

  it('is due for the month before from the 2nd at 9:00, once', () => {
    const none = () => false;
    expect(noticeDue(at(2026, 11, 1, 12), none)).toBeNull();
    expect(noticeDue(at(2026, 11, 2, 8), none)).toBeNull();
    expect(noticeDue(at(2026, 11, 2, 9), none)).toBe('2026-10');
    expect(noticeDue(at(2026, 11, 21, 9), none)).toBe('2026-10');
    expect(noticeDue(at(2027, 1, 5, 9), none)).toBe('2026-12');
    expect(noticeDue(at(2026, 11, 3, 9), (m) => m === '2026-10')).toBeNull();
  });

  it('says only that the review is ready, and links to it', () => {
    expect(noticeFor('2026-10', 'https://box.example.ts.net:8443')).toEqual({
      title: 'MoneyLens', message: 'Your October 2026 money review is ready.', click: 'https://box.example.ts.net:8443/review?month=2026-10',
    });
    expect(noticeFor('2026-10', null).click).toBeUndefined();
  });

  it('sends when due and records it; a failed send is tried again on the next check', async () => {
    const sent = [];
    let fail = true;
    const notifier = { send: async (n) => { if (fail) throw new Error('offline'); sent.push(n); } };
    const logs = [];
    const first = startReviewNotices({ store, notifier, now: () => at(2026, 11, 2, 10), log: (m) => logs.push(m) });
    await first.first;
    first.stop();
    expect(sent).toEqual([]);
    expect(logs[0]).toMatch(/2026-10 review notification: offline/);
    expect(store.noticeSent('2026-10')).toBe(false);

    fail = false;
    const second = startReviewNotices({ store, notifier, now: () => at(2026, 11, 2, 11) });
    await second.first;
    second.stop();
    expect(sent.map((n) => n.message)).toEqual(['Your October 2026 money review is ready.']);
    expect(store.noticeSent('2026-10')).toBe(true);

    const third = startReviewNotices({ store, notifier, now: () => at(2026, 11, 3, 9) });
    await third.first;
    third.stop();
    expect(sent).toHaveLength(1);
  });

  it('posts to the ntfy topic with a title, link and token', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
    await ntfyNotifier({ topic: 'demo topic', server: 'https://ntfy.example/', token: 'tk_demo', fetchImpl })
      .send({ title: 'MoneyLens', message: 'Ready.', click: 'https://box.example/review' });
    expect(calls[0].url).toBe('https://ntfy.example/demo%20topic');
    expect(calls[0].init).toMatchObject({ method: 'POST', body: 'Ready.', headers: { Title: 'MoneyLens', Click: 'https://box.example/review', Authorization: 'Bearer tk_demo' } });
    await expect(ntfyNotifier({ topic: 't', fetchImpl: async () => ({ ok: false, status: 429 }) }).send({ title: 'x', message: 'y' })).rejects.toThrow('ntfy answered 429');
  });
});

describe('writing a summary', () => {
  it('sends the figures with structured output and returns the parsed summary', async () => {
    const calls = [];
    const client = { beta: { messages: { parse: async (p) => { calls.push(p); return { stop_reason: 'end_turn', parsed_output: SUMMARY, model: 'claude-opus-5-5' }; } } } };
    const write = await createReviewWriter({ client });
    expect(await write(FACTS)).toEqual({ ...SUMMARY, model: 'claude-opus-5-5' });
    expect(calls[0].messages[0].content).toContain('"spending": 4200');
    expect(calls[0].messages[0].content).toContain('Write the review for October 2026.');
    expect(calls[0].output_config).toMatchObject({ effort: 'low' });
    expect(hashFacts(FACTS)).toBe(hashFacts({ ...FACTS }));
  });
});
