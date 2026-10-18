import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CircusError, DecideOutcome, DecideRequest, SessionRow } from '../api/types';
import { createFakeApi, NATIVE_INFO, okOutcome, type FakeApi } from '../test/fakeApi';
import { makeList, makeRow } from '../test/fixtures';
import type { Settled } from './outbox';
import { settleEffects, useInbox } from './useInbox';

const rowA = makeRow({ id: 'claude-code:a', session_id: 'a', label: 'fix flaky login' });
const rowB = makeRow({
  id: 'claude-code:b',
  session_id: 'b',
  label: 'fix parser',
  mtime: '2026-10-11T12:00:00+00:00',
});
const rowC = makeRow({ id: 'claude-code:c', session_id: 'c', label: 'docs pass' });

function circusError(kind: CircusError['kind'], message = 'boom'): CircusError {
  return { kind, message, exit_code: null, stderr_tail: null };
}

function outcome(request: DecideRequest, overrides: Partial<DecideOutcome>): DecideOutcome {
  return okOutcome(request, overrides);
}

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mountInbox(api: FakeApi, options: { strict?: boolean } = {}) {
  const view = renderHook(() => useInbox(api), { reactStrictMode: options.strict ?? false });
  await flush();
  return view;
}

const ids = (rows: readonly SessionRow[]) => rows.map((row) => row.id);
const texts = (api: { current: ReturnType<typeof useInbox> }) =>
  api.current.toasts.map((toast) => toast.text);
const methods = (api: FakeApi) =>
  api.calls.map((call) => call.method).filter((m) => m !== 'setPending' && m !== 'closeAck');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 16, 14, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useInbox loading', () => {
  it('loads cache, app info, list and scan, then lists again after the scan', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    expect(methods(api)).toEqual(['cachedList', 'appInfo', 'list', 'scan', 'list']);
    expect(result.current.scanCount).toBe(1);
    expect(result.current.info).toEqual(NATIVE_INFO);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(result.current.scanning).toBe(false);
  });

  it('loads once and listens once under StrictMode', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api, { strict: true });
    expect(methods(api)).toEqual(['cachedList', 'appInfo', 'list', 'scan', 'list']);
    expect(api.listening).toBe(true);
    expect(api.argsOf('setPending').at(-1)).toEqual([0]);
    expect(ids(result.current.rows)).toEqual([rowA.id]);
  });

  it('paints a cached list as stale until the live list lands', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    api.reply('cachedList', makeList([rowA, rowB, rowC]));
    const live = api.defer('list');
    const { result } = await mountInbox(api);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id, rowC.id]);
    expect(result.current.listStale).toBe(true);
    live.resolve(makeList([rowA, rowB]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(result.current.listStale).toBe(false);
  });

  it('ignores a cached list that arrives after the live list', async () => {
    const api = createFakeApi(makeList([rowA]));
    const cached = api.defer('cachedList');
    const { result } = await mountInbox(api);
    cached.resolve(makeList([rowA, rowB, rowC]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowA.id]);
    expect(result.current.listStale).toBe(false);
  });

  it('carries on silently when the cache read fails', async () => {
    const api = createFakeApi(makeList([rowA]));
    api.fail('cachedList', circusError('failed'));
    const { result } = await mountInbox(api);
    expect(result.current.toasts).toEqual([]);
    expect(ids(result.current.rows)).toEqual([rowA.id]);
  });

  it('memoizes rows across a re-render that changed nothing', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result, rerender } = await mountInbox(api);
    const first = result.current.rows;
    rerender();
    expect(result.current.rows).toBe(first);
  });

  it('coalesces list requests and adopts the newest response', async () => {
    const api = createFakeApi(makeList([rowA]));
    const first = api.defer('list');
    api.reply('list', makeList([rowB]));
    api.defer('scan');
    const { result } = await mountInbox(api);
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(api.count('list')).toBe(1);
    first.resolve(makeList([rowA]));
    await flush();
    expect(api.count('list')).toBe(2);
    expect(ids(result.current.rows)).toEqual([rowB.id]);
  });

  it('queues a rescan behind the startup scan', async () => {
    const api = createFakeApi(makeList([rowA]));
    const startup = api.defer('scan');
    const { result } = await mountInbox(api);
    expect(result.current.scanning).toBe(true);
    act(() => result.current.rescan());
    expect(texts(result)).toContain('Rescan queued');
    startup.resolve({
      version: 1,
      kind: 'scan',
      scanned_at: '',
      added: 0,
      removed: 0,
      unavailable_sources: [],
    });
    await flush();
    expect(api.count('scan')).toBe(2);
    expect(result.current.scanCount).toBe(2);
  });

  it('shows a warning when a scan fails and keeps the list', async () => {
    const api = createFakeApi(makeList([rowA]));
    api.fail('scan', circusError('timeout', 'scan took too long'));
    const { result } = await mountInbox(api);
    expect(texts(result)).toContain('Rescan failed: scan took too long');
    expect(ids(result.current.rows)).toEqual([rowA.id]);
  });

  it('refetches on focus once the last list is older than a minute', async () => {
    const api = createFakeApi(makeList([rowA]));
    await mountInbox(api);
    expect(api.count('list')).toBe(2);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.count('list')).toBe(2);
    await advance(60_001);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(api.count('list')).toBe(3);
  });
});

