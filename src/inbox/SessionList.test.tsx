import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import { SessionList, type SessionListProps } from './SessionList';

const rows = Array.from({ length: 100 }, (_, i) => makeRow({ id: `r${i}`, session_id: `r${i}` }));

const props = (overrides: Partial<SessionListProps>): SessionListProps => ({
  rows,
  selectedId: null,
  scrollTop: 0,
  viewport: 0,
  onScroll: () => undefined,
  onResize: () => undefined,
  onSelect: () => undefined,
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
