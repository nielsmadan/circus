import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { appContext, inboxListContext, type InboxListAction } from '../shortcuts/contexts';
import { useShortcutContext } from '../shortcuts/react';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { CommandPalette } from './CommandPalette';

let harness: ShortcutHarness;
let inboxHandler: Mock<(action: InboxListAction) => void>;
let deactivateInbox: () => void;

beforeEach(async () => {
  harness = await shortcutHarness();
  inboxHandler = vi.fn<(action: InboxListAction) => void>();
  deactivateInbox = harness.registry.activate(inboxListContext, inboxHandler);
});

afterEach(() => {
  deactivateInbox();
  harness.dispose();
});

function Host() {
  const [open, setOpen] = useState(false);
  useShortcutContext(appContext, (action) => {
    if (action === 'openPalette') setOpen(true);
  });
  return <CommandPalette open={open} onClose={() => setOpen(false)} />;
}

async function openPalette() {
  render(<Host />, { wrapper: harness.wrapper });
  await userEvent.keyboard('{Meta>}k{/Meta}');
  return screen.getByRole('dialog', { name: 'Command palette' });
}

const optionNames = () =>
  screen.getAllByRole('option').map((option) => option.querySelector('span')?.textContent ?? '');

describe('CommandPalette', () => {
  it('opens with ⌘K and lists active commands with their labels', async () => {
    const dialog = await openPalette();
    const archive = within(dialog).getByRole('option', { name: /Archive without harvesting/ });
    expect(archive).toHaveTextContent('Archive without harvestingInbox⇧E');
    expect(optionNames()).toEqual([
      'Go to Enrich',
      'Go to Triage',
      'Go to Inbox',
      'Go to Harvest',
      ...inboxListContext.actionIds.map((id) => inboxListContext.actions[id].displayName),
    ]);
    expect(screen.getByRole('textbox', { name: 'Search commands' })).toHaveFocus();
  });

  it('ranks the best match first', async () => {
    await openPalette();
    await userEvent.keyboard('arch');
    expect(optionNames()[0]).toBe('Archive without harvesting');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('runs the highlighted command with ArrowDown and Enter, then closes', async () => {
    await openPalette();
    await userEvent.keyboard('archive');
    expect(optionNames()).toEqual(['Archive without harvesting', 'Harvest, then archive']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(inboxHandler.mock.calls).toEqual([['harvestArchive']]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('wraps the highlight upward from the first item', async () => {
    await openPalette();
    await userEvent.keyboard('archive{ArrowUp}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('runs a clicked command', async () => {
    await openPalette();
    await userEvent.click(screen.getByRole('option', { name: /Keep long-term/ }));
    expect(inboxHandler.mock.calls).toEqual([['keep']]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps focus in the input on Tab and Shift+Tab', async () => {
    await openPalette();
    const input = screen.getByRole('textbox', { name: 'Search commands' });
    await userEvent.keyboard('{Tab}');
    expect(input).toHaveFocus();
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(input).toHaveFocus();
    expect(inboxHandler).toHaveBeenCalledTimes(0);
  });

  it('closes on Escape without dispatching', async () => {
    await openPalette();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(inboxHandler).toHaveBeenCalledTimes(0);
  });

  it('closes on ⌘K again', async () => {
    await openPalette();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a backdrop click', async () => {
    const dialog = await openPalette();
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('no backdrop');
    await userEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when nothing matches', async () => {
    await openPalette();
    await userEvent.keyboard('qqqq');
    expect(screen.getByText('No matching commands')).toBeInTheDocument();
  });

  it('starts fresh when reopened', async () => {
    await openPalette();
    await userEvent.keyboard('arch{Escape}{Meta>}k{/Meta}');
    expect(screen.getByRole('textbox', { name: 'Search commands' })).toHaveValue('');
  });
});
