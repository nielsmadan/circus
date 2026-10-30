import { describe, expect, it, vi } from 'vitest';
import { makeList, makeScanSummary } from '../test/fixtures';
import { createCircusApi, decodeDocument, type InvokeFn, type ListenFn } from './client';
import type { CircusError, DecideRequest } from './types';

function bytes(doc: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

function fakeInvoke(result: unknown) {
  return vi.fn<InvokeFn>(() => Promise.resolve(result));
}

const noListen: ListenFn = () => Promise.resolve(() => undefined);

const timeout: CircusError = {
  kind: 'timeout',
  message: 'rl inbox timed out',
  exit_code: null,
  stderr_tail: null,
};

describe('decodeDocument', () => {
  it('parses an ArrayBuffer and returns null for zero bytes', () => {
    expect(decodeDocument(bytes({ kind: 'list' }))).toEqual({ kind: 'list' });
    expect(decodeDocument(new ArrayBuffer(0))).toBeNull();
  });

  it('throws bad_output for something that is not bytes', () => {
    expect(() => decodeDocument('{"kind":"list"}')).toThrow(
      expect.objectContaining({ kind: 'bad_output' }),
    );
  });
});

describe('createCircusApi', () => {
  it('lists through rl_list and decodes the bytes', async () => {
    const doc = makeList([]);
    const invoke = fakeInvoke(bytes(doc));
    await expect(createCircusApi(invoke, noListen).list()).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith('rl_list', {});
  });

  it('decodes a Uint8Array the same way', async () => {
    const doc = makeList([]);
    const invoke = fakeInvoke(new TextEncoder().encode(JSON.stringify(doc)));
    await expect(createCircusApi(invoke, noListen).list()).resolves.toEqual(doc);
  });

  it('scans through rl_scan and returns the list it printed', async () => {
    const doc = makeList([], {
      scan: makeScanSummary({ added: 2, unavailable_sources: ['opencode'] }),
    });
    const invoke = fakeInvoke(bytes(doc));
    await expect(createCircusApi(invoke, noListen).scan()).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith('rl_scan', {});
  });

  it('decides through rl_decide with the request', async () => {
    const request: DecideRequest = {
      action: 'archive',
      id: 'claude-code:a',
      mtime: '2026-10-10T12:00:00+00:00',
      fingerprint: 'fp',
      until: null,
    };
    const doc = { version: 1, kind: 'outcome', status: 'ok' };
    const invoke = fakeInvoke(bytes(doc));
    await expect(createCircusApi(invoke, noListen).decide(request)).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith('rl_decide', { request });
  });

  it('asks for tails with the per-item character limit', async () => {
    const doc = { version: 1, kind: 'tails', items: [] };
    const invoke = fakeInvoke(bytes(doc));
    await expect(createCircusApi(invoke, noListen).tails(['a:b', 'c:d'])).resolves.toEqual(doc);
    expect(invoke).toHaveBeenCalledWith('rl_tails', {
      request: { ids: ['a:b', 'c:d'], max_chars: 50000 },
    });
  });

  it.each([
    ['no ids', []],
    ['17 ids', Array.from({ length: 17 }, (_, i) => `claude-code:s${i}`)],
  ])('rejects tails with %s without invoking', async (_name, ids) => {
    const invoke = fakeInvoke(bytes({}));
    await expect(createCircusApi(invoke, noListen).tails(ids)).rejects.toMatchObject({
      kind: 'invalid_argument',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns null for an empty cache and the parsed list otherwise', async () => {
    const empty = fakeInvoke(new ArrayBuffer(0));
    await expect(createCircusApi(empty, noListen).cachedList()).resolves.toBeNull();
    expect(empty).toHaveBeenCalledWith('cached_list', {});
    const doc = makeList([]);
    const cached = fakeInvoke(bytes(doc));
    await expect(createCircusApi(cached, noListen).cachedList()).resolves.toEqual(doc);
  });

  it('rejects an empty list body with bad_output', async () => {
    const invoke = fakeInvoke(new ArrayBuffer(0));
    await expect(createCircusApi(invoke, noListen).list()).rejects.toMatchObject({
      kind: 'bad_output',
    });
  });

  it('rejects list bytes that are not JSON with bad_output', async () => {
    const invoke = fakeInvoke(new TextEncoder().encode('not json').buffer);
    await expect(createCircusApi(invoke, noListen).list()).rejects.toMatchObject({
      kind: 'bad_output',
    });
  });

  it('passes the object commands through', async () => {
    const launch = { command: 'rl resume claude-code:a', launched: false, via: 'iterm2' };
    const invoke = fakeInvoke(launch);
    const api = createCircusApi(invoke, noListen);
    await expect(api.resume('claude-code:a')).resolves.toEqual(launch);
    expect(invoke).toHaveBeenCalledWith('resume_session', { request: { id: 'claude-code:a' } });
    await api.appInfo();
    expect(invoke).toHaveBeenLastCalledWith('app_info', {});
  });

  it('invokes the close-flow commands', async () => {
    const invoke = fakeInvoke(null);
    const api = createCircusApi(invoke, noListen);
    await api.setPending(3);
    await api.closeAck();
    await api.exit();
    expect(invoke.mock.calls).toEqual([
      ['set_pending', { count: 3 }],
      ['close_ack', {}],
      ['app_exit', {}],
    ]);
  });

  it('rethrows a CircusError rejection unchanged', async () => {
    const invoke = vi.fn<InvokeFn>(() => Promise.reject(timeout));
    await expect(createCircusApi(invoke, noListen).list()).rejects.toBe(timeout);
  });

  it('turns any other rejection into a failed CircusError', async () => {
    const invoke = vi.fn<InvokeFn>(() => Promise.reject(new Error('x')));
    await expect(createCircusApi(invoke, noListen).appInfo()).rejects.toEqual({
      kind: 'failed',
      message: 'Error: x',
      exit_code: null,
      stderr_tail: null,
    });
  });

  it('subscribes to the close-requested event and passes on the time left', async () => {
    const unlisten = vi.fn();
    const listen = vi.fn<ListenFn>(() => Promise.resolve(unlisten));
    const handler = vi.fn();
    const stop = await createCircusApi(fakeInvoke(null), listen).onCloseRequested(handler);
    expect(listen.mock.calls[0]?.[0]).toBe('circus://close-requested');
    listen.mock.calls[0]?.[1]({ finish_in_ms: 450_000 });
    listen.mock.calls[0]?.[1](null);
    expect(handler.mock.calls).toEqual([[450_000], [null]]);
    expect(stop).toBe(unlisten);
  });

  it('cancels the close gate', async () => {
    const invoke = fakeInvoke(null);
    await createCircusApi(invoke, noListen).closeCancel();
    expect(invoke).toHaveBeenCalledWith('close_cancel', {});
  });
});
