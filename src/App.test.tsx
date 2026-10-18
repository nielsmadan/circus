import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('lists the tabs in order with Inbox selected and visible', () => {
    render(<App />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Enrich', 'Triage', 'Inbox', 'Harvest']);
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Inbox' })).toBeVisible();
  });

  it('switches to a stub while keeping the Inbox panel mounted', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('tab', { name: 'Enrich' }));
    const enrich = screen.getByRole('tabpanel', { name: 'Enrich' });
    expect(within(enrich).getByText('Not built yet')).toBeVisible();
    const inbox = screen
      .getAllByRole('tabpanel', { hidden: true })
      .find((p) => p.id === 'panel-Inbox');
    expect(inbox).toBeInTheDocument();
    expect(inbox).not.toBeVisible();
  });
});
