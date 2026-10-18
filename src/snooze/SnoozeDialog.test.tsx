import { StrictMode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { SnoozeDialog } from './SnoozeDialog';

let harness: ShortcutHarness;

beforeEach(async () => {
  harness = await shortcutHarness();
});

afterEach(() => {
  harness.dispose();
});

const AFTERNOON = new Date(2026, 9, 16, 14, 30);
const NIGHT = new Date(2026, 9, 16, 22, 0);

function open(now: Date = AFTERNOON) {
  const onConfirm = vi.fn<(at: Date) => void>();
  const onClose = vi.fn<() => void>();
  render(
    <SnoozeDialog
      sessionLabel="fix auth"
      now={() => now}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
    { wrapper: harness.wrapper },
  );
  return { onConfirm, onClose, input: screen.getByRole('textbox', { name: 'Snooze until' }) };
}

describe('SnoozeDialog', () => {
  it('is titled with the session and focuses the text input', () => {
    const { input } = open();
    expect(screen.getByRole('dialog', { name: 'Snooze “fix auth” until…' })).toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it('previews a typed time and confirms it with Enter', async () => {
    const { onConfirm } = open();
    await userEvent.keyboard('tomorrow 3pm');
    expect(screen.getByText('Tomorrow, 15:00')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 17, 15, 0));
  });

  it('shows the parse error and does not confirm on Enter', async () => {
    const { onConfirm } = open();
    await userEvent.keyboard('blah{Enter}');
    expect(screen.getByText(/Try “3d”/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms a preset on click', async () => {
    const { onConfirm } = open();
    await userEvent.click(screen.getByRole('button', { name: /Next week/ }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 19, 9, 0));
  });

  it('shows each preset with its resolved time', () => {
    open();
    expect(screen.getByRole('button', { name: /^Tomorrow/ })).toHaveTextContent('Tomorrow, 09:00');
  });

  it('disables a preset that cannot resolve', () => {
    open(NIGHT);
    expect(screen.getByRole('button', { name: /Later today/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Tomorrow/ })).toBeEnabled();
  });

  it('confirms the date picker value with ⌘↩', async () => {
    const { onConfirm } = open();
    fireEvent.change(screen.getByLabelText('Pick date & time'), {
      target: { value: '2026-10-20T08:15' },
    });
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 20, 8, 15));
  });

  it('confirms the typed time with the Snooze button', async () => {
    const { onConfirm } = open();
    await userEvent.keyboard('tomorrow 3pm');
    await userEvent.click(screen.getByRole('button', { name: 'Snooze' }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 17, 15, 0));
  });

  it('disables Snooze until a valid time is chosen', () => {
    open();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Pick date & time'), {
      target: { value: '2026-10-10T08:15' },
    });
    expect(screen.getByText('That time has already passed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeDisabled();
  });

  it('closes on Escape', async () => {
    const { onClose } = open();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('wraps Tab from Snooze to the text input and Shift+Tab back', async () => {
    const { input } = open();
    fireEvent.change(screen.getByLabelText('Pick date & time'), {
      target: { value: '2026-10-20T08:15' },
    });
    const snooze = screen.getByRole('button', { name: 'Snooze' });
    snooze.focus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(snooze).toHaveFocus();
  });

  it('wraps Tab from Cancel when Snooze is disabled', async () => {
    const { input } = open();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('previews the picker time and enables Snooze', () => {
    open();
    fireEvent.change(screen.getByLabelText('Pick date & time'), {
      target: { value: '2026-10-20T08:15' },
    });
    expect(screen.getByLabelText('Pick date & time')).toHaveAccessibleDescription('Tue, 08:15');
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeEnabled();
  });

  it('confirms once when Enter and ⌘↩ both fire', async () => {
    const { onConfirm } = open();
    await userEvent.keyboard('tomorrow 3pm{Enter}{Meta>}{Enter}{/Meta}');
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('closes on Escape while the picker is focused', async () => {
    const { onClose } = open();
    screen.getByLabelText('Pick date & time').focus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps presets stable across a parent re-render', () => {
    let current = AFTERNOON;
    const props = { sessionLabel: 'fix auth', onConfirm: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<SnoozeDialog {...props} now={() => current} />, {
      wrapper: harness.wrapper,
    });
    const before = screen.getByRole('button', { name: /Next month/ }).textContent;
    current = new Date(2026, 9, 20, 10, 0);
    rerender(<SnoozeDialog {...props} now={() => current} />);
    expect(screen.getByRole('button', { name: /Next month/ })).toHaveTextContent(before ?? '');
  });

  it('ignores Enter that commits an IME composition', () => {
    const { input } = open();
    expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('confirms the field that has focus, not the last one edited', async () => {
    const { onConfirm, input } = open();
    await userEvent.keyboard('3d');
    await userEvent.click(screen.getByLabelText('Pick date & time'));
    fireEvent.change(screen.getByLabelText('Pick date & time'), {
      target: { value: '2026-10-20T08:15' },
    });
    await userEvent.click(input);
    await userEvent.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith(new Date(2026, 9, 19, 14, 30));
  });

  it('disables a preset once its time has passed', async () => {
    let current = AFTERNOON;
    render(
      <SnoozeDialog sessionLabel="x" now={() => current} onConfirm={vi.fn()} onClose={vi.fn()} />,
      { wrapper: harness.wrapper },
    );
    current = NIGHT;
    await userEvent.keyboard('a');
    expect(screen.getByRole('button', { name: /Later today/ })).toBeDisabled();
  });

  it('does not confirm a preset that has gone stale', async () => {
    let current = AFTERNOON;
    const onConfirm = vi.fn();
    render(
      <SnoozeDialog sessionLabel="x" now={() => current} onConfirm={onConfirm} onClose={vi.fn()} />,
      { wrapper: harness.wrapper },
    );
    const later = screen.getByRole('button', { name: /Later today/ });
    current = NIGHT;
    fireEvent.click(later);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('rejects picker times that the calendar shifts', () => {
    open();
    const picker = screen.getByLabelText('Pick date & time');
    fireEvent.change(picker, { target: { value: '2027-03-28T02:30' } });
    expect(screen.getByText('Pick a valid date and time')).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: '0050-03-28T10:00' } });
    expect(screen.getByText('Pick a valid date and time')).toBeInTheDocument();
  });

  it('returns focus to the opener on unmount', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(
      <SnoozeDialog sessionLabel="x" now={() => AFTERNOON} onConfirm={vi.fn()} onClose={vi.fn()} />,
      { wrapper: harness.wrapper },
    );
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps focus in the text input under StrictMode', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const Wrapper = harness.wrapper;
    render(
      <StrictMode>
        <Wrapper>
          <SnoozeDialog
            sessionLabel="x"
            now={() => AFTERNOON}
            onConfirm={vi.fn()}
            onClose={vi.fn()}
          />
        </Wrapper>
      </StrictMode>,
    );
    expect(screen.getByRole('textbox', { name: 'Snooze until' })).toHaveFocus();
    opener.remove();
  });
});
