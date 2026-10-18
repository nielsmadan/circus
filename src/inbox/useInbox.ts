import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import type { CircusApi } from '../api/client';
import {
  toCircusError,
  type AppInfo,
  type CircusError,
  type DecisionAction,
  type ListResponse,
  type ScanResponse,
  type SessionRow,
} from '../api/types';
import { adoptList, markApplied, type Applied } from './applied';
import { createFlight, type Flight, type Landed } from './coalesce';
import { clientRefusal, decisionGuard, visibleSessions } from './derive';
import { enqueuedToast, settledToast, undoToast, type ToastSpec } from './messages';
import {
  Outbox,
  toRequest,
  UNDO_WINDOW_MS,
  type Decision,
  type OutboxEntry,
  type Settled,
} from './outbox';

export interface Clock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const FOCUS_REFETCH_MS = 60_000;

export interface Toast extends ToastSpec {
  readonly id: number;
  readonly ticket: number | null;
}

export interface InboxController {
  readonly info: AppInfo | null;
  readonly list: ListResponse | null;
  readonly listStale: boolean;
  readonly loadError: CircusError | null;
  readonly scanning: boolean;
  readonly scanCount: number;
  readonly rows: readonly SessionRow[];
  readonly entries: readonly OutboxEntry[];
  readonly closing: boolean;
  readonly toasts: readonly Toast[];
  readonly decisionsBlocked: string | null;
  decide(action: DecisionAction, row: SessionRow, until?: string | null): boolean;
  undo(): Decision | null;
  rescan(): void;
  refresh(): void;
  dismissToast(id: number): void;
  notify(spec: ToastSpec): void;
  discardUnsent(): void;
}

export interface SettleEffects {
  readonly markApplied: boolean;
  readonly refetch: boolean;
  readonly rescan: boolean;
  readonly toast: ToastSpec;
}

const CHANGED = 'changed since you looked';
const TOAST_MS: Readonly<Record<ToastSpec['tone'], number>> = {
  info: 6_000,
  warning: 10_000,
  error: 10_000,
};
const MAX_TOASTS = 5;

// Toasts that name an undoable decision are never evicted; a plain info toast goes before a warning or error.
function evictToasts(toasts: readonly Toast[]): readonly Toast[] {
  const excess = toasts.length - MAX_TOASTS;
  if (excess <= 0) return toasts;
  const evictable = (tone: ToastSpec['tone'] | null) => (toast: Toast) =>
    toast.ticket === null && (tone === null || toast.tone === tone);
  const victims = new Set(
    [
      ...toasts.filter(evictable('info')),
      ...toasts.filter((toast) => toast.ticket === null && toast.tone !== 'info'),
    ].slice(0, excess),
  );
  return toasts.filter((toast) => !victims.has(toast));
}
const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function settleEffects(settled: Settled): SettleEffects {
  const toast = settledToast(settled);
  switch (settled.kind) {
    case 'unknown':
      return { markApplied: true, refetch: true, rescan: false, toast };
    case 'error':
      return { markApplied: false, refetch: false, rescan: false, toast };
    case 'outcome': {
      const { status, wrote, reason } = settled.outcome;
      if (status === 'ok' || wrote)
        return { markApplied: true, refetch: true, rescan: false, toast };
      if (status === 'empty') return { markApplied: false, refetch: false, rescan: false, toast };
      const rescan = status === 'refused' && reason?.startsWith(CHANGED) === true;
      return { markApplied: false, refetch: true, rescan, toast };
    }
  }
}

const IDLE_HANDLERS: Handlers = {
  onSettled: () => undefined,
  onListLanded: () => undefined,
  onScanLanded: () => undefined,
  onScanStarted: () => undefined,
};

function reportError(error: unknown): void {
  console.error(error);
}

interface Engine {
  readonly outbox: Outbox;
  readonly listFlight: Flight<undefined>;
  readonly scanFlight: Flight<undefined>;
}

interface Handlers {
  onSettled(settled: Settled): void;
  onListLanded(landed: Landed<undefined, ListResponse>): void;
  onScanLanded(landed: Landed<undefined, ScanResponse>): void;
  onScanStarted(): void;
}

