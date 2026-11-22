// Monthly money review: summaries Claude writes from the review's figures (worked out in the browser,
// src/utils/review.js), kept in their own table of MoneyLens's database, and a phone notification through ntfy
// when a month's review is ready. Runs inside the Vite dev/preview server like the other local APIs.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ApiError, actionName, checkRequest, parseHostList, readJson, sendError, sendJson } from './http.js';
import { DEFAULT_DATA_FILE } from './dataApi.js';
import { MODEL, anthropicClient, asApiError, notConfigured, parseWithClaude } from './anthropic.js';

const MAX_BODY_BYTES = 256 * 1024;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// The notification for a month goes out from this day of the next month, at this hour (local time), so the
// month's last charges have posted
export const NOTICE_DAY = 2;
export const NOTICE_HOUR = 9;
const CHECK_EVERY_MS = 30 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
export const hashFacts = (facts) => createHash('sha256').update(JSON.stringify(facts)).digest('hex');
const monthName = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

export async function openReviewStore(file, { now = () => new Date() } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:' && !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, '', { mode: 0o600 });
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS review_summaries (
      month TEXT PRIMARY KEY,
      facts_hash TEXT NOT NULL,
      summary TEXT NOT NULL,
      model TEXT,
      written_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_notices (
      month TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL
    )`);
  const selectSummary = db.prepare('SELECT month, facts_hash, summary, model, written_at FROM review_summaries WHERE month = ?');
  const upsertSummary = db.prepare(`INSERT INTO review_summaries (month, facts_hash, summary, model, written_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET facts_hash = excluded.facts_hash, summary = excluded.summary, model = excluded.model, written_at = excluded.written_at`);
  const selectNotice = db.prepare('SELECT 1 FROM review_notices WHERE month = ?');
  const insertNotice = db.prepare('INSERT OR IGNORE INTO review_notices (month, sent_at) VALUES (?, ?)');
  return {
    getSummary(month) {
      const row = selectSummary.get(month);
      return row && { hash: row.facts_hash, summary: JSON.parse(row.summary), model: row.model, writtenAt: row.written_at };
    },
    putSummary(month, hash, summary, model) {
      upsertSummary.run(month, hash, JSON.stringify(summary), model || null, now().toISOString());
    },
    noticeSent: (month) => Boolean(selectNotice.get(month)),
    markNotice: (month) => insertNotice.run(month, now().toISOString()),
    close: () => db.close(),
  };
}

const SYSTEM = `You write a short monthly money review for one person, from figures their personal finance app worked out.
Write like a friend who is good with money: plain, specific and warm, without lecturing or generic advice.

- headline: one sentence, the most important thing about the month.
- summary: two to four sentences on how the month went: spending against the usual and the budgets, what stood out,
  and how take-home and spending compare with the person's net worth projection.
- lookAt: up to four short items that deserve attention, most important first (a price increase, an unusual charge, a
  new recurring charge, a category well over budget, a big bill next month). Empty when nothing does.
- Use only the figures given, in whole dollars, and don't work out new totals beyond a simple difference. Spending
  leaves out transfers between the person's own accounts and includes mortgage payments; "spendingWithoutMortgage" is
  the projection's view. If monthIsOver is false, the month is still in progress: say so and don't judge the totals.
  Leave out figures that are null.`;

// Writes a month's summary with Claude. Returns { headline, summary, lookAt, model }.
export async function createReviewWriter({ client }) {
  const { z } = await import('zod');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const Summary = z.object({ headline: z.string(), summary: z.string(), lookAt: z.array(z.string()) });
  return (facts) => parseWithClaude(client, {
    system: SYSTEM,
    content: `<figures>\n${JSON.stringify(facts, null, 1)}\n</figures>\n\nWrite the review for ${facts.month}.`,
    format: betaZodOutputFormat(Summary),
    fallbackHint: 'Try again later.',
  });
}

// Push notifications through ntfy (https://ntfy.sh, or a server of your own). `topic` acts as a password on a
// shared server; `token` is for servers or topics that need one.
export function ntfyNotifier({ server = 'https://ntfy.sh', topic, token, fetchImpl = globalThis.fetch }) {
  return {
    async send({ title, message, click }) {
      const res = await fetchImpl(`${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`, {
        method: 'POST',
        body: message,
        headers: { Title: title, Tags: 'moneybag', ...(click && { Click: click }), ...(token && { Authorization: `Bearer ${token}` }) },
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    },
  };
}

// The month whose notification is due at `now` (local time), or null: the month before, from NOTICE_DAY at
// NOTICE_HOUR, once
export function noticeDue(now, sent) {
  const day = now.getDate();
  if (day < NOTICE_DAY || (day === NOTICE_DAY && now.getHours() < NOTICE_HOUR)) return null;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
  return sent(month) ? null : month;
}

// The notification never carries amounts or merchants: it goes through ntfy's server
export const noticeFor = (month, appUrl) => ({
  title: 'MoneyLens',
  message: `Your ${monthName(month)} money review is ready.`,
  click: appUrl ? `${appUrl.replace(/\/+$/, '')}/review?month=${month}` : undefined,
});

// Checks now and every 30 minutes; returns a function that stops it
export function startReviewNotices({ store, notifier, appUrl, now = () => new Date(), every = CHECK_EVERY_MS, log = console.error }) {
  let sending = false;
  const check = async () => {
    const month = noticeDue(now(), store.noticeSent);
    if (!month || sending) return;
    sending = true;
    try {
      await notifier.send(noticeFor(month, appUrl));
      store.markNotice(month);
    } catch (err) {
      log(`MoneyLens couldn't send the ${month} review notification: ${err.message}`);
    } finally {
      sending = false;
    }
  };
  const first = check();
  const timer = setInterval(check, every);
  timer.unref?.();
  return { stop: () => clearInterval(timer), first };
}

const NOT_WRITING = notConfigured('A written summary');
const NOT_NOTIFYING = 'To get a phone notification when a month\'s review is ready, set MONEYLENS_NTFY_TOPIC in .env.local (see .env.example) and restart the server.';

// `write` and `notifier` are null when not set up
export function createReviewHandler({ store, openError, write, notifier, appUrl, allowedHosts = [] }) {
  const writing = new Map(); // month → the summary being written, so two windows don't pay for it twice
  const checkMonth = (month) => {
    if (typeof month !== 'string' || !MONTH.test(month)) throw new ApiError('BAD_REQUEST', 'month must be YYYY-MM.');
  };
  const checkFacts = (facts) => {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new ApiError('BAD_REQUEST', 'facts must be an object.');
  };
  const answer = (row, facts) => (row
    ? { summary: row.summary, model: row.model, writtenAt: row.writtenAt, current: row.hash === hashFacts(facts) }
    : { summary: null });

  const actions = {
    status: () => ({
      writing: Boolean(write),
      model: write ? MODEL : null,
      problem: write ? null : NOT_WRITING,
      notify: Boolean(notifier),
      notifyProblem: notifier ? null : NOT_NOTIFYING,
      noticeDay: NOTICE_DAY,
      noticeHour: NOTICE_HOUR,
    }),

    get({ month, facts }) {
      checkMonth(month);
      checkFacts(facts);
      return answer(store.getSummary(month), facts);
    },

    async write({ month, facts }) {
      checkMonth(month);
      checkFacts(facts);
      if (!write) throw new ApiError('NOT_CONFIGURED', NOT_WRITING, 400);
      const hash = hashFacts(facts);
      const key = `${month}:${hash}`;
      if (!writing.has(key)) {
        writing.set(key, (async () => {
          try {
            const { model, ...summary } = await write(facts);
            store.putSummary(month, hash, summary, model);
          } catch (err) {
            throw await asApiError(err);
          } finally {
            writing.delete(key);
          }
        })());
      }
      await writing.get(key);
      return answer(store.getSummary(month), facts);
    },

    async 'test-notify'() {
      if (!notifier) throw new ApiError('NOT_CONFIGURED', NOT_NOTIFYING, 400);
      try {
        await notifier.send({ title: 'MoneyLens', message: 'Test: monthly review notifications will look like this.', click: appUrl ? `${appUrl.replace(/\/+$/, '')}/review` : undefined });
      } catch (err) {
        throw new ApiError('NOTIFY_FAILED', `The notification couldn't be sent: ${err.message}`, 502);
      }
      return { ok: true };
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

// Vite plugin: mounts the API at /api/review on `npm run dev` and `npm run preview`, and sends the monthly
// notification while the server runs. `vars`: MONEYLENS_DB, MONEYLENS_ALLOWED_HOSTS, ANTHROPIC_API_KEY,
// MONEYLENS_NTFY_TOPIC (+ _SERVER, _TOKEN) and MONEYLENS_APP_URL (the address the notification opens).
export function reviewApiPlugin(vars) {
  const allowedHosts = parseHostList(vars.MONEYLENS_ALLOWED_HOSTS);
  const attach = async (server) => {
    const file = vars.MONEYLENS_DB || DEFAULT_DATA_FILE;
    const opened = await openReviewStore(file).then((store) => ({ store }), (openError) => ({ store: null, openError }));
    if (opened.openError) server.config.logger.error(`MoneyLens couldn't open ${file} for reviews: ${opened.openError.message}`);
    const client = await anthropicClient(vars);
    const write = client ? await createReviewWriter({ client }) : null;
    const topic = vars.MONEYLENS_NTFY_TOPIC?.trim();
    const notifier = topic ? ntfyNotifier({ topic, server: vars.MONEYLENS_NTFY_SERVER || undefined, token: vars.MONEYLENS_NTFY_TOKEN || undefined }) : null;
    const appUrl = vars.MONEYLENS_APP_URL?.trim() || null;
    server.middlewares.use('/api/review', createReviewHandler({ ...opened, write, notifier, appUrl, allowedHosts }));
    if (opened.store && notifier) {
      const notices = startReviewNotices({ store: opened.store, notifier, appUrl, log: (m) => server.config.logger.error(m) });
      // Vite restarts the server when its config changes: stop this one's timer with it
      server.httpServer?.once('close', notices.stop);
    }
  };
  return { name: 'moneylens-review-api', configureServer: attach, configurePreviewServer: attach };
}
