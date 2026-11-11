import { useCallback, useEffect, useState } from 'react';
import type { CircusApi } from '../api/client';
import {
  toCircusError,
  type CircusError,
  type CircusErrorKind,
  type InstalledStatus,
  type SetupPrefs,
  type SetupStatus,
} from '../api/types';

export type SetupBusy = 'ringleader' | 'uv' | 'finishing' | null;

export type SetupStep = 'status' | 'prefs' | 'ringleader' | 'uv' | 'finishing';

export interface SetupFailure {
  readonly step: SetupStep;
  readonly error: CircusError;
}

export type FinishResult =
  { readonly done: false } | { readonly done: true; readonly presenceError: CircusError | null };

export interface SetupController {
  readonly status: SetupStatus | null;
  readonly prefs: SetupPrefs | null;
  readonly busy: SetupBusy;
  readonly failure: SetupFailure | null;
  installRingleader(): void;
  installUv(): void;
  finish(promptUpdates: boolean, agentExtras: boolean): Promise<FinishResult>;
  stopPrompting(): void;
}

const UNUSABLE: ReadonlySet<CircusErrorKind> = new Set(['rl_not_found', 'rl_too_old']);

export function needsSetup(
  status: SetupStatus | null,
  prefs: SetupPrefs | null,
  loadErrorKind: CircusErrorKind | null,
): boolean {
  if (loadErrorKind !== null && UNUSABLE.has(loadErrorKind)) return true;
  if (status === null || prefs === null) return false;
  return !prefs.onboarded || status.state === 'missing' || status.state === 'too_old';
}

export function offersUpdate(
  status: SetupStatus | null,
  prefs: SetupPrefs | null,
): status is InstalledStatus {
  return status?.state === 'outdated' && prefs !== null && prefs.onboarded && prefs.prompt_updates;
}

const attempt = (step: () => Promise<void>): Promise<CircusError | null> =>
  step().then(
    () => null,
    (raw: unknown) => toCircusError(raw),
  );

export function useSetup(api: CircusApi): SetupController {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [prefs, setPrefs] = useState<SetupPrefs | null>(null);
  const [busy, setBusy] = useState<SetupBusy>(null);
  const [failure, setFailure] = useState<SetupFailure | null>(null);

  useEffect(() => {
    let active = true;
    api.setupStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      (raw: unknown) => {
        if (active) setFailure({ step: 'status', error: toCircusError(raw) });
      },
    );
    api.setupPrefs().then(
      (next) => {
        if (active) setPrefs(next);
      },
      (raw: unknown) => {
        if (active) setFailure({ step: 'prefs', error: toCircusError(raw) });
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const run = useCallback((which: 'ringleader' | 'uv', step: () => Promise<SetupStatus>) => {
    setBusy(which);
    setFailure(null);
    step().then(
      (next) => {
        setStatus(next);
        setBusy(null);
      },
      (raw: unknown) => {
        setFailure({ step: which, error: toCircusError(raw) });
        setBusy(null);
      },
    );
  }, []);

  const installRingleader = useCallback(
    () => run('ringleader', () => api.installRingleader()),
    [api, run],
  );
  const installUv = useCallback(() => run('uv', () => api.installUv()), [api, run]);

  const save = useCallback(
    async (next: SetupPrefs) => {
      setPrefs(next);
      await api
        .saveSetupPrefs(next)
        .catch((raw: unknown) => setFailure({ step: 'prefs', error: toCircusError(raw) }));
    },
    [api],
  );

  const finish = useCallback(
    async (promptUpdates: boolean, agentExtras: boolean): Promise<FinishResult> => {
      const answer = { ...prefs, onboarded: true, prompt_updates: promptUpdates };
      if (status?.can_install !== true) {
        await save(answer);
        return { done: true, presenceError: null };
      }
      setBusy('finishing');
      setFailure(null);
      const presenceError = await attempt(() => api.installPresence());
      const extrasError = agentExtras ? await attempt(() => api.installAgentExtras()) : null;
      setBusy(null);
      if (extrasError !== null) {
        setFailure({ step: 'finishing', error: extrasError });
        return { done: false };
      }
      await save(answer);
      return { done: true, presenceError };
    },
    [api, prefs, save, status],
  );

  const stopPrompting = useCallback(() => {
    if (prefs !== null) void save({ ...prefs, prompt_updates: false });
  }, [prefs, save]);

  return {
    status,
    prefs,
    busy,
    failure,
    installRingleader,
    installUv,
    finish,
    stopPrompting,
  };
}
