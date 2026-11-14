import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SessionRow } from '../api/types';
import * as transitions from './marks';
import type { Cursor, MarkState, ShownRows } from './marks';

export interface Marks {
  readonly markedRows: readonly SessionRow[];
  readonly state: MarkState;
  selectOnly(id: string): void;
  toggleRow(id: string, cursor: Cursor): void;
  toggleMark(id: string): void;
  extendTo(id: string, cursor: Cursor): void;
  selectAll(): void;
  toggleAll(): void;
  clear(): void;
}

interface Seen {
  readonly shown: ShownRows;
  readonly resetKey: string;
}

export function useMarks(shown: ShownRows, resetKey: string): Marks {
  const [stored, setStored] = useState<MarkState>(transitions.NO_MARK_STATE);
  const [seen, setSeen] = useState<Seen>({ shown, resetKey });
  let state = stored;
  if (seen.shown !== shown || seen.resetKey !== resetKey) {
    state =
      seen.resetKey === resetKey ? transitions.prune(stored, shown) : transitions.NO_MARK_STATE;
    setSeen({ shown, resetKey });
    if (state !== stored) setStored(state);
  }

  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  });

  const markedRows = useMemo(() => transitions.markedIn(state.marks, shown), [state.marks, shown]);
  const update = useCallback(
    (change: (current: MarkState, latest: ShownRows) => MarkState) =>
      setStored((current) => change(current, shownRef.current)),
    [],
  );
  const selectOnly = useCallback(
    (id: string) => update((current) => transitions.selectOnly(current, id)),
    [update],
  );
  const toggleRow = useCallback(
    (id: string, cursor: Cursor) =>
      update((current, latest) => transitions.toggleRow(current, id, latest, cursor)),
    [update],
  );
  const toggleMark = useCallback(
    (id: string) => update((current) => transitions.toggleMark(current, id)),
    [update],
  );
  const extendTo = useCallback(
    (id: string, cursor: Cursor) =>
      update((current, latest) => transitions.extendTo(current, id, latest, cursor)),
    [update],
  );
  const selectAll = useCallback(
    () => update((_, latest) => transitions.selectAll(latest)),
    [update],
  );
  const toggleAll = useCallback(
    () => update((current, latest) => transitions.toggleAll(current, latest)),
    [update],
  );
  const clear = useCallback(() => setStored(transitions.NO_MARK_STATE), []);
  return {
    markedRows,
    state,
    selectOnly,
    toggleRow,
    toggleMark,
    extendTo,
    selectAll,
    toggleAll,
    clear,
  };
}