describe('useInbox decisions', () => {
  it('hides the row, sends after the undo window and keeps it hidden until a later list', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    const sent = api.defer('decide');
    act(() => {
      expect(result.current.decide('archive', rowA)).toBe(true);
    });
    expect(ids(result.current.rows)).toEqual([rowB.id]);
    expect(texts(result)).toContain('Archive “fix flaky login”');
    await advance(3_999);
    expect(api.count('decide')).toBe(0);
    await advance(1);
    expect(api.argsOf('decide')).toEqual([
      [
        {
          action: 'archive',
          id: rowA.id,
          mtime: rowA.mtime,
          fingerprint: rowA.file_fingerprint,
          until: null,
        },
      ],
    ]);
    const before = api.defer('list');
    const after = api.defer('list');
    act(() => result.current.refresh());
    sent.resolve(okOutcome(api.decideRequest(0)));
    await flush();
    expect(texts(result)).toContain('Archived “fix flaky login”');
    before.resolve(makeList([rowA, rowB]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowB.id]);
    expect(api.count('list')).toBe(4);
    after.resolve(makeList([rowA, rowB]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
  });

  it('restores the row and rescans after a "changed since you looked" refusal', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.setDefault('decide', (request) =>
      Promise.resolve(
        outcome(request, {
          status: 'refused',
          reason: 'changed since you looked',
          message: 'changed since you looked',
          wrote: false,
        }),
      ),
    );
    act(() => {
      result.current.decide('archive', rowA);
    });
    await advance(4_000);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(texts(result)).toContain('changed since you looked — rescanning to pick up the change');
    expect(api.count('scan')).toBe(2);
    expect(methods(api).slice(-4)).toEqual(['decide', 'list', 'scan', 'list']);
  });

  it('restores the row and lists without a rescan after another refusal', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.setDefault('decide', (request) =>
      Promise.resolve(
        outcome(request, {
          status: 'refused',
          reason: 'fix flaky login is running',
          message: 'fix flaky login is running',
          wrote: false,
        }),
      ),
    );
    act(() => {
      result.current.decide('archive', rowA);
    });
    await advance(4_000);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(texts(result)).toContain('fix flaky login is running');
    expect(api.count('scan')).toBe(1);
    expect(methods(api).slice(-2)).toEqual(['decide', 'list']);
  });

  it('keeps the row hidden and refreshes when the result is unknown', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.fail('decide', circusError('timeout', 'rl gui decide timed out'));
    api.setList(makeList([rowB]));
    act(() => {
      result.current.decide('archive', rowA);
    });
    await advance(4_000);
    expect(ids(result.current.rows)).toEqual([rowB.id]);
    expect(texts(result)).toContain('Archive “fix flaky login”: result unknown — refreshing');
    expect(methods(api).slice(-2)).toEqual(['decide', 'list']);
    await advance(60_000);
    expect(api.count('decide')).toBe(1);
  });

  it('restores the row with an error toast and no refetch for a definite error', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.fail('decide', circusError('invalid_argument', 'bad mtime'));
    act(() => {
      result.current.decide('archive', rowA);
    });
    await advance(4_000);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(result.current.toasts.at(-1)).toMatchObject({
      tone: 'error',
      text: 'Archive “fix flaky login” failed: bad mtime',
    });
    expect(methods(api).at(-1)).toBe('decide');
    await advance(60_000);
    expect(api.count('decide')).toBe(1);
  });

  it('restores an empty harvest without another list', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.setDefault('decide', (request) =>
      Promise.resolve(outcome(request, { status: 'empty', message: 'nothing', wrote: false })),
    );
    act(() => {
      result.current.decide('harvest', rowA);
    });
    await advance(4_000);
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
    expect(texts(result)).toContain(
      'Nothing worth harvesting in “fix flaky login” — ⇧E archives it without a harvest',
    );
    expect(methods(api).at(-1)).toBe('decide');
  });

  it.each([
    ['a running row', makeRow({ ...rowA, running: true }), 'is running'],
    ['a row with unknown presence', makeRow({ ...rowA, running: null }), "Can't tell whether"],
  ])('refuses to archive %s client-side', async (_name, row, text) => {
    const api = createFakeApi(makeList([row]));
    const { result } = await mountInbox(api);
    act(() => {
      expect(result.current.decide('archive', row)).toBe(false);
    });
    expect(result.current.entries).toEqual([]);
    expect(result.current.toasts.at(-1)?.text).toContain(text);
    await advance(10_000);
    expect(api.count('decide')).toBe(0);
  });

  it('refuses every decision in a sandbox whose registry lies outside the world', async () => {
    const api = createFakeApi(makeList([rowA], { registry: '/x/registry.json' }));
    api.setDefault('appInfo', () =>
      Promise.resolve({ ...NATIVE_INFO, environment_label: 'sandbox', world_root: '/w' }),
    );
    const { result } = await mountInbox(api);
    expect(result.current.decisionsBlocked).toBe(
      'Sandbox registry /x/registry.json is outside /w — decisions are disabled',
    );
    act(() => {
      expect(result.current.decide('keep', rowA)).toBe(false);
    });
    expect(result.current.entries).toEqual([]);
    expect(texts(result)).toContain(
      'Sandbox registry /x/registry.json is outside /w — decisions are disabled',
    );
  });

  it('refuses a second decision for a row that already has one pending', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api);
    act(() => {
      result.current.decide('archive', rowA);
    });
    act(() => {
      expect(result.current.decide('delete', rowA)).toBe(false);
    });
    expect(texts(result)).toContain('“fix flaky login” already has a pending change');
    expect(result.current.entries).toHaveLength(1);
  });

  it('undoes the newest pending decision and reports when nothing is left', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    api.setList(makeList([rowB]));
    act(() => {
      result.current.decide('archive', rowA);
    });
    await advance(4_000);
    act(() => {
      result.current.decide('delete', rowB);
    });
    act(() => {
      expect(result.current.undo()?.row.id).toBe(rowB.id);
    });
    expect(texts(result)).toContain('Undid delete “fix parser”');
    expect(ids(result.current.rows)).toEqual([rowB.id]);
    act(() => {
      expect(result.current.undo()).toBeNull();
    });
    expect(result.current.toasts.at(-1)).toMatchObject({
      text: 'Nothing to undo — already sent',
      detail: 'rl session unarchive a brings an archive back',
    });
  });

  it('keeps a snoozed row hidden until a later list, which shows it woken at the same mtime', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    const sent = api.defer('decide');
    const until = new Date(2026, 9, 17, 9, 0).toISOString();
    act(() => {
      expect(result.current.decide('snooze', rowA, until)).toBe(true);
    });
    await advance(4_000);
    const before = api.defer('list');
    const after = api.defer('list');
    act(() => result.current.refresh());
    sent.resolve(okOutcome(api.decideRequest(0)));
    await flush();
    before.resolve(makeList([rowB]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowB.id]);
    after.resolve(makeList([rowA, rowB]));
    await flush();
    expect(ids(result.current.rows)).toEqual([rowA.id, rowB.id]);
  });

  it('keeps a decision toast when a burst of toasts overflows the limit', async () => {
    const api = createFakeApi(makeList([rowA, rowB]));
    const { result } = await mountInbox(api);
    act(() => {
      result.current.decide('archive', rowA);
    });
    act(() => {
      for (let i = 0; i < 8; i += 1)
        result.current.notify({ tone: 'info', text: `n${i}`, undo: false, detail: null });
    });
    expect(result.current.toasts.length).toBeLessThanOrEqual(6);
    expect(texts(result)).toContain('Archive “fix flaky login”');
    expect(texts(result)).toContain('n7');
  });

  it('keeps a warning toast ahead of plain info toasts on overflow', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api);
    act(() => {
      result.current.notify({ tone: 'warning', text: 'careful', undo: false, detail: null });
      for (let i = 0; i < 8; i += 1)
        result.current.notify({ tone: 'info', text: `n${i}`, undo: false, detail: null });
    });
    expect(texts(result)).toContain('careful');
    expect(result.current.toasts).toHaveLength(5);
  });

  it('sends nothing and clears toast timers after unmount', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result, unmount } = await mountInbox(api);
    act(() => {
      result.current.decide('archive', rowA);
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    await advance(60_000);
    expect(api.count('decide')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useInbox close flow', () => {
  it('reports an error and exits on a later close request when exit fails', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api);
    api.fail('exit', circusError('failed', 'exit denied'));
    act(() => api.emitCloseRequested());
    await flush();
    expect(texts(result)).toContain('Could not quit: exit denied');
    expect(result.current.closing).toBe(false);
    act(() => api.emitCloseRequested());
    await flush();
    expect(api.count('exit')).toBe(2);
  });
  it('reports the pending count once the close listener is registered', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api);
    expect(api.argsOf('setPending')).toEqual([[0]]);
    act(() => {
      result.current.decide('archive', rowA);
    });
    await flush();
    expect(api.argsOf('setPending')).toEqual([[0], [1]]);
  });

  it('acks, sends pending decisions at once and exits when they finish', async () => {
    const api = createFakeApi(makeList([rowA]));
    const { result } = await mountInbox(api);
    const sent = api.defer('decide');
    act(() => {
      result.current.decide('archive', rowA);
    });
    act(() => api.emitCloseRequested());
    await flush();
    expect(api.count('closeAck')).toBe(1);
    expect(result.current.closing).toBe(true);
    expect(api.count('decide')).toBe(1);
    expect(api.count('exit')).toBe(0);
    sent.resolve(okOutcome(api.decideRequest(0)));
    await flush();
    expect(api.count('exit')).toBe(1);
  });

  it('exits at once when nothing is pending', async () => {
    const api = createFakeApi(makeList([rowA]));
    await mountInbox(api);
    act(() => api.emitCloseRequested());
    await flush();
    expect(api.count('closeAck')).toBe(1);
    expect(api.count('exit')).toBe(1);
  });

  it('discards unsent decisions and exits after the in-flight ones finish', async () => {
    const api = createFakeApi(makeList([rowA, rowB, rowC]));
    const { result } = await mountInbox(api);
    const harvest = api.defer('decide');
    act(() => {
      result.current.decide('harvest', rowA);
    });
    await advance(4_000);
    const keep = api.defer('decide');
    act(() => {
      result.current.decide('keep_going', rowB);
      result.current.decide('archive', rowC);
    });
    await advance(4_000);
    expect(result.current.entries.map((e) => [e.decision.action, e.state])).toEqual([
      ['harvest', 'sending'],
      ['keep_going', 'sending'],
      ['archive', 'queued'],
    ]);
    act(() => api.emitCloseRequested());
    await flush();
    act(() => result.current.discardUnsent());
    expect(result.current.entries).toHaveLength(2);
    keep.resolve(okOutcome(api.decideRequest(1)));
    await flush();
    expect(api.count('exit')).toBe(0);
    harvest.resolve(okOutcome(api.decideRequest(0)));
    await flush();
    expect(api.count('exit')).toBe(1);
    expect(api.argsOf('decide').map(([request]) => request.action)).toEqual([
      'harvest',
      'keep_going',
    ]);
  });
});

