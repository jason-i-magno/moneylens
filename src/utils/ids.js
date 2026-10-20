let lastTimestamp = 0;
let sequence = 0;

// `${prefix}_${Date.now()}`, with a `_N` suffix when called more than once in the same millisecond.
// Loops that add several records (PDF imports, auto-created accounts) would otherwise collide.
export function makeId(prefix) {
  const now = Date.now();
  sequence = now === lastTimestamp ? sequence + 1 : 0;
  lastTimestamp = now;
  return sequence === 0 ? `${prefix}_${now}` : `${prefix}_${now}_${sequence}`;
}
