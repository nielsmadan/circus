import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import type { SetupPrefs, SetupStatus } from '../api/types';
import { createFakeApi, CURRENT_SETUP, type FakeApi } from '../test/fakeApi';
import { makeList, makeRow } from '../test/fixtures';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { needsSetup, offersUpdate, useSetup } from './useSetup';

let harness: ShortcutHarness;
let api: FakeApi;

const ONBOARDED: SetupPrefs = { onboarded: true, prompt_updates: true };
const FIRST_RUN: SetupPrefs = { onboarded: false, prompt_updates: true };
const status = (overrides: Partial<SetupStatus>): SetupStatus =>
  ({ ...CURRENT_SETUP, ...overrides }) as SetupStatus;
const failure = (message: string, stderr_tail: string | null = null) => ({
  kind: 'failed' as const,
  message,
  exit_code: 1,
  stderr_tail,
});
const MISSING = status({ state: 'missing', installed: null });
const OUTDATED = status({ state: 'outdated', installed: '0.2.0', latest: '0.3.0' });

beforeEach(async () => {
  harness = await shortcutHarness();
});

async function renderApp(setup: SetupStatus, prefs: SetupPrefs) {
  api = createFakeApi(makeList([makeRow()]));
  api.setDefault('setupStatus', () => Promise.resolve(setup));
  api.setDefault('setupPrefs', () => Promise.resolve(prefs));
  render(<App api={api} />, { wrapper: harness.wrapper });
  await act(async () => {});
}

const start = () => screen.getByRole('button', { name: 'Start using Circus' });
const sessions = () => screen.queryByRole('listbox', { name: 'Sessions' });

describe('needsSetup and offersUpdate', () => {
  it('asks for setup on the first run, without a usable ringleader, or when loading says so', () => {
    expect(needsSetup(CURRENT_SETUP, FIRST_RUN, null)).toBe(true);
    expect(needsSetup(CURRENT_SETUP, ONBOARDED, null)).toBe(false);
    expect(needsSetup(OUTDATED, ONBOARDED, null)).toBe(false);
    expect(needsSetup(MISSING, ONBOARDED, null)).toBe(true);
    expect(needsSetup(status({ state: 'too_old' }), ONBOARDED, null)).toBe(true);
    expect(needsSetup(null, null, 'rl_not_found')).toBe(true);
    expect(needsSetup(null, null, null)).toBe(false);
  });

  it('offers an update only for an outdated install the user wants to hear about', () => {
    expect(offersUpdate(OUTDATED, ONBOARDED)).toBe(true);
    expect(offersUpdate(OUTDATED, { onboarded: true, prompt_updates: false })).toBe(false);
    expect(offersUpdate(OUTDATED, FIRST_RUN)).toBe(false);
    expect(offersUpdate(CURRENT_SETUP, ONBOARDED)).toBe(false);
  });
});

