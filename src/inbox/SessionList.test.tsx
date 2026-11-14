import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeRow } from '../test/fixtures';
import { SessionList, type SessionListProps } from './SessionList';

const rows = Array.from({ length: 100 }, (_, i) => makeRow({ id: `r${i}`, session_id: `r${i}` }));

const props = (overrides: Partial<SessionListProps>): SessionListProps => ({
  rows,
  cursorId: null,
  selection: new Set(),
  scrollTop: 0,
  viewport: 0,
  onScroll: () => undefined,
  onResize: () => undefined,
  onPointer: () => undefined,
  listRef: { current: null },
  empty: null,
  ...overrides,
});

describe('SessionList scroll sync', () => {
  it('rewrites the offset when the viewport changes after the element lost it', () => {
    const listRef = { current: null as HTMLDivElement | null };
    const { rerender, getByRole } = render(
      <SessionList {...props({ listRef, scrollTop: 2304 })} />,
    );
    const node = getByRole('listbox');
    expect(node.scrollTop).toBe(2304);
    node.scrollTop = 0;
    rerender(<SessionList {...props({ listRef, scrollTop: 2304, viewport: 600 })} />);
    expect(node.scrollTop).toBe(2304);
  });
});

describe('SessionList selection', () => {
  const selectedIds = (listbox: HTMLElement) =>
    within(listbox)
      .getAllByRole('option', { selected: true })
      .map((option) => option.dataset.rowId);
  const outlined = (listbox: HTMLElement) =>
    within(listbox)
      .getAllByRole('option')
      .filter((option) => option.className.includes('ring-1'))
      .map((option) => option.dataset.rowId);

  it('marks the selected rows and points at the cursor row', () => {
    const { getByRole } = render(
      <SessionList {...props({ cursorId: 'r2', selection: new Set(['r2']), viewport: 600 })} />,
    );
    const listbox = getByRole('listbox');
    expect(listbox).toHaveAttribute('aria-multiselectable', 'true');
    expect(listbox).toHaveAttribute('aria-activedescendant', 'session-row-r2');
    expect(selectedIds(listbox)).toEqual(['r2']);
    expect(outlined(listbox)).toEqual([]);
  });

  it('outlines the cursor row while several rows are selected', () => {
    const { getByRole } = render(
      <SessionList
        {...props({ cursorId: 'r2', selection: new Set(['r1', 'r3']), viewport: 600 })}
      />,
    );
    expect(selectedIds(getByRole('listbox'))).toEqual(['r1', 'r3']);
    expect(outlined(getByRole('listbox'))).toEqual(['r2']);
  });

  it('outlines a cursor row that is not selected', () => {
    const { getByRole } = render(
      <SessionList {...props({ cursorId: 'r2', selection: new Set(['r1']), viewport: 600 })} />,
    );
    expect(outlined(getByRole('listbox'))).toEqual(['r2']);
  });

  it('points at no row when the cursor row is scrolled out of the window', () => {
    const { getByRole } = render(
      <SessionList {...props({ cursorId: 'r90', selection: new Set(['r90']), viewport: 600 })} />,
    );
    expect(getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull();
  });

  it('reports a plain, ⌘, ⇧ and double click as their gestures', () => {
    const onPointer = vi.fn();
    const { getByRole } = render(<SessionList {...props({ onPointer, viewport: 600 })} />);
    const row = getByRole('listbox').querySelector('[data-row-id="r4"]') as HTMLElement;
    fireEvent.click(row);
    fireEvent.click(row, { metaKey: true });
    fireEvent.click(row, { shiftKey: true });
    fireEvent.click(row, { shiftKey: true, metaKey: true });
    fireEvent.click(row, { detail: 2 });
    fireEvent.doubleClick(row);
    expect(onPointer.mock.calls).toEqual([
      ['r4', 'only'],
      ['r4', 'toggle'],
      ['r4', 'extend'],
      ['r4', 'extend'],
      ['r4', 'open'],
    ]);
  });
});
