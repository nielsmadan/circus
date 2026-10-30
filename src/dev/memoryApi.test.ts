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
  it('answers a scan with the current list and a scan summary', async () => {
    const api = createMemoryApi(seed, { latencyMs: 150 });
    const scan = api.scan();
    await vi.advanceTimersByTimeAsync(300);
    const doc = await scan;
    expect(doc.kind).toBe('list');
    expect(doc.sessions.map((row) => row.id)).toEqual([rowA.id, rowEmpty.id, rowOther.id]);
    expect(doc.scan).toEqual({
      scanned_at: doc.generated_at,
      added: 0,
      removed: 0,
      unavailable_sources: [],
    });
  });

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

  async function decided(api: ReturnType<typeof createMemoryApi>, req: DecideRequest) {
    const pending = api.decide(req);
    await vi.advanceTimersByTimeAsync(2_000);
    return pending;
  }

  it('refuses destructive actions on a session that left the registry, and fails the rest', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    const gone = makeRow({ id: 'claude-code:gone', session_id: 'gone' });
    expect(await decided(api, request(gone))).toMatchObject({
      status: 'refused',
      reason: 'no longer in the registry',
      message: 'claude-code:gone: no longer in the registry',
    });
    expect(await decided(api, request(gone, { action: 'harvest' }))).toMatchObject({
      status: 'refused',
      reason: 'no longer in the registry',
      message: 'no longer in the registry',
    });
    expect(await decided(api, request(gone, { action: 'keep' }))).toMatchObject({
      status: 'failed',
      reason: null,
      message: 'claude-code:gone: no longer in the registry',
    });
  });

  it.each([null, 'fp-1', '1:2:3:4'])(
    'refuses a destructive action with fingerprint %s before reading the registry',
    async (fingerprint) => {
      const api = createMemoryApi(seed, { latencyMs: 10 });
      const gone = makeRow({ id: 'claude-code:gone' });
      for (const action of ['archive', 'delete', 'harvest'] as const) {
        expect(await decided(api, request(gone, { action, fingerprint }))).toMatchObject({
          status: 'refused',
          reason: 'changed since you looked: no fingerprint, rescan',
        });
      }
    },
  );

  it('refuses a lifecycle-blocked row first, naming the action', async () => {
    const blocked = makeRow({
      id: 'opencode:b',
      label: 'blocked',
      running: true,
      lifecycle_block:
        'cannot archive opencode session b: the source has no filesystem transcript lifecycle',
    });
    const api = createMemoryApi(makeList([blocked]), { latencyMs: 10 });
    for (const action of ['archive', 'delete', 'harvest'] as const) {
      expect(
        await decided(api, request(blocked, { action, mtime: '2026-01-01T00:00:00+00:00' })),
      ).toMatchObject({
        status: 'refused',
        reason: `cannot ${action} opencode session b: the source has no filesystem transcript lifecycle`,
      });
    }
  });

  it('refuses a changed row before a running one', async () => {
    const running = makeRow({ id: 'claude-code:r', label: 'busy', running: true });
    const api = createMemoryApi(makeList([running]), { latencyMs: 10 });
    const stale = { mtime: '2026-01-01T00:00:00+00:00' };
    expect(await decided(api, request(running, stale))).toMatchObject({
      status: 'refused',
      reason: 'changed since you looked',
      message: 'busy: changed since you looked',
    });
    expect(await decided(api, request(running, { ...stale, action: 'harvest' }))).toMatchObject({
      reason: 'changed since you looked',
      message: 'changed since you looked',
    });
  });

  it('treats unknown presence as running', async () => {
    const unknown = makeRow({ id: 'claude-code:u', label: 'unsure', running: null });
    const api = createMemoryApi(makeList([unknown]), { latencyMs: 10 });
    expect(await decided(api, request(unknown, { action: 'delete' }))).toMatchObject({
      status: 'refused',
      reason:
        "can't tell whether unsure is running — install presence with rl data presence install",
    });
  });

  it.each([
    ['2026-13-45T99:99:99+00:00', "--until is not an ISO 8601 time: '2026-13-45T99:99:99+00:00'"],
    ['2026-10-20T09:00:00', '--until needs a timezone offset'],
    ['2026-10-01T09:00:00+00:00', 'snooze time must be in the future'],
  ])('refuses a snooze until %s', async (until, reason) => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    expect(await decided(api, request(rowA, { action: 'snooze', until }))).toMatchObject({
      status: 'refused',
      reason,
    });
  });

  it('rejects a snooze without until as Rust does, and snoozes a future one', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    await expect(
      api.decide(request(rowA, { action: 'snooze', until: null })),
    ).rejects.toMatchObject({ kind: 'invalid_argument' });
    expect(
      await decided(api, request(rowA, { action: 'snooze', until: '2026-10-20T07:00:00.000Z' })),
    ).toMatchObject({ status: 'ok' });
  });

  it('invokes the registered close handler on requestClose', async () => {
    const api = createMemoryApi(seed, { latencyMs: 10 });
    const handler = vi.fn();
    const registered = api.onCloseRequested(handler);
    await vi.advanceTimersByTimeAsync(10);
    await registered;
    api.requestClose();
    expect(handler.mock.calls).toEqual([[450_000]]);
  });
});
