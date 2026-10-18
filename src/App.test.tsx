import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { shortcutHarness, type ShortcutHarness } from './test/shortcuts';

let harness: ShortcutHarness;

beforeEach(async () => {
  harness = await shortcutHarness();
});

afterEach(() => harness.dispose());

const renderApp = () => render(<App />, { wrapper: harness.wrapper });

describe('App shell', () => {
  it('lists the tabs in order with Inbox selected and visible', () => {
    renderApp();
    const tabs = screen.getAllByRole('tab');
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
});
