import { useCallback, useMemo, useState } from 'react';
import type { SessionRow } from '../api/types';

const NO_MARKS: ReadonlySet<string> = new Set();
const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

export function toggled(marks: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(marks);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggledAll(
  marks: ReadonlySet<string>,
  rows: readonly SessionRow[],
): ReadonlySet<string> {
  const everyMarked = rows.length > 0 && rows.every((row) => marks.has(row.id));
  return everyMarked ? NO_MARKS : new Set(rows.map((row) => row.id));
}

export function markedIn(
  marks: ReadonlySet<string>,
  rows: readonly SessionRow[],
  positions: ReadonlyMap<string, number>,
): readonly SessionRow[] {
  if (marks.size === 0) return NO_ROWS;
  return [...marks]
    .flatMap((id) => {
      const at = positions.get(id);
      return at === undefined ? [] : [at];
    })
    .sort((a, b) => a - b)
    .flatMap((at) => {
      const row = rows[at];
      return row === undefined ? [] : [row];
    });
}

export interface Marks {
  readonly marks: ReadonlySet<string>;
  readonly markedRows: readonly SessionRow[];
  toggle(id: string): void;
  toggleAll(rows: readonly SessionRow[]): void;
  clear(): void;
}

export function useMarks(
  shown: readonly SessionRow[],
  positions: ReadonlyMap<string, number>,
): Marks {
  const [marks, setMarks] = useState<ReadonlySet<string>>(NO_MARKS);
  const markedRows = useMemo(() => markedIn(marks, shown, positions), [marks, shown, positions]);
  const toggle = useCallback((id: string) => setMarks((current) => toggled(current, id)), []);
  const toggleAll = useCallback(
    (rows: readonly SessionRow[]) => setMarks((current) => toggledAll(current, rows)),
    [],
  );
  const clear = useCallback(() => setMarks(NO_MARKS), []);
  return { marks, markedRows, toggle, toggleAll, clear };
}
