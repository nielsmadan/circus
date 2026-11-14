import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import { positions } from './derive';
import {
  NO_MARK_STATE,
  cursorPicked,
  extendTo,
  markedIn,
  prune,
  selectAll,
  selectOnly,
  targetRows,
  toggleAll,
  toggleMark,
  toggleRow,
  type Cursor,
  type MarkState,
  type ShownRows,
} from './marks';

const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makeRow({ id, session_id: id }));
const ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const shownOf = (list: typeof rows): ShownRows => ({ rows: list, positions: positions(list) });
const shown = shownOf(rows);
const ids = (state: MarkState) => [...state.marks].sort();
const placed = (id: string | null): Cursor => ({ id, anchored: true });
const moved = (id: string): Cursor => ({ id, anchored: false });

describe('plain click', () => {
  it('selects only the clicked row and clears the rest', () => {
    const marked = toggleRow(NO_MARK_STATE, 'c', shown, placed('a'));
    expect(ids(selectOnly(marked, 'e'))).toEqual([]);
    expect(selectOnly(marked, 'e').pivot).toEqual({ anchor: 'e', base: new Set(), end: 'e' });
  });

  it('returns the same state when the clicked row is already the only one', () => {
    const once = selectOnly(NO_MARK_STATE, 'b');
    expect(selectOnly(once, 'b')).toBe(once);
  });
});

describe('⌘-click', () => {
  it('turns the highlighted row and a ⌘-clicked row into a two-row selection', () => {
    expect(ids(toggleRow(NO_MARK_STATE, 'd', shown, placed('b')))).toEqual(['b', 'd']);
  });

  it('adds and removes rows once several are selected', () => {
    const two = toggleRow(NO_MARK_STATE, 'd', shown, placed('b'));
    expect(ids(toggleRow(two, 'f', shown, placed('d')))).toEqual(['b', 'd', 'f']);
    expect(ids(toggleRow(two, 'b', shown, placed('d')))).toEqual(['d']);
  });

  it('keeps an unselected cursor out of the selection it adds to', () => {
    const two = toggleRow(NO_MARK_STATE, 'd', shown, placed('b'));
    expect(ids(toggleRow(two, 'f', shown, moved('c')))).toEqual(['b', 'd', 'f']);
  });

  it('deselects the only highlighted row, leaving nothing picked', () => {
    const none = toggleRow(NO_MARK_STATE, 'b', shown, placed('b'));
    expect(ids(none)).toEqual([]);
    expect(cursorPicked(none, placed('b'))).toBe(false);
  });

  it('leaves nothing picked when the last selected row is deselected', () => {
    const one = toggleRow(
      toggleRow(NO_MARK_STATE, 'd', shown, placed('b')),
      'd',
      shown,
      placed('d'),
    );
    const none = toggleRow(one, 'b', shown, placed('d'));
    expect(ids(none)).toEqual([]);
    expect(cursorPicked(none, placed('b'))).toBe(false);
  });

  it('keeps a deselected cursor unpicked when the other selected rows are hidden', () => {
    const two = toggleRow(NO_MARK_STATE, 'd', shown, placed('b'));
    const one = toggleRow(two, 'd', shown, placed('d'));
    const hidden = prune(one, shownOf(rows.slice(2)));
    expect(ids(hidden)).toEqual([]);
    expect(cursorPicked(hidden, placed('d'))).toBe(false);
  });

  it('picks the cursor again once it moved without a selection gesture', () => {
    const none = toggleRow(NO_MARK_STATE, 'b', shown, placed('b'));
    expect(cursorPicked(none, moved('b'))).toBe(true);
  });
});

describe('x', () => {
  it('toggles the row alone, without joining the cursor', () => {
    expect(ids(toggleMark(NO_MARK_STATE, 'c'))).toEqual(['c']);
    expect(ids(toggleMark(toggleMark(NO_MARK_STATE, 'c'), 'c'))).toEqual([]);
  });
});

