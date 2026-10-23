// Browser side of Bank Sync: calls the local API (server/plaidApi.js) and opens Plaid Link.

export class PlaidRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const NO_SERVER = "Bank sync needs MoneyLens's local server. Start the app with npm run dev and open it at localhost.";

export async function plaidRequest(action, body = {}) {
  let res;
  try {
    res = await fetch(`/api/plaid/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PlaidRequestError('NO_SERVER', NO_SERVER);
  }
  // A static host answers with HTML (or nothing) instead of the API's JSON
  if (!res.headers.get('content-type')?.includes('application/json')) {
    throw new PlaidRequestError('NO_SERVER', NO_SERVER);
  }
  const json = await res.json();
  if (!res.ok) throw new PlaidRequestError(json.error?.code || 'ERROR', json.error?.message || `Request failed (${res.status})`);
  return json;
}

// Plaid requires Link to load from its CDN; it can't be bundled
const LINK_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
let scriptPromise = null;

function loadLinkScript() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LINK_SCRIPT;
    script.async = true;
    script.onload = () => resolve(window.Plaid);
    script.onerror = () => {
      scriptPromise = null;
      script.remove();
      reject(new PlaidRequestError('LINK_UNAVAILABLE', "Couldn't load Plaid Link. Check your internet connection."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Resolves { publicToken, metadata } on success, or null if the user closed Link
export async function openPlaidLink(linkToken) {
  const Plaid = await loadLinkScript();
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        resolve({ publicToken, metadata });
        setTimeout(() => handler.destroy(), 0);
      },
      onExit: (err) => {
        if (err) reject(new PlaidRequestError(err.error_code || 'LINK_ERROR', err.display_message || err.error_message || 'Plaid Link closed with an error.'));
        else resolve(null);
        setTimeout(() => handler.destroy(), 0);
      },
    });
    handler.open();
  });
}
