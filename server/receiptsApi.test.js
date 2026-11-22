import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { ApiError } from './http.js';
import { MAX_FILE_BYTES, RECEIPT_MODEL, createReceiptReader, createReceiptsHandler, openReceiptStore } from './receiptsApi.js';

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
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); },
    };
    handler(req, res);
  });
}

// Tiny files with the right first bytes for their types
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image')]);
const PDF = Buffer.from('%PDF-1.7\nfake receipt');
const b64 = (buf) => buf.toString('base64');

const FIELDS = {
  provider: 'Example Family Clinic', serviceDate: '2026-10-02', amount: 45, patient: 'Pat Example',
  category: 'doctor', description: 'Office visit copay', eligible: 'yes', notes: '',
};

let store;
beforeEach(async () => {
  store = await openReceiptStore(':memory:');
});
afterEach(() => store.close());

describe('receipts API: files', () => {
  it('stores a receipt and returns it, then deletes it', async () => {
    const handler = createReceiptsHandler({ store });
    const up = await request(handler, 'upload', { name: 'visit.png', mime: 'image/png', data: b64(PNG) });
    expect(up.status).toBe(200);
    expect(up.body.fileId).toMatch(/^file_/);
    const file = await request(handler, 'file', { fileId: up.body.fileId });
    expect(file.body).toEqual({ name: 'visit.png', mime: 'image/png', data: b64(PNG) });
    expect((await request(handler, 'delete', { fileId: up.body.fileId })).body).toEqual({ ok: true });
    expect((await request(handler, 'file', { fileId: up.body.fileId })).status).toBe(404);
  });

  it("refuses other types, files that aren't what they claim, and files over 15 MB", async () => {
    const handler = createReceiptsHandler({ store });
    expect((await request(handler, 'upload', { name: 'a.txt', mime: 'text/plain', data: b64(Buffer.from('hi')) })).status).toBe(415);
    expect((await request(handler, 'upload', { name: 'a.pdf', mime: 'application/pdf', data: b64(PNG) })).body.error.code).toBe('UNSUPPORTED_TYPE');
    expect((await request(handler, 'upload', { name: 'a.pdf', mime: 'application/pdf' })).status).toBe(400);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_FILE_BYTES)]);
    expect((await request(handler, 'upload', { name: 'big.pdf', mime: 'application/pdf', data: b64(big) })).status).toBe(413);
  });

  it('answers only JSON POSTs to localhost or the extra hosts', async () => {
    const handler = createReceiptsHandler({ store, allowedHosts: ['box.example.ts.net'] });
    expect((await request(handler, 'status', {}, { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await request(handler, 'status', {}, { headers: { host: 'box.example.ts.net:8443', origin: 'https://box.example.ts.net:8443' } })).status).toBe(200);
    expect((await request(handler, 'constructor')).status).toBe(404);
  });

  it("explains a database that couldn't be opened", async () => {
    const res = await request(createReceiptsHandler({ store: null, openError: new Error('disk I/O error') }), 'status');
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
  });
});

describe('receipts API: reading with Claude', () => {
  it('says when reading is not set up, and still stores files', async () => {
    const handler = createReceiptsHandler({ store });
    expect((await request(handler, 'status')).body).toMatchObject({ reading: false, model: null });
    const up = await request(handler, 'upload', { name: 'r.pdf', mime: 'application/pdf', data: b64(PDF) });
    const read = await request(handler, 'read', { fileId: up.body.fileId });
    expect(read.status).toBe(400);
    expect(read.body.error.code).toBe('NOT_CONFIGURED');
  });

  it("returns the reader's fields for a stored file, and passes its errors on", async () => {
    const seen = [];
    const handler = createReceiptsHandler({ store, read: async (file) => { seen.push(file.mime); return { ...FIELDS, model: RECEIPT_MODEL }; } });
    expect((await request(handler, 'status')).body).toMatchObject({ reading: true, model: RECEIPT_MODEL });
    const up = await request(handler, 'upload', { name: 'r.pdf', mime: 'application/pdf', data: b64(PDF) });
    expect((await request(handler, 'read', { fileId: up.body.fileId })).body).toEqual({ ...FIELDS, model: RECEIPT_MODEL });
    expect(seen).toEqual(['application/pdf']);
    expect((await request(handler, 'read', { fileId: 'file_missing' })).status).toBe(404);

    const failing = createReceiptsHandler({ store, read: async () => { throw new ApiError('UNREADABLE', 'nope', 422); } });
    expect((await request(failing, 'read', { fileId: up.body.fileId })).body.error).toEqual({ code: 'UNREADABLE', message: 'nope' });
  });
});

describe('reading a receipt', () => {
  // A stand-in for the Anthropic client: records the request and returns a canned parse result
  const fakeClient = (result) => {
    const calls = [];
    return { calls, client: { beta: { messages: { parse: async (params) => { calls.push(params); return result; } } } } };
  };

  it('sends a PDF as a document and a photo as an image, with structured output, low effort and fallbacks', async () => {
    const { calls, client } = fakeClient({ stop_reason: 'end_turn', parsed_output: FIELDS, model: RECEIPT_MODEL });
    const read = await createReceiptReader({ client });
    expect(await read({ mime: 'application/pdf', data: PDF })).toEqual({ ...FIELDS, model: RECEIPT_MODEL });
    await read({ mime: 'image/png', data: PNG });
    const [pdf, png] = calls;
    expect(pdf).toMatchObject({ model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(pdf.output_config.effort).toBe('low');
    expect(pdf.output_config.format).toBeDefined();
    expect(pdf.messages[0].content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(PDF) } });
    expect(png.messages[0].content[0].type).toBe('image');
  });

  it('turns a refusal or an unparsed reply into a message to enter the details by hand', async () => {
    const refused = await createReceiptReader(fakeClient({ stop_reason: 'refusal', parsed_output: null }));
    await expect(refused({ mime: 'application/pdf', data: PDF })).rejects.toMatchObject({ code: 'REFUSED', status: 422 });
    const empty = await createReceiptReader(fakeClient({ stop_reason: 'max_tokens', parsed_output: null }));
    await expect(empty({ mime: 'application/pdf', data: PDF })).rejects.toMatchObject({ code: 'UNREADABLE' });
  });
});