function createEngine(
  api: CircusApi,
  clock: Clock,
  handlers: { readonly current: Handlers },
  lastSent: { current: Decision | null },
): Engine {
  const outbox = new Outbox({
    send: (decision) => {
      lastSent.current = decision;
      return api.decide(toRequest(decision));
    },
    now: () => clock.now(),
    setTimer: (callback, ms) => clock.setTimer(callback, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
    onSettled: (settled) => handlers.current.onSettled(settled),
  });
  const listFlight = createFlight<undefined, ListResponse>(
    () => api.list(),
    (landed) => handlers.current.onListLanded(landed),
  );
  const scanFlight = createFlight<undefined, ScanResponse>(
    () => {
      handlers.current.onScanStarted();
      return api.scan();
    },
    (landed) => handlers.current.onScanLanded(landed),
  );
  return { outbox, listFlight, scanFlight };
}

export function useInbox(api: CircusApi, clock: Clock = DEFAULT_CLOCK): InboxController {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [list, setList] = useState<ListResponse | null>(null);
  const [listStale, setListStale] = useState(false);
  const [loadError, setLoadError] = useState<CircusError | null>(null);
  const [applied, setApplied] = useState<Applied>(() => new Map());
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [listenerReady, setListenerReady] = useState(false);

  const handlers = useRef<Handlers>(IDLE_HANDLERS);
  const lastSent = useRef<Decision | null>(null);
  const liveLanded = useRef(false);
  const lastListLandedAt = useRef<number | null>(null);
  const started = useRef(false);
  const closingRef = useRef(false);
  const nextToastId = useRef(1);
  const toastForTicket = useRef(new Map<number, number>());
  const toastTimers = useRef(new Set<unknown>());
  const clockRef = useRef(clock);
  const [engine] = useState(() => createEngine(api, clock, handlers, lastSent));
  const { outbox, listFlight, scanFlight } = engine;

  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => outbox.subscribe(listener), [outbox]),
    useCallback(() => outbox.getSnapshot(), [outbox]),
  );
  const entries = snapshot.entries;

  const dismissToast = useCallback((id: number) => {
    setToasts((current) =>
      current.some((t) => t.id === id) ? current.filter((t) => t.id !== id) : current,
    );
  }, []);

  const pushToast = useCallback(
    (spec: ToastSpec, ms: number = TOAST_MS[spec.tone], ticket: number | null = null): number => {
      const id = nextToastId.current;
      nextToastId.current += 1;
      setToasts((current) => evictToasts([...current, { ...spec, id, ticket }]));
      const clock = clockRef.current;
      const handle = clock.setTimer(() => {
        toastTimers.current.delete(handle);
        dismissToast(id);
      }, ms);
      toastTimers.current.add(handle);
      return id;
    },
    [dismissToast],
  );

  const releaseToast = useCallback(
    (decision: Decision) => {
      const id = toastForTicket.current.get(decision.ticket);
      if (id === undefined) return;
      toastForTicket.current.delete(decision.ticket);
      dismissToast(id);
    },
    [dismissToast],
  );

  useLayoutEffect(() => {
    clockRef.current = clock;
    handlers.current = {
      onSettled(settled) {
        const effects = settleEffects(settled);
        const seq = listFlight.lastStarted;
        // applied must commit before the outbox drops the entry, or the row flashes back
        flushSync(() => {
          if (effects.markApplied) setApplied((a) => markApplied(a, settled.decision.row.id, seq));
          releaseToast(settled.decision);
          pushToast(effects.toast);
        });
        if (effects.refetch) listFlight.request(undefined);
        if (effects.rescan) scanFlight.request(undefined);
      },
      onListLanded(landed) {
        lastListLandedAt.current = clockRef.current.now();
        if (!landed.result.ok) {
          setLoadError(landed.result.error);
          return;
        }
        liveLanded.current = true;
        setList(landed.result.value);
        setListStale(false);
        setLoadError(null);
        setApplied((a) => adoptList(a, landed.seq));
      },
      onScanLanded(landed) {
        setScanning(false);
        if (!landed.result.ok) {
          pushToast({
            tone: 'warning',
            text: `Rescan failed: ${landed.result.error.message}`,
            undo: false,
            detail: null,
          });
          return;
        }
        setScanCount((n) => n + 1);
        listFlight.request(undefined);
      },
      onScanStarted() {
        setScanning(true);
      },
    };
  });

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.cachedList().then(
      (cached) => {
        if (cached === null || liveLanded.current) return;
        setList(cached);
        setListStale(true);
      },
      () => undefined,
    );
    api.appInfo().then(setInfo, (error: unknown) => {
      const text = `Could not read the app settings: ${toCircusError(error).message}`;
      pushToast({ tone: 'error', text, undo: false, detail: null });
    });
    listFlight.request(undefined);
    scanFlight.request(undefined);
  }, [api, listFlight, scanFlight, pushToast]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    const handleClose = async () => {
      api.closeAck().catch(reportError);
      if (closingRef.current) return;
      closingRef.current = true;
      outbox.flush();
      await outbox.whenIdle();
      try {
        await api.exit();
      } catch (error) {
        closingRef.current = false;
        outbox.reopen();
        pushToast({
          tone: 'error',
          text: `Could not quit: ${toCircusError(error).message}`,
          undo: false,
          detail: null,
        });
      }
    };
    api
      .onCloseRequested(() => {
        handleClose().catch(reportError);
      })
      .then((remove) => {
        if (!active) {
          remove();
          return;
        }
        unlisten = remove;
        setListenerReady(true);
      }, reportError);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [api, outbox, pushToast]);

  useEffect(
    () => () => {
      outbox.discardUnsent();
      toastTimers.current.forEach((handle) => clockRef.current.clearTimer(handle));
      toastTimers.current.clear();
    },
    [outbox],
  );

  const pendingCount = entries.length;
  useEffect(() => {
    if (!listenerReady) return;
    api.setPending(pendingCount).catch(reportError);
  }, [api, listenerReady, pendingCount]);

  useEffect(() => {
    const onFocus = () => {
      const landedAt = lastListLandedAt.current;
      if (landedAt !== null && clockRef.current.now() - landedAt > FOCUS_REFETCH_MS) {
        listFlight.request(undefined);
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [listFlight]);

  const decisionsBlocked = useMemo(() => decisionGuard(info, list), [info, list]);
  const rows = useMemo(
    () => visibleSessions(list?.sessions ?? NO_ROWS, entries, applied),
    [list, entries, applied],
  );

  const decide = useCallback(
    (action: DecisionAction, row: SessionRow, until: string | null = null): boolean => {
      const refusal = decisionsBlocked ?? clientRefusal(action, row);
      if (refusal !== null) {
        pushToast({ tone: 'warning', text: refusal, undo: false, detail: null });
        return false;
      }
      const result = outbox.enqueue(action, row, until);
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          pushToast({
            tone: 'info',
            text: `“${row.label}” already has a pending change`,
            undo: false,
            detail: null,
          });
        }
        return false;
      }
      const id = pushToast(
        enqueuedToast(result.decision, new Date(clockRef.current.now())),
        UNDO_WINDOW_MS[action],
        result.decision.ticket,
      );
      toastForTicket.current.set(result.decision.ticket, id);
      return true;
    },
    [decisionsBlocked, outbox, pushToast],
  );

  const undo = useCallback((): Decision | null => {
    const decision = outbox.undo();
    if (decision !== null) releaseToast(decision);
    pushToast(undoToast(decision, decision === null ? lastSent.current : null));
    return decision;
  }, [outbox, pushToast, releaseToast]);

  const rescan = useCallback(() => {
    if (scanFlight.busy)
      pushToast({ tone: 'info', text: 'Rescan queued', undo: false, detail: null });
    scanFlight.request(undefined);
  }, [scanFlight, pushToast]);

  const refresh = useCallback(() => listFlight.request(undefined), [listFlight]);

  const notify = useCallback(
    (spec: ToastSpec) => {
      pushToast(spec);
    },
    [pushToast],
  );

  const discardUnsent = useCallback(() => {
    outbox.discardUnsent().forEach(releaseToast);
  }, [outbox, releaseToast]);

  const closing = snapshot.closing;
  return useMemo(
    () => ({
      info,
      list,
      listStale,
      loadError,
      scanning,
      scanCount,
      rows,
      entries,
      closing,
      toasts,
      decisionsBlocked,
      decide,
      undo,
      rescan,
      refresh,
      dismissToast,
      notify,
      discardUnsent,
    }),
    [
      info,
      list,
      listStale,
      loadError,
      scanning,
      scanCount,
      rows,
      entries,
      closing,
      toasts,
      decisionsBlocked,
      decide,
      undo,
      rescan,
      refresh,
      dismissToast,
      notify,
      discardUnsent,
    ],
  );
}
