import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createAppealHandler, createAppealWriter } from './appealApi.js';

function request(handler, action, body = {}, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method: 'POST',
    url: `/${action}`,
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers },
  });
  return new Promise((resolve) => {
    handler(req, { statusCode: 200, setHeader() {}, end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } });
  });
}

const FACTS = { address: '1 Example Rd', noticeValue: 620000, requestedValue: 520000, comparables: [] };
const PROTEST = { letter: 'To the Assessor: ...', reason: 'Comparable sales support $520,000.' };

describe('appeal API', () => {
  it('says whether Claude is set up, and writes the protest when it is', async () => {
    const off = createAppealHandler({});
    expect((await request(off, 'status')).body).toMatchObject({ writing: false, model: null });
    expect((await request(off, 'write', { facts: FACTS })).body.error.code).toBe('NOT_CONFIGURED');

    const seen = [];
    const on = createAppealHandler({ write: async (f) => { seen.push(f.address); return { ...PROTEST, model: 'claude-opus-5-5' }; } });
    expect((await request(on, 'status')).body).toMatchObject({ writing: true, model: 'claude-opus-5-5' });
    expect((await request(on, 'write', { facts: FACTS })).body).toEqual({ ...PROTEST, model: 'claude-opus-5-5' });
    expect(seen).toEqual(['1 Example Rd']);
  });

  it('refuses requests without facts, other hosts and unknown actions', async () => {
    const handler = createAppealHandler({ write: async () => PROTEST });
    expect((await request(handler, 'write', {})).status).toBe(400);
    expect((await request(handler, 'write', { facts: { noticeValue: 1 } })).status).toBe(400);
    expect((await request(handler, 'status', {}, { host: 'evil.example' })).status).toBe(403);
    expect((await request(handler, 'toString')).status).toBe(404);
  });

  it('sends the facts to Claude with structured output', async () => {
    const calls = [];
    const client = { beta: { messages: { parse: async (p) => { calls.push(p); return { stop_reason: 'end_turn', parsed_output: PROTEST, model: 'claude-opus-5-5' }; } } } };
    const write = await createAppealWriter({ client });
    expect(await write(FACTS)).toEqual({ ...PROTEST, model: 'claude-opus-5-5' });
    expect(calls[0].messages[0].content).toContain('"requestedValue": 520000');
    expect(calls[0].output_config.effort).toBe('low');
  });
});
