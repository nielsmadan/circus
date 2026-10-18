import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { InboxController } from './inbox/useInbox';
import { createFakeApi, okOutcome, type FakeApi } from './test/fakeApi';
import { makeList, makeRow } from './test/fixtures';
import { shortcutHarness, type ShortcutHarness } from './test/shortcuts';

const captured = vi.hoisted(() => ({ controller: null as InboxController | null }));

vi.mock('./inbox/useInbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./inbox/useInbox')>();
  return {
    ...actual,
    useInbox: (...args: Parameters<typeof actual.useInbox>) => {
      const controller = actual.useInbox(...args);
      captured.controller = controller;
      return controller;
    },
  };
});

let harness: ShortcutHarness;
let api: FakeApi;

const rowA = makeRow({ id: 'claude-code:a', session_id: 'a', label: 'fix flaky login' });
const rowB = makeRow({ id: 'claude-code:b', session_id: 'b', label: 'fix parser' });

beforeEach(async () => {
  harness = await shortcutHarness();
  api = createFakeApi(makeList([rowA, rowB]));
});

afterEach(() => harness.dispose());

const renderApp = () => render(<App api={api} />, { wrapper: harness.wrapper });

function controller(): InboxController {
  if (captured.controller === null) throw new Error('App has not rendered');
  return captured.controller;
}

describe('App shell', () => {
  it('lists the tabs in order with Inbox selected and visible', () => {
    renderApp();
    const tabs = within(screen.getByRole('tablist', { name: 'Sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Enrich', 'Triage', 'Inbox', 'Harvest']);
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Inbox' })).toBeVisible();
  });

  it('switches to a stub while keeping the Inbox panel mounted', async () => {
    renderApp();
    await userEvent.click(screen.getByRole('tab', { name: 'Enrich' }));
    const enrich = screen.getByRole('tabpanel', { name: 'Enrich' });
    expect(within(enrich).getByText('Not built yet')).toBeVisible();
    const inbox = screen
      .getAllByRole('tabpanel', { hidden: true })
      .find((p) => p.id === 'panel-Inbox');
    expect(inbox).toBeInTheDocument();
    expect(inbox).not.toBeVisible();
  });

  it('switches tabs with ⌘2 and ⌘3', async () => {
    renderApp();
    await userEvent.keyboard('{Meta>}2{/Meta}');
    expect(screen.getByRole('tab', { name: 'Triage' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Meta>}3{/Meta}');
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the command palette with ⌘K', async () => {
    renderApp();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
  });

  it('shows the finishing overlay on close and exits once the sent change finishes', async () => {
    renderApp();
    await act(async () => {});
    const archive = api.defer('decide');
    act(() => {
      controller().decide('archive', rowA);
      controller().decide('keep', rowB);
    });
    await act(async () => api.emitCloseRequested());
    expect(screen.getByRole('alertdialog', { name: 'Finishing 2 changes…' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard unsent (1)' }));
    expect(screen.getByRole('alertdialog', { name: 'Finishing 1 change…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard unsent/ })).toBeNull();
    expect(api.count('exit')).toBe(0);
    await act(async () => archive.resolve(okOutcome(api.decideRequest(0))));
    expect(api.count('exit')).toBe(1);
    expect(api.argsOf('decide').map(([request]) => request.action)).toEqual(['archive']);
  });

  it('shows a decision toast with an undo button labelled z', async () => {
    renderApp();
    await act(async () => {});
    act(() => {
      controller().decide('archive', rowA);
    });
    const toast = screen.getByText('Archive “fix flaky login”').parentElement;
    expect(toast).not.toBeNull();
    const undo = within(toast as HTMLElement).getByRole('button', { name: /Undo/ });
    expect(within(undo).getByText('Z')).toBeInTheDocument();
    await userEvent.click(undo);
    expect(screen.getByText('Undid archive “fix flaky login”')).toBeInTheDocument();
    expect(screen.queryByText('Archive “fix flaky login”')).toBeNull();
  });

  it('offers Undo only on the toast of the newest unsent decision', async () => {
    renderApp();
    await act(async () => {});
    act(() => {
      controller().decide('delete', rowA);
    });
    act(() => {
      controller().decide('archive', rowB);
    });
    const toastOf = (text: string) => screen.getByText(text).parentElement as HTMLElement;
    expect(
      within(toastOf('Deleting “fix flaky login” in 10 s')).queryByRole('button', { name: /Undo/ }),
    ).toBeNull();
    await userEvent.click(
      within(toastOf('Archive “fix parser”')).getByRole('button', { name: /Undo/ }),
    );
    expect(screen.getByText('Undid archive “fix parser”')).toBeInTheDocument();
    await userEvent.click(
      within(toastOf('Deleting “fix flaky login” in 10 s')).getByRole('button', { name: /Undo/ }),
    );
    expect(screen.getByText('Undid delete “fix flaky login”')).toBeInTheDocument();
  });
});
