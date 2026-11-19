import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSaver } from './storage';

// A fake server: each save waits until the test answers it
function fakeServer() {
  const calls = [];
  const request = (action, body) => new Promise((resolve, reject) => calls.push({ action, body, resolve, reject }));
  const error = (code) => Object.assign(new Error(code), { code });
  return { calls, request, error };
}

describe('saving to the server', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('sends one save at a time, each on top of the version the last one made, and only the newest waiting data', async () => {
    const server = fakeServer();
    const states = [];
    const saver = createSaver({ request: server.request, rev: 4, onState: (s) => states.push(s.status) });

    const first = saver.save({ n: 1 });
    saver.save({ n: 2 });
    const third = saver.save({ n: 3 }, 'Imported a backup');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].body).toEqual({ baseRev: 4, data: { n: 1 } });
    expect(saver.hasUnsaved()).toBe(true);

    server.calls[0].resolve({ rev: 5, savedAt: 't5' });
    await first;
    await vi.runAllTimersAsync();
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].body).toEqual({ baseRev: 5, data: { n: 3 }, note: 'Imported a backup' });

    server.calls[1].resolve({ rev: 6, savedAt: 't6' });
    await expect(third).resolves.toEqual({ rev: 6, savedAt: 't6' });
    expect(saver.rev).toBe(6);
    expect(saver.hasUnsaved()).toBe(false);
    expect(states).toEqual(['saving', 'saving', 'saved']);
  });

  it('keeps the data and tries again when the server is unreachable', async () => {
    const server = fakeServer();
    const states = [];
    const saver = createSaver({ request: server.request, rev: 1, onState: (s) => states.push(s.status), retryDelays: [1000, 5000] });

    const done = saver.save({ n: 1 });
    server.calls[0].reject(server.error('NO_SERVER'));
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toBe('retrying');
    expect(saver.hasUnsaved()).toBe(true);

    // A change made meanwhile replaces the failed one: it holds those changes too
    saver.save({ n: 2 });
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].body).toEqual({ baseRev: 1, data: { n: 2 } });

    server.calls[1].resolve({ rev: 2, savedAt: 't2' });
    await expect(done).resolves.toEqual({ rev: 2, savedAt: 't2' });
    expect(states.at(-1)).toBe('saved');
  });

  it('tries again right away when asked (the window got focus)', async () => {
    const server = fakeServer();
    const saver = createSaver({ request: server.request, rev: 1, retryDelays: [30000] });
    saver.save({ n: 1 });
    server.calls[0].reject(server.error('NO_SERVER'));
    await vi.advanceTimersByTimeAsync(0);
    saver.retryNow();
    expect(server.calls).toHaveLength(2);
  });

  it("drops this window's unsaved changes when another window saved first", async () => {
    const server = fakeServer();
    const states = [];
    const saver = createSaver({ request: server.request, rev: 3, onState: (s) => states.push(s.status) });

    const first = saver.save({ n: 1 });
    const second = saver.save({ n: 2 });
    server.calls[0].reject(server.error('CONFLICT'));
    await expect(first).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(second).rejects.toMatchObject({ code: 'CONFLICT' });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.calls).toHaveLength(1);
    expect(states.at(-1)).toBe('conflict');
    expect(saver.hasUnsaved()).toBe(false);

    // After loading the latest version, saves go on top of it
    saver.setRev(7);
    saver.save({ n: 3 });
    expect(server.calls[1].body).toEqual({ baseRev: 7, data: { n: 3 } });
  });
});
