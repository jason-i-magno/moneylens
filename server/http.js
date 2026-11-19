// Request checks and JSON helpers shared by the local APIs (Bank Sync and data storage). They run as
// Vite middleware, which comes before Vite's own host and CORS checks, so they make their own.
import { gunzipSync, gzipSync } from 'node:zlib';

export class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// "a.example, b.example" → ['a.example', 'b.example']: names the APIs answer to besides localhost,
// e.g. the address `tailscale serve` gives this computer (MONEYLENS_ALLOWED_HOSTS)
export function parseHostList(value) {
  return (value || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// Refuses other hosts (DNS rebinding), other sites' pages (cross-site requests), and anything but a
// JSON POST (a page on another site can't send one without a CORS preflight, which is never answered)
export function checkRequest(req, allowedHosts = []) {
  const host = (req.headers.host || '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '');
  if (![...LOCAL_HOSTNAMES, ...allowedHosts].includes(hostname)) {
    const names = ['localhost', ...allowedHosts].join(', ');
    throw new ApiError('FORBIDDEN', `MoneyLens's server only answers requests to ${names}.`, 403);
  }
  const { origin } = req.headers;
  if (origin && origin.toLowerCase() !== `http://${host}` && origin.toLowerCase() !== `https://${host}`) {
    throw new ApiError('FORBIDDEN', 'Cross-origin requests are not allowed.', 403);
  }
  if (req.method !== 'POST') throw new ApiError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Send JSON.', 415);
  }
}

// The action name from a request mounted under its API's prefix: "/save?x" → "save"
export const actionName = (req) => (req.url || '').replace(/^\/+|\?.*$/g, '');

// Parses a JSON object body of at most maxBytes (after unzipping one sent with Content-Encoding: gzip)
export function readJson(req, maxBytes) {
  const gzipped = req.headers['content-encoding'] === 'gzip';
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const tooLarge = () => new ApiError('TOO_LARGE', 'Request body too large.', 413);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(tooLarge());
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      let text;
      try {
        const raw = Buffer.concat(chunks);
        text = (gzipped ? gunzipSync(raw, { maxOutputLength: maxBytes }) : raw).toString('utf8');
      } catch (err) {
        reject(err.code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge() : new ApiError('BAD_REQUEST', 'Body is not valid gzip.'));
        return;
      }
      try {
        const body = text ? JSON.parse(text) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch {
        reject(new ApiError('BAD_REQUEST', 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

// `text` is already JSON. Large responses are gzipped for browsers that accept it.
export function sendJsonText(req, res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (text.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.end(gzipSync(text));
  } else {
    res.end(text);
  }
}

export const sendJson = (req, res, status, body) => sendJsonText(req, res, status, JSON.stringify(body));

export const sendError = (req, res, err, message = err.message) => sendJson(req, res, err instanceof ApiError ? err.status : 500, {
  error: { code: err.code || 'SERVER_ERROR', message },
});
