import type { CircusApi } from '../api/client';
import type {
  AppInfo,
  DecideOutcome,
  DecideRequest,
  ListResponse,
  TailsResponse,
} from '../api/types';
import { makeList, makeScanSummary } from './fixtures';

type Method = Exclude<keyof CircusApi, 'onCloseRequested'>;
type Result<M extends Method> = Awaited<ReturnType<CircusApi[M]>>;
type Args<M extends Method> = Parameters<CircusApi[M]>;
type Reply<M extends Method> = (...args: Args<M>) => Promise<Result<M>>;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface FakeCall {
  readonly method: Method;
  readonly args: readonly unknown[];
}

export interface FakeApi extends CircusApi {
  readonly calls: readonly FakeCall[];
  count(method: Method): number;
  argsOf<M extends Method>(method: M): Args<M>[];
  decideRequest(index: number): DecideRequest;
  reply<M extends Method>(method: M, value: Result<M>): void;
  fail(method: Method, error: unknown): void;
  defer<M extends Method>(method: M): Deferred<Result<M>>;
  setDefault<M extends Method>(method: M, reply: Reply<M>): void;
  setList(list: ListResponse): void;
  emitCloseRequested(finishInMs?: number | null): void;
  readonly listening: boolean;
}

export const NATIVE_INFO: AppInfo = {
  rl_command: ['rl'],
  rl_source: 'login_shell',
  shell_probe: 'ok',
  environment_label: null,
  world_root: null,
  resume_dry_run: false,
  terminal: 'iterm2',
  settings_path: '/u/Library/Application Support/circus/settings.json',
};

export function okOutcome(
  request: DecideRequest,
  overrides: Partial<DecideOutcome> = {},
): DecideOutcome {
  return {
    version: 1,
    kind: 'outcome',
    action: request.action,
    id: request.id,
    status: 'ok',
    reason: null,
    message: 'done',
    wrote: true,
    path: null,
    warnings: [],
    ...overrides,
  };
}

export function createFakeApi(initial: ListResponse = makeList([])): FakeApi {
  let list = initial;
  let closeHandler: ((finishInMs: number | null) => void) | null = null;
  const calls: FakeCall[] = [];
  const queues = new Map<Method, (() => Promise<unknown>)[]>();

  const tails = (ids: readonly string[]): TailsResponse => {
    const byId = new Map(list.sessions.map((row) => [row.id, row]));
    return {
      version: 1,
      kind: 'tails',
      items: ids.map((id) => ({
        id,
        text: `tail of ${id}`,
        max_chars: 50_000,
        truncated: false,
        unavailable: null,
        mtime: byId.get(id)?.mtime ?? null,
        file_fingerprint: byId.get(id)?.file_fingerprint ?? null,
      })),
    };
  };

  const defaults: { [M in Method]: Reply<M> } = {
    list: () => Promise.resolve(list),
    scan: () => Promise.resolve({ ...list, scan: makeScanSummary() }),
    tails: (ids) => Promise.resolve(tails(ids)),
    cachedList: () => Promise.resolve(null),
    decide: (request) => Promise.resolve(okOutcome(request)),
    resume: (id) => Promise.resolve({ command: `rl resume ${id}`, launched: false, via: 'iterm2' }),
    appInfo: () => Promise.resolve(NATIVE_INFO),
    setPending: () => Promise.resolve(),
    closeAck: () => Promise.resolve(),
    closeCancel: () => Promise.resolve(),
    exit: () => Promise.resolve(),
  };

  const enqueue = (method: Method, produce: () => Promise<unknown>) => {
    queues.set(method, [...(queues.get(method) ?? []), produce]);
  };

  function call<M extends Method>(method: M, ...args: Args<M>): Promise<Result<M>> {
    calls.push({ method, args });
    const [next, ...rest] = queues.get(method) ?? [];
    if (next !== undefined) {
      queues.set(method, rest);
      return next() as Promise<Result<M>>;
    }
    const reply = defaults[method] as (...a: Args<M>) => Promise<Result<M>>;
    return reply(...args);
  }

  return {
    list: () => call('list'),
    scan: () => call('scan'),
    tails: (ids) => call('tails', ids),
    cachedList: () => call('cachedList'),
    decide: (request) => call('decide', request),
    resume: (id) => call('resume', id),
    appInfo: () => call('appInfo'),
    setPending: (count) => call('setPending', count),
    closeAck: () => call('closeAck'),
    closeCancel: () => call('closeCancel'),
    exit: () => call('exit'),
    onCloseRequested: (handler) => {
      closeHandler = handler;
      return Promise.resolve(() => {
        if (closeHandler === handler) closeHandler = null;
      });
    },
    calls,
    count: (method) => calls.filter((c) => c.method === method).length,
    argsOf: <M extends Method>(method: M) =>
      calls.filter((c) => c.method === method).map((c) => c.args as Args<M>),
    decideRequest: (index) => {
      const request = calls.filter((c) => c.method === 'decide')[index]?.args[0];
      if (request === undefined) throw new Error(`no decide call #${index}`);
      return request as DecideRequest;
    },
    reply: (method, value) => enqueue(method, () => Promise.resolve(value)),
    fail: (method, error) => enqueue(method, () => Promise.reject(error as Error)),
    defer: <M extends Method>(method: M) => {
      const d = deferred<Result<M>>();
      enqueue(method, () => d.promise);
      return d;
    },
    setDefault: (method, reply) => {
      (defaults as Record<Method, unknown>)[method] = reply;
    },
    setList: (next) => {
      list = next;
    },
    emitCloseRequested: (finishInMs = null) => closeHandler?.(finishInMs),
    get listening() {
      return closeHandler !== null;
    },
  };
}
