import { useState, type ReactElement } from 'react';
import type { CircusError, SetupStatus } from '../api/types';
import type { SetupController } from './useSetup';

const BUTTON =
  'rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-500/10 disabled:opacity-50 dark:border-neutral-700';
const PRIMARY =
  'rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50';

function statusText(status: SetupStatus): string {
  switch (status.state) {
    case 'current':
      return `ringleader ${status.installed} is installed. Circus will use it.`;
    case 'outdated':
      return `ringleader ${status.installed} is installed and Circus will use it. Circus supports up to ${status.latest}.`;
    case 'too_old':
      return `ringleader ${status.installed} is installed, but Circus needs ${status.minimum} or newer.`;
    case 'missing':
      return 'ringleader is not installed yet.';
  }
}

function installLabel(status: SetupStatus): string | null {
  switch (status.state) {
    case 'current':
      return null;
    case 'missing':
      return `Install ringleader ${status.latest}`;
    case 'outdated':
    case 'too_old':
      return `Update to ${status.latest}`;
  }
}

export interface SetupScreenProps {
  readonly setup: SetupController;
  readonly onDone: (presenceError: CircusError | null) => void;
}

export function SetupScreen({ setup, onDone }: SetupScreenProps): ReactElement {
  const { status, prefs, busy } = setup;
  const error = setup.failure?.error ?? null;
  const [promptUpdates, setPromptUpdates] = useState(prefs?.prompt_updates ?? true);
  const [agentExtras, setAgentExtras] = useState(true);
  const firstRun = prefs?.onboarded !== true;
  const usable = status?.state === 'current' || status?.state === 'outdated';
  const label = status === null ? null : installLabel(status);
  const needsUv = label !== null && status?.uv_available === false;
  const blocked = status?.can_install === false;
  return (
    <main
      aria-labelledby="setup-title"
      className="flex flex-1 items-start justify-center overflow-y-auto p-8"
    >
      <div className="w-full max-w-lg space-y-5">
        <h1 id="setup-title" className="text-xl font-semibold">
          {firstRun ? 'Welcome to Circus' : 'Circus needs ringleader'}
        </h1>
        <p className="text-sm opacity-80">
          Circus reads your dormant agent sessions through ringleader, a small command-line tool
          that tracks them. Circus installs and updates it for you.
        </p>
        <section
          aria-label="ringleader"
          className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <p className="text-sm">
            {status === null ? 'Checking for ringleader…' : statusText(status)}
          </p>
          {needsUv && (
            <p className="text-sm opacity-80">
              Installing needs uv, the Python package manager ringleader is installed with. Circus
              installs uv into ~/.local/bin without changing your shell files.
            </p>
          )}
          {blocked && label !== null && (
            <p className="text-sm opacity-80">Installing is turned off in the sandbox.</p>
          )}
          {label !== null && (
            <div className="flex items-center gap-3">
              {needsUv ? (
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null || blocked}
                  onClick={setup.installUv}
                >
                  {busy === 'uv' ? 'Installing uv…' : 'Install uv'}
                </button>
              ) : (
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null || blocked}
                  onClick={setup.installRingleader}
                >
                  {busy === 'ringleader' ? 'Installing…' : label}
                </button>
              )}
            </div>
          )}
          {error !== null && (
            <div role="alert" className="text-sm text-red-700 dark:text-red-400">
              <p>{error.message}</p>
              {error.stderr_tail !== null && error.stderr_tail !== '' && (
                <details className="mt-1">
                  <summary className="cursor-default text-xs opacity-70">Details</summary>
                  <pre className="mt-1 text-xs whitespace-pre-wrap">{error.stderr_tail}</pre>
                </details>
              )}
            </div>
          )}
        </section>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={promptUpdates}
            onChange={(event) => setPromptUpdates(event.target.checked)}
            className="mt-0.5"
          />
          <span>Ask me to update ringleader when Circus supports a newer version</span>
        </label>
        {status?.can_install === true && (
          <>
            <p className="text-sm opacity-80">
              Circus also turns on ringleader’s running-session detection, which adds a small hook
              to each of your agents, so it never archives a session that is still open.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={agentExtras}
                onChange={(event) => setAgentExtras(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Also install ringleader’s agent skills and session-end hook (needed to triage a
                project with an agent)
              </span>
            </label>
          </>
        )}
        <button
          type="button"
          className={PRIMARY}
          disabled={!usable || busy !== null}
          onClick={() => {
            void setup.finish(promptUpdates, agentExtras).then((result) => {
              if (result.done) onDone(result.presenceError);
            });
          }}
        >
          {busy === 'finishing' ? 'Setting up…' : firstRun ? 'Start using Circus' : 'Continue'}
        </button>
      </div>
    </main>
  );
}