describe('settleEffects', () => {
  const decision = { ticket: 1, action: 'archive' as const, row: rowA, until: null };
  const request: DecideRequest = {
    action: 'archive',
    id: rowA.id,
    mtime: rowA.mtime,
    fingerprint: null,
    until: null,
  };
  const settled = (overrides: Partial<DecideOutcome>): Settled => ({
    kind: 'outcome',
    decision,
    outcome: outcome(request, overrides),
  });

  it.each([
    ['ok', settled({}), [true, true, false]],
    [
      'failed but wrote',
      settled({ status: 'failed', wrote: true, message: 'partial' }),
      [true, true, false],
    ],
    [
      'refused, changed',
      settled({ status: 'refused', wrote: false, reason: 'changed since you looked: mtime' }),
      [false, true, true],
    ],
    [
      'refused, running',
      settled({ status: 'refused', wrote: false, reason: 'running' }),
      [false, true, false],
    ],
    ['failed', settled({ status: 'failed', wrote: false }), [false, true, false]],
    ['empty', settled({ status: 'empty', wrote: false }), [false, false, false]],
    [
      'unknown',
      { kind: 'unknown', decision, error: circusError('timeout') } as Settled,
      [true, true, false],
    ],
    [
      'error',
      { kind: 'error', decision, error: circusError('invalid_argument') } as Settled,
      [false, false, false],
    ],
  ])('%s → markApplied, refetch, rescan', (_name, input, expected) => {
    const effects = settleEffects(input);
    expect([effects.markApplied, effects.refetch, effects.rescan]).toEqual(expected);
  });
});