describe('onboarding', () => {
  it('says it will use a current ringleader and saves the answer on start', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    expect(await screen.findByRole('heading', { name: 'Welcome to Circus' })).toBeVisible();
    expect(screen.getByText('ringleader 0.2.0 is installed. Circus will use it.')).toBeVisible();
    const ask = screen.getByRole('checkbox', {
      name: 'Ask me to update ringleader when Circus supports a newer version',
    });
    expect(ask).toBeChecked();
    await userEvent.click(ask);
    await userEvent.click(start());
    expect(api.argsOf('saveSetupPrefs')).toEqual([[{ onboarded: true, prompt_updates: false }]]);
    expect(await screen.findByRole('listbox', { name: 'Sessions' })).toBeVisible();
  });

  it('installs a missing ringleader before letting the user start', async () => {
    await renderApp(MISSING, FIRST_RUN);
    expect(await screen.findByText('ringleader is not installed yet.')).toBeVisible();
    expect(start()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Install ringleader 0.2.0' }));
    expect(api.count('installRingleader')).toBe(1);
    expect(
      await screen.findByText('ringleader 0.2.0 is installed. Circus will use it.'),
    ).toBeVisible();
    expect(start()).toBeEnabled();
  });

  it('offers to install uv first when it is missing', async () => {
    await renderApp(status({ ...MISSING, uv_available: false }), FIRST_RUN);
    expect(
      await screen.findByText(
        /Circus installs uv into ~\/\.local\/bin without changing your shell files\./,
      ),
    ).toBeVisible();
    await userEvent.click(await screen.findByRole('button', { name: 'Install uv' }));
    expect(api.count('installUv')).toBe(1);
    expect(api.count('installRingleader')).toBe(0);
  });

  it('offers an optional update for an outdated install', async () => {
    await renderApp(OUTDATED, FIRST_RUN);
    expect(
      await screen.findByText(
        'ringleader 0.2.0 is installed and Circus will use it. Circus supports up to 0.3.0.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Update to 0.3.0' })).toBeEnabled();
    expect(start()).toBeEnabled();
  });

  it('blocks a later launch on a ringleader that is too old', async () => {
    await renderApp(status({ state: 'too_old', installed: '0.1.0' }), ONBOARDED);
    expect(await screen.findByRole('heading', { name: 'Circus needs ringleader' })).toBeVisible();
    expect(
      screen.getByText('ringleader 0.1.0 is installed, but Circus needs 0.2.0 or newer.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(sessions()).toBeNull();
  });

  it('turns installing off in the sandbox', async () => {
    await renderApp(status({ ...MISSING, can_install: false }), FIRST_RUN);
    expect(await screen.findByText('Installing is turned off in the sandbox.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Install ringleader 0.2.0' })).toBeDisabled();
  });

  it('shows why an install failed, with the details behind a disclosure', async () => {
    await renderApp(MISSING, FIRST_RUN);
    api.fail('installRingleader', {
      kind: 'failed',
      message: 'Could not download ringleader',
      exit_code: 22,
      stderr_tail: 'curl: (22) 404',
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Install ringleader 0.2.0' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not download ringleader');
    expect(within(alert).getByText('curl: (22) 404')).toBeInTheDocument();
  });
});

describe('finishing onboarding', () => {
  it('turns on running-session detection and installs the agent extras by default', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    expect(api.calls.map((c) => c.method).filter((m) => m.startsWith('install'))).toEqual([
      'installPresence',
      'installAgentExtras',
    ]);
    expect(await screen.findByRole('listbox', { name: 'Sessions' })).toBeVisible();
  });

  it('skips the agent extras when unticked', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: /agent skills and session-end hook/ }),
    );
    await userEvent.click(start());
    expect(api.count('installPresence')).toBe(1);
    expect(api.count('installAgentExtras')).toBe(0);
  });

  it('finishes with a warning when running-session detection fails', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    api.fail(
      'installPresence',
      failure('Could not turn on running-session detection', 'claude: settings are read-only'),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    expect(await screen.findByRole('listbox', { name: 'Sessions' })).toBeVisible();
    expect(api.count('installAgentExtras')).toBe(1);
    expect(api.argsOf('saveSetupPrefs')).toEqual([[{ onboarded: true, prompt_updates: true }]]);
    const warning = screen.getByText(
      'Running-session detection is off — turn it on from the banner above the inbox',
    );
    expect(warning.closest('[title]')).toHaveAttribute(
      'title',
      'Could not turn on running-session detection\nclaude: settings are read-only',
    );
  });

  it('stays on setup and explains when the agent extras fail', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    const lists = api.count('list');
    api.fail('installAgentExtras', failure('Could not install the agent skills', 'no skills dir'));
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not install the agent skills');
    expect(within(alert).getByText('no skills dir')).toBeInTheDocument();
    expect(api.count('saveSetupPrefs')).toBe(0);
    expect(api.count('list')).toBe(lists);
    expect(start()).toBeEnabled();
  });

  it('refreshes the inbox once onboarding finishes', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    const lists = api.count('list');
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    expect(api.count('list')).toBe(lists + 1);
  });

  it('shows no details for an error without any', async () => {
    await renderApp(CURRENT_SETUP, FIRST_RUN);
    api.fail('installAgentExtras', failure('Could not install the agent skills', ''));
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/^Could not install the agent skills$/);
  });

  it('runs no install step where installing is off', async () => {
    await renderApp(status({ can_install: false }), FIRST_RUN);
    await userEvent.click(await screen.findByRole('button', { name: 'Start using Circus' }));
    expect(api.argsOf('saveSetupPrefs')).toEqual([[{ onboarded: true, prompt_updates: true }]]);
    expect(api.count('installPresence')).toBe(0);
  });
});

