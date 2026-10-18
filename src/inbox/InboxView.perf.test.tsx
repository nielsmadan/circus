import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { syntheticRows } from '../dev/synthetic';
import { ShortcutRegistryProvider } from '../shortcuts/react';
import { createFakeApi } from '../test/fakeApi';
import { makeList } from '../test/fixtures';
import { shortcutHarness, type ShortcutHarness } from '../test/shortcuts';
import { RowRenderProbe } from './SessionList';

let harness: ShortcutHarness;

beforeEach(async () => {
  harness = await shortcutHarness();
});

afterEach(() => harness.dispose());

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
};

function press(code: string) {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }),
    );
  });
}

const selectedIds = () =>
  within(screen.getByRole('listbox', { name: 'Sessions' }))
    .getAllByRole('option', { selected: true })
    .map((option) => option.dataset.rowId);

describe('InboxView re-render budget', () => {
  it('re-renders at most 3 rows for one j over 5 000 rows', async () => {
    const api = createFakeApi(makeList(syntheticRows(5000, Date.UTC(2026, 9, 16, 12))));
    const renders: string[] = [];
    render(
      <RowRenderProbe.Provider value={(id) => renders.push(id)}>
        <ShortcutRegistryProvider registry={harness.registry}>
          <App api={api} />
        </ShortcutRegistryProvider>
      </RowRenderProbe.Provider>,
    );
    await settle();
    press('Tab');
    press('Tab');
    await settle();
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
    const options = within(screen.getByRole('listbox', { name: 'Sessions' })).getAllByRole(
      'option',
    );
    const [first, second] = options.map((option) => option.dataset.rowId);
    expect(selectedIds()).toEqual([first]);

    renders.length = 0;
    press('KeyJ');

    expect(selectedIds()).toEqual([second]);
    expect(renders.length).toBeLessThanOrEqual(3);
    expect([...renders].sort()).toEqual([first, second].sort());
  });
});