describe('⇧-click and ⇧J/⇧K', () => {
  it('selects the range from the highlighted row in either direction', () => {
    expect(ids(extendTo(NO_MARK_STATE, 'e', shown, placed('b')))).toEqual(['b', 'c', 'd', 'e']);
    expect(ids(extendTo(NO_MARK_STATE, 'b', shown, placed('e')))).toEqual(['b', 'c', 'd', 'e']);
  });

  it('keeps the earlier selection when a range is added', () => {
    const picked = toggleRow(NO_MARK_STATE, 'e', shown, placed('a'));
    expect(ids(extendTo(picked, 'g', shown, placed('e')))).toEqual(['a', 'e', 'f', 'g']);
  });

  it('adjusts the same range on a second gesture, shrinking it when going back', () => {
    const picked = toggleRow(NO_MARK_STATE, 'c', shown, placed('a'));
    const wide = extendTo(picked, 'g', shown, placed('c'));
    expect(ids(wide)).toEqual(['a', 'c', 'd', 'e', 'f', 'g']);
    expect(ids(extendTo(wide, 'd', shown, placed('g')))).toEqual(['a', 'c', 'd']);
  });

  it('starts a new range at the cursor once it moved by a plain step', () => {
    const range = extendTo(NO_MARK_STATE, 'd', shown, placed('a'));
    expect(ids(extendTo(range, 'c', shown, moved('d')))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('collapses to a single row when the range shrinks back to its anchor', () => {
    const range = extendTo(NO_MARK_STATE, 'b', shown, placed('a'));
    expect(ids(extendTo(range, 'a', shown, placed('b')))).toEqual([]);
  });

  it('returns the same state when the range already ends at the row', () => {
    const range = extendTo(NO_MARK_STATE, 'c', shown, placed('a'));
    expect(extendTo(range, 'c', shown, placed('c'))).toBe(range);
  });

  it('selects a row again on ⇧-click after ⌘-click deselected it', () => {
    const two = toggleRow(NO_MARK_STATE, 'b', shown, placed('a'));
    const one = toggleRow(two, 'b', shown, placed('b'));
    expect(ids(extendTo(one, 'b', shown, placed('b')))).toEqual(['a', 'b']);
    const none = toggleRow(NO_MARK_STATE, 'a', shown, placed('a'));
    const back = extendTo(none, 'a', shown, placed('a'));
    expect(cursorPicked(back, placed('a'))).toBe(true);
  });

  it('anchors on the clicked row when no cursor is shown', () => {
    const fromNothing = extendTo(NO_MARK_STATE, 'c', shown, placed(null));
    expect(ids(fromNothing)).toEqual([]);
    expect(fromNothing.pivot?.anchor).toBe('c');
    expect(extendTo(NO_MARK_STATE, 'c', shown, placed('zz')).pivot?.anchor).toBe('c');
  });
});

describe('all rows', () => {
  it('selects every shown row', () => {
    expect(ids(selectAll(shown))).toEqual(ALL);
  });

  it('selects every row when some are selected, and clears when all are', () => {
    expect(ids(toggleAll(toggleMark(NO_MARK_STATE, 'a'), shown))).toEqual(ALL);
    expect(ids(toggleAll(selectAll(shown), shown))).toEqual([]);
  });
});

describe('shown rows', () => {
  it('drops selected rows that are no longer shown', () => {
    const range = extendTo(NO_MARK_STATE, 'c', shown, placed('a'));
    const narrower = shownOf(rows.slice(1));
    expect(ids(prune(range, narrower))).toEqual(['b', 'c']);
    expect(prune(range, narrower).pivot).toBeNull();
  });

  it('returns the same state when every selected row is shown', () => {
    const range = extendTo(NO_MARK_STATE, 'c', shown, placed('a'));
    expect(prune(range, shown)).toBe(range);
  });

  it('lists the selected rows that are shown, in list order', () => {
    expect(markedIn(new Set(['c', 'zz', 'a']), shown)).toEqual([rows[0], rows[2]]);
  });
});

describe('targets', () => {
  const first = makeRow({ id: 'a', session_id: 'a' });
  const second = makeRow({ id: 'b', session_id: 'b' });

  it('acts on the selected rows when there are any', () => {
    expect(targetRows([second], NO_MARK_STATE, placed('a'), first)).toEqual([second]);
  });

  it('acts on the cursor row otherwise, unless a ⌘-click deselected it', () => {
    expect(targetRows([], NO_MARK_STATE, placed('a'), first)).toEqual([first]);
    const none = toggleRow(NO_MARK_STATE, 'a', shown, placed('a'));
    expect(targetRows([], none, placed('a'), first)).toEqual([]);
    expect(targetRows([], NO_MARK_STATE, placed(null), null)).toEqual([]);
  });
});
