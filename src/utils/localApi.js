// Calls to MoneyLens's local server APIs (receipts, monthly review): POST + JSON, errors as { code, message }.
// On a static host there's no server: those answer with HTML or nothing, and the error says so (code NO_SERVER).

export class LocalApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function localApiRequest(path, body, noServerMessage) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new LocalApiError('NO_SERVER', noServerMessage);
  }
  const json = res.headers.get('content-type')?.includes('application/json') ? await res.json().catch(() => null) : null;
  if (!json) throw new LocalApiError('NO_SERVER', noServerMessage);
  if (!res.ok) throw new LocalApiError(json.error?.code || 'ERROR', json.error?.message || `Request failed (${res.status})`);
  return json;
}