describe('update prompt', () => {
  const banner = () => screen.queryByRole('note', { name: 'Update available' });

  it('offers the update above the inbox and goes away once updated', async () => {
    await renderApp(OUTDATED, ONBOARDED);
    expect(
      await screen.findByText('ringleader 0.3.0 is available (you have 0.2.0).'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(api.count('installRingleader')).toBe(1);
    expect(banner()).toBeNull();
  });

  it('hides the prompt for now without saving anything', async () => {
    await renderApp(OUTDATED, ONBOARDED);
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(banner()).toBeNull();
    expect(api.count('saveSetupPrefs')).toBe(0);
  });

  it('stops asking when told not to', async () => {
    await renderApp(OUTDATED, ONBOARDED);
    await userEvent.click(await screen.findByRole('button', { name: 'Don’t ask again' }));
    expect(api.argsOf('saveSetupPrefs')).toEqual([[{ onboarded: true, prompt_updates: false }]]);
    expect(banner()).toBeNull();
  });

  it('shows why an update failed in the banner', async () => {
    await renderApp(OUTDATED, ONBOARDED);
    api.fail('installRingleader', failure('Could not download ringleader'));
    await userEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(banner()).toHaveTextContent('Could not download ringleader');
  });

  it('stays quiet when the user opted out', async () => {
    await renderApp(OUTDATED, { onboarded: true, prompt_updates: false });
    expect(await screen.findByRole('listbox', { name: 'Sessions' })).toBeVisible();
    expect(banner()).toBeNull();
  });
});

describe('useSetup', () => {
  const mount = async (setup: (fake: FakeApi) => void = () => undefined) => {
    api = createFakeApi(makeList([]));
    setup(api);
    const view = renderHook(() => useSetup(api));
    await act(async () => {});
    return view;
  };

  it('records a failed status check against the status step', async () => {
    const { result } = await mount((fake) => fake.fail('setupStatus', failure('no answer')));
    expect(result.current.status).toBeNull();
    expect(result.current.failure).toEqual({ step: 'status', error: failure('no answer') });
  });

  it('leaves the answers unknown when they cannot be read, so setup is not forced', async () => {
    const { result } = await mount((fake) => fake.fail('setupPrefs', failure('unreadable')));
    expect(result.current.prefs).toBeNull();
    expect(result.current.failure).toEqual({ step: 'prefs', error: failure('unreadable') });
    expect(needsSetup(result.current.status, result.current.prefs, null)).toBe(false);
  });

  it('records a failed save of the answers', async () => {
    const { result } = await mount((fake) => fake.fail('saveSetupPrefs', failure('read-only')));
    await act(async () => {
      await result.current.finish(true, false);
    });
    expect(result.current.failure).toEqual({ step: 'prefs', error: failure('read-only') });
  });

  it('turns off update prompts without touching the onboarding answer', async () => {
    const { result } = await mount((fake) =>
      fake.setDefault('setupPrefs', () => Promise.resolve(FIRST_RUN)),
    );
    await act(async () => {
      result.current.stopPrompting();
    });
    expect(api.argsOf('saveSetupPrefs')).toEqual([[{ onboarded: false, prompt_updates: false }]]);
  });
});
