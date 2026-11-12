import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FolderTree, isOpen } from './FolderTree';
import type { Scope } from './scope';
import type { FolderNode } from './sidebarGroups';
import { withChoice } from './useSidebarScope';

const node = (
  path: string,
  name: string,
  own: number,
  children: readonly FolderNode[] = [],
): FolderNode => ({
  path,
  name,
  own,
  total: children.reduce((sum, c) => sum + c.total, own),
  children,
  scope: { kind: 'tree', key: path, label: name, excluding: null },
});

const ROOTS: readonly FolderNode[] = [
  node('/u', '~', 0, [
    node('/u/wrksp/circus', 'wrksp/circus', 0, [
      node('/u/wrksp/circus/dev1', 'dev1', 2),
      node('/u/wrksp/circus/dev2', 'dev2', 1),
    ]),
    node('/u/notes', 'notes', 1),
  ]),
  node('(unknown)', 'Unknown folder', 1),
];

function Harness({ onScope }: { readonly onScope: (scope: Scope | null) => void }) {
  const [scope, setScope] = useState<Scope | null>(null);
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  return (
    <ul>
      <FolderTree
        roots={ROOTS}
        scope={scope}
        choices={choices}
        onScope={(next) => {
          setScope(next);
          onScope(next);
        }}
        onOpen={(path, open) => setChoices((current) => withChoice(current, path, open))}
      />
    </ul>
  );
}

describe('FolderTree', () => {
  it('starts with the roots and their first level open, showing totals', () => {
    render(<Harness onScope={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^dev1/ })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /^wrksp\/circus/ })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Collapse wrksp/circus' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('opens and closes a folder without selecting it', () => {
    const onScope = vi.fn();
    render(<Harness onScope={onScope} />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse wrksp/circus' }));
    expect(screen.getByRole('button', { name: 'Expand wrksp/circus' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: /^dev1/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand wrksp/circus' }));
    expect(screen.getByRole('button', { name: /^dev1/ })).toHaveTextContent('2');
    expect(onScope).not.toHaveBeenCalled();
  });

  it('selects a folder with its sub-folders, and a second click clears it', () => {
    const onScope = vi.fn();
    render(<Harness onScope={onScope} />);
    const circus = screen.getByRole('button', { name: /^wrksp\/circus/ });
    fireEvent.click(circus);
    expect(onScope).toHaveBeenLastCalledWith({
      kind: 'tree',
      key: '/u/wrksp/circus',
      label: 'wrksp/circus',
      excluding: null,
    });
    expect(circus).toHaveAttribute('aria-current', 'true');
    fireEvent.click(circus);
    expect(onScope).toHaveBeenLastCalledWith(null);
  });

  it('keeps focus where it was when clicked', () => {
    render(<Harness onScope={vi.fn()} />);
    const toggleButton = screen.getByRole('button', { name: 'Collapse ~' });
    expect(fireEvent.mouseDown(toggleButton)).toBe(false);
    expect(toggleButton).toHaveAttribute('tabindex', '-1');
  });
});

describe('isOpen', () => {
  it('opens the first two levels unless the user chose otherwise, whatever the depth now', () => {
    const folder = node('/u/a', 'a', 1);
    expect([0, 1, 2].map((depth) => isOpen(folder, depth, new Map()))).toEqual([true, true, false]);
    const closed = withChoice(new Map(), '/u/a', false);
    expect([0, 2].map((depth) => isOpen(folder, depth, closed))).toEqual([false, false]);
    const opened = withChoice(closed, '/u/a', true);
    expect([...opened]).toEqual([['/u/a', true]]);
    expect([...closed]).toEqual([['/u/a', false]]);
  });
});
