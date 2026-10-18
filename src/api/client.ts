import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import {
  TAIL_MAX_IDS,
  toCircusError,
  type AppInfo,
  type CircusError,
  type DecideOutcome,
  type DecideRequest,
  type ListResponse,
  type ResumeLaunch,
  type ScanResponse,
  type TailsResponse,
} from './types';

export const TAIL_CHARS = 50_000;
const CLOSE_REQUESTED_EVENT = 'circus://close-requested';

const TEXT_DECODER = new TextDecoder();

function circusError(kind: CircusError['kind'], message: string): CircusError {
  return { kind, message, exit_code: null, stderr_tail: null };
}

// a tag check, because instanceof fails for buffers from another realm
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

export function decodeDocument(raw: unknown): unknown {
  if (!isArrayBuffer(raw) && !ArrayBuffer.isView(raw)) {
    throw circusError('bad_output', 'expected raw bytes from rl');
  }
  if (raw.byteLength === 0) return null;
  try {
    return JSON.parse(TEXT_DECODER.decode(raw)) as unknown;
  } catch (error) {
    throw circusError('bad_output', `rl printed something that is not JSON: ${String(error)}`);
  }
}

export interface CircusApi {
  list(): Promise<ListResponse>;
  scan(): Promise<ScanResponse>;
  tails(ids: readonly string[]): Promise<TailsResponse>;
  cachedList(): Promise<ListResponse | null>;
  decide(request: DecideRequest): Promise<DecideOutcome>;
  resume(id: string): Promise<ResumeLaunch>;
  appInfo(): Promise<AppInfo>;
  setPending(count: number): Promise<void>;
  closeAck(): Promise<void>;
  exit(): Promise<void>;
  onCloseRequested(handler: () => void): Promise<() => void>;
}

export type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type ListenFn = (event: string, handler: () => void) => Promise<() => void>;

const defaultInvoke: InvokeFn = (command, args) => tauriInvoke(command, args);
const defaultListen: ListenFn = (event, handler) => tauriListen(event, () => handler());

export function createCircusApi(
  invoke: InvokeFn = defaultInvoke,
  listen: ListenFn = defaultListen,
): CircusApi {
  async function call(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await invoke(command, args);
    } catch (error) {
      throw toCircusError(error);
    }
  }

  async function documentOrNull(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return decodeDocument(await invoke(command, args));
    } catch (error) {
      throw toCircusError(error);
    }
  }

  async function document(command: string, args: Record<string, unknown>): Promise<unknown> {
    const doc = await documentOrNull(command, args);
    if (doc === null) throw circusError('bad_output', `${command} returned no document`);
    return doc;
  }

  return {
    list: async () => (await document('rl_list', {})) as ListResponse,
    scan: async () => (await document('rl_scan', {})) as ScanResponse,
    tails: async (ids) => {
      if (ids.length === 0 || ids.length > TAIL_MAX_IDS) {
        throw circusError('invalid_argument', `tails takes 1 to ${TAIL_MAX_IDS} ids`);
      }
      return (await document('rl_tails', {
        request: { ids, max_chars: TAIL_CHARS },
      })) as TailsResponse;
    },
    cachedList: async () => (await documentOrNull('cached_list', {})) as ListResponse | null,
    decide: async (request) => (await document('rl_decide', { request })) as DecideOutcome,
    resume: async (id) => (await call('resume_session', { request: { id } })) as ResumeLaunch,
    appInfo: async () => (await call('app_info', {})) as AppInfo,
    setPending: async (count) => {
      await call('set_pending', { count });
    },
    closeAck: async () => {
      await call('close_ack', {});
    },
    exit: async () => {
      await call('app_exit', {});
    },
    onCloseRequested: async (handler) => {
      try {
        return await listen(CLOSE_REQUESTED_EVENT, handler);
      } catch (error) {
        throw toCircusError(error);
      }
    },
  };
}
