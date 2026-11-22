// Receipts for the HSA receipt vault: the files (photos and PDFs) in their own table of MoneyLens's database,
// and reading a receipt with Claude. Runs inside the Vite dev/preview server like the data API. Each
// receipt's details live in the app's data (data.hsa.receipts); the browser never sees the API key.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError, actionName, checkRequest, parseHostList, readJson, sendError, sendJson } from './http.js';
import { DEFAULT_DATA_FILE } from './dataApi.js';
import { MODEL, anthropicClient, asApiError, notConfigured, parseWithClaude } from './anthropic.js';

// What can be stored and read: what Claude accepts as images, plus PDFs
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BODY_BYTES = 22 * 1024 * 1024; // a 15 MB file as base64, plus the JSON around it
export const RECEIPT_MODEL = MODEL;

// The first bytes of each type, so a file can't be stored under a type it isn't
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};

// file: a path, or ':memory:' for tests. Shares MoneyLens's database file with the data API (its own table).
export async function openReceiptStore(file, { now = () => new Date() } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:' && !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600 });
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS receipt_files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT NOT NULL
    )`);
  const insert = db.prepare('INSERT INTO receipt_files (id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?)');
  const select = db.prepare('SELECT id, name, mime, data FROM receipt_files WHERE id = ?');
  const drop = db.prepare('DELETE FROM receipt_files WHERE id = ?');
  return {
    add(name, mime, bytes) {
      const id = `file_${randomUUID()}`;
      insert.run(id, name, mime, bytes, now().toISOString());
      return id;
    },
    get: (id) => select.get(id) || null,
    remove: (id) => drop.run(id).changes > 0,
    close: () => db.close(),
  };
}

const SYSTEM = `You read medical receipts, bills, pharmacy receipts and explanation-of-benefits documents for someone
keeping records of medical expenses they paid out of pocket, to reimburse themselves later from a health savings
account (HSA).

- amount: what the patient paid or owes, not the billed charge or what insurance paid. 0 when it isn't shown.
- serviceDate: the date of service or purchase as YYYY-MM-DD, or an empty string when it isn't shown.
- eligible: whether this is a qualified medical expense under IRS rules (Publication 502); "unsure" when it depends
  on details the document doesn't give (cosmetic work, supplements, mixed purchases).
- notes: anything the person should check, such as insurance still pending, a partial payment, or text you
  couldn't read. Empty when there's nothing to add.
- Use empty strings for anything else the document doesn't show; don't guess.`;

// Reads one stored file with Claude. `client` is an Anthropic SDK client. Returns the fields the review form
// starts from; the person checks them before anything is saved.
export async function createReceiptReader({ client }) {
  const { z } = await import('zod');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const Fields = z.object({
    provider: z.string(),
    serviceDate: z.string(),
    amount: z.number(),
    patient: z.string(),
    category: z.enum(['doctor', 'dental', 'vision', 'pharmacy', 'hospital', 'lab', 'therapy', 'equipment', 'other']),
    description: z.string(),
    eligible: z.enum(['yes', 'no', 'unsure']),
    notes: z.string(),
  });

  return async function read(file) {
    const source = { type: 'base64', media_type: file.mime, data: Buffer.from(file.data).toString('base64') };
    const document = file.mime === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };
    return parseWithClaude(client, {
      system: SYSTEM,
      content: [document, { type: 'text', text: 'Read this receipt.' }],
      format: betaZodOutputFormat(Fields),
      fallbackHint: 'Enter the receipt details by hand.',
    });
  };
}

const NOT_CONFIGURED = `${notConfigured('Reading receipts')} Until then, enter receipt details by hand.`;

const cleanName = (name) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'receipt');

// `store` is null when the database couldn't be opened (`openError` says why); `read` is null when Claude isn't
// set up, and then only reading is refused
export function createReceiptsHandler({ store, openError, read, allowedHosts = [] }) {
  const fileOf = (fileId) => {
    const file = typeof fileId === 'string' ? store.get(fileId) : null;
    if (!file) throw new ApiError('NOT_FOUND', 'That receipt file is not stored here.', 404);
    return file;
  };

  const actions = {
    status: () => ({ reading: Boolean(read), model: read ? RECEIPT_MODEL : null, problem: read ? null : NOT_CONFIGURED }),

    upload({ name, mime, data }) {
      if (!RECEIPT_TYPES.includes(mime)) throw new ApiError('UNSUPPORTED_TYPE', 'Receipts can be JPEG, PNG, WebP or GIF photos, or PDFs.', 415);
      if (typeof data !== 'string' || !data) throw new ApiError('BAD_REQUEST', 'data (base64) is required.');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length > MAX_FILE_BYTES) throw new ApiError('TOO_LARGE', 'Receipts can be up to 15 MB.', 413);
      if (!SIGNATURES[mime](bytes)) throw new ApiError('UNSUPPORTED_TYPE', `That file isn't a ${mime.split('/')[1].toUpperCase()}.`, 415);
      return { fileId: store.add(cleanName(name), mime, bytes) };
    },

    file({ fileId }) {
      const file = fileOf(fileId);
      return { name: file.name, mime: file.mime, data: Buffer.from(file.data).toString('base64') };
    },

    async read({ fileId }) {
      if (!read) throw new ApiError('NOT_CONFIGURED', NOT_CONFIGURED, 400);
      try {
        return await read(fileOf(fileId));
      } catch (err) {
        throw await asApiError(err);
      }
    },

    delete({ fileId }) {
      return { ok: typeof fileId === 'string' && store.remove(fileId) };
    },
  };

  return async function handler(req, res) {
    try {
      checkRequest(req, allowedHosts);
      const name = actionName(req);
      if (!Object.hasOwn(actions, name)) throw new ApiError('NOT_FOUND', `Unknown action "${name}".`, 404);
      if (!store) throw new ApiError('STORAGE_UNAVAILABLE', `MoneyLens couldn't open its database: ${openError?.message}`, 500);
      const body = await readJson(req, MAX_BODY_BYTES);
      sendJson(req, res, 200, await actions[name](body));
    } catch (err) {
      sendError(req, res, err);
    }
  };
}

// Vite plugin: mounts the API at /api/receipts on `npm run dev` and `npm run preview`. `vars`: MONEYLENS_DB,
// MONEYLENS_ALLOWED_HOSTS and ANTHROPIC_API_KEY (never with a VITE_ prefix). `overrides.file` is for testing.
export function receiptsApiPlugin(vars, overrides = {}) {
  const allowedHosts = parseHostList(vars.MONEYLENS_ALLOWED_HOSTS);
  const attach = async (server) => {
    const file = overrides.file || vars.MONEYLENS_DB || DEFAULT_DATA_FILE;
    const opened = await openReceiptStore(file).then((store) => ({ store }), (openError) => ({ store: null, openError }));
    if (opened.openError) server.config.logger.error(`MoneyLens couldn't open ${file} for receipts: ${opened.openError.message}`);
    const client = await anthropicClient(vars);
    const read = client ? await createReceiptReader({ client }) : null;
    server.middlewares.use('/api/receipts', createReceiptsHandler({ ...opened, read, allowedHosts }));
  };
  return { name: 'moneylens-receipts-api', configureServer: attach, configurePreviewServer: attach };
}
