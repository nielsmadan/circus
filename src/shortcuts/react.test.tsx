import { parseShortcut } from '@shortcutkit/core';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { inboxListContext, type InboxListAction } from './contexts';
import { useShortcutContext, useShortcutLabel, useShortcutRegistry } from './react';

let harness: ShortcutHarness;

beforeEach(async () => {
  harness = await shortcutHarness();
});

afterEach(() => harness.dispose());

function Listener(props: { handler: (action: InboxListAction) => void; enabled?: boolean }) {
  useShortcutContext(inboxListContext, props.handler, props.enabled);
  return null;
}

function Label(props: { action: InboxListAction }) {
  return <span>{useShortcutLabel(inboxListContext, props.action)}</span>;
}

describe('useShortcutContext', () => {
  it('routes key presses to the handler', async () => {
    const handler = vi.fn();
    render(<Listener handler={handler} />, { wrapper: harness.wrapper });
    await userEvent.keyboard('j');
    expect(handler).toHaveBeenCalledWith('next');
  });

  it('calls the newest handler without re-activating', async () => {
    const activate = vi.spyOn(harness.registry, 'activate');
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Listener handler={first} />, { wrapper: harness.wrapper });
    rerender(<Listener handler={second} />);
    await userEvent.keyboard('j');
    expect(second).toHaveBeenCalledWith('next');
    expect(first).toHaveBeenCalledTimes(0);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('stays inactive when disabled', async () => {
    const handler = vi.fn();
    render(<Listener handler={handler} enabled={false} />, { wrapper: harness.wrapper });
    await userEvent.keyboard('j');
    expect(handler).toHaveBeenCalledTimes(0);
    expect(harness.registry.getSnapshot().activations).toEqual([]);
  });

  it('deactivates on unmount', () => {
    const { unmount } = render(<Listener handler={vi.fn()} />, { wrapper: harness.wrapper });
    expect(harness.registry.getSnapshot().activations.map((a) => a.contextId)).toEqual([
      'inbox.list',
    ]);
    unmount();
    expect(harness.registry.getSnapshot().activations).toEqual([]);
  });
});

describe('useShortcutLabel', () => {
  it('renders the mac label of the first shortcut', () => {
    render(
      <>
        <Label action="archive" />
        <Label action="delete" />
      </>,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText('⇧E')).toBeInTheDocument();
    expect(screen.getByText('⇧3')).toBeInTheDocument();
  });

  it('renders nothing for an unbound action', () => {
    const { container } = render(<Label action="rescan" />, { wrapper: harness.wrapper });
    expect(container.innerHTML).toBe('<span></span>');
  });

  it('follows a rebinding', () => {
    render(<Label action="archive" />, { wrapper: harness.wrapper });
    act(() =>
      harness.registry.setShortcuts(inboxListContext, 'archive', [parseShortcut('alt+a', 'mac')]),
    );
    expect(screen.getByText('⌥A')).toBeInTheDocument();
  });
});

describe('useShortcutRegistry', () => {
  it('throws outside the provider', () => {
    function Bare() {
      useShortcutRegistry();
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bare />)).toThrow('ShortcutRegistryProvider');
  });
});
