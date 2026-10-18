import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecideRequest, SessionRow } from '../api/types';
import { makeList, makeRow } from '../test/fixtures';
import { createMemoryApi } from './memoryApi';

const rowA = makeRow({ id: 'claude-code:a', session_id: 'a', last_prompt: 'fix the login flake' });
const rowEmpty = makeRow({
  id: 'claude-code:e',
  session_id: 'e',
  project_short: '…/work/proj-00',
});
const rowOther = makeRow({ id: 'codex:o', session_id: 'o', project_short: '…/work/proj-01' });
const seed = makeList([rowA, rowEmpty, rowOther]);

function request(row: SessionRow, overrides: Partial<DecideRequest> = {}): DecideRequest {
  return {
    action: 'archive',
    id: row.id,
    mtime: row.mtime,
    fingerprint: row.file_fingerprint,
    until: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 16, 14, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createMemoryApi', () => {
  it('returns tails in request order after the latency', async () => {
    const api = createMemoryApi(seed, { latencyMs: 150 });
    let settled = false;
    const tails = api.tails([rowA.id, 'claude-code:nope']).then((doc) => {
      settled = true;
      return doc;
    });
    await vi.advanceTimersByTimeAsync(149);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const [first, second] = (await tails).items;
    expect(first).toMatchObject({ id: rowA.id, mtime: rowA.mtime, unavailable: null });
    expect(first?.text).toContain('## USER\nfix the login flake');
    expect(first?.text.length).toBeGreaterThan(11_000);
    expect(second).toEqual({
      id: 'claude-code:nope',
      text: '',
      max_chars: 50_000,
      truncated: false,
      unavailable: 'no longer in the registry',
      mtime: null,
      file_fingerprint: null,
    });
  });

  it('serves the cached seed after 5 ms', async () => {
    const api = createMemoryApi(seed);
    const cached = api.cachedList();
    await vi.advanceTimersByTimeAsync(5);
    const list = await cached;
    expect(list?.sessions.map((row) => row.id)).toEqual([rowA.id, rowEmpty.id, rowOther.id]);
    expect(list?.generated_at).toBe(new Date(Date.now() - 3_600_000).toISOString());
  });

  it('has no cache when disabled', async () => {
    const api = createMemoryApi(seed, { cache: false });
    const cached = api.cachedList();
    await vi.advanceTimersByTimeAsync(5);
    expect(await cached).toBeNull();
  });

  it('archives a valid row and drops it from the next list', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    const decided = api.decide(request(rowA));
    await vi.advanceTimersByTimeAsync(10);
    expect(await decided).toMatchObject({ status: 'ok', wrote: true, action: 'archive' });
    const listed = api.list();
    await vi.advanceTimersByTimeAsync(10);
    const list = await listed;
    expect(list.sessions.map((row) => row.id)).toEqual([rowEmpty.id, rowOther.id]);
    expect(list.registry).toBe('/fake/world/xdg-data/ringleader/registry.json');
  });

  it('refuses an archive with a stale mtime', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    const decided = api.decide(request(rowA, { mtime: '2026-01-01T00:00:00+00:00' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(await decided).toMatchObject({
      status: 'refused',
      reason: 'changed since you looked',
      wrote: false,
    });
  });

  it('finds nothing worth harvesting in proj-00', async () => {
    const api = createMemoryApi(seed, { harvestDelayMs: 1_500 });
    const decided = api.decide(request(rowEmpty, { action: 'harvest' }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await decided).toMatchObject({ status: 'empty', wrote: false });
  });

  it('keeps going on a running row, as ringleader does not revalidate it', async () => {
    const running = makeRow({ id: 'claude-code:r', running: true });
    const api = createMemoryApi(makeList([running]), { latencyMs: 10 });
    const archive = api.decide(request(running));
    const keepGoing = api.decide(request(running, { action: 'keep_going' }));
    await vi.advanceTimersByTimeAsync(10);
    expect((await archive).status).toBe('refused');
    expect((await keepGoing).status).toBe('ok');
  });

  it('invokes the registered close handler on requestClose', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    const handler = vi.fn();
    const registered = api.onCloseRequested(handler);
    await vi.advanceTimersByTimeAsync(10);
    await registered;
    api.requestClose();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
