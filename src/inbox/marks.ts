import type { SessionRow } from '../api/types';

export interface ShownRows {
  readonly rows: readonly SessionRow[];
  readonly positions: ReadonlyMap<string, number>;
}

export interface Cursor {
  readonly id: string | null;
  readonly anchored: boolean;
}

export interface Pivot {
  readonly anchor: string;
  readonly base: ReadonlySet<string>;
  readonly end: string;
}

export interface MarkState {
  readonly marks: ReadonlySet<string>;
  readonly pivot: Pivot | null;
  readonly unselected: string | null;
}

const NO_MARKS: ReadonlySet<string> = new Set();
const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

export const NO_MARK_STATE: MarkState = Object.freeze({
  marks: NO_MARKS,
  pivot: null,
  unselected: null,
});

function toggled(marks: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return marks.has(id)
    ? new Set([...marks].filter((each) => each !== id))
    : new Set([...marks, id]);
}

function shownIds(shown: ShownRows): ReadonlySet<string> {
  return new Set(shown.rows.map((row) => row.id));
}

function rangeIds(shown: ShownRows, from: string, to: string): readonly string[] {
  const start = shown.positions.get(from);
  const end = shown.positions.get(to);
  if (end === undefined) return [];
  if (start === undefined) return [to];
  return shown.rows.slice(Math.min(start, end), Math.max(start, end) + 1).map((row) => row.id);
}

export function cursorPicked(state: MarkState, cursor: Cursor): boolean {
  return !(cursor.anchored && cursor.id !== null && state.unselected === cursor.id);
}

export function markedIn(marks: ReadonlySet<string>, shown: ShownRows): readonly SessionRow[] {
  if (marks.size === 0) return NO_ROWS;
  return [...marks]
    .flatMap((id) => {
      const at = shown.positions.get(id);
      return at === undefined ? [] : [at];
    })
    .sort((a, b) => a - b)
    .flatMap((at) => {
      const row = shown.rows[at];
      return row === undefined ? [] : [row];
    });
}

export function selectOnly(state: MarkState, id: string): MarkState {
  const { marks, pivot, unselected } = state;
  const already =
    marks.size === 0 &&
    unselected === null &&
    pivot !== null &&
    pivot.anchor === id &&
    pivot.end === id &&
    pivot.base.size === 0;
  return already
    ? state
    : { marks: NO_MARKS, pivot: { anchor: id, base: NO_MARKS, end: id }, unselected: null };
}

export function targetRows(
  marked: readonly SessionRow[],
  state: MarkState,
  cursor: Cursor,
  cursorRow: SessionRow | null,
): readonly SessionRow[] {
  if (marked.length > 0) return marked;
  return cursorRow !== null && cursorPicked(state, cursor) ? [cursorRow] : NO_ROWS;
}

function rowAt(shown: ShownRows, id: string | null): SessionRow | null {
  const at = id === null ? undefined : shown.positions.get(id);
  return at === undefined ? null : (shown.rows[at] ?? null);
}

function sameMarks(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

export function toggleRow(
  state: MarkState,
  id: string,
  shown: ShownRows,
  cursor: Cursor,
): MarkState {
  const targets = targetRows(markedIn(state.marks, shown), state, cursor, rowAt(shown, cursor.id));
  const marks = toggled(new Set(targets.map((row) => row.id)), id);
  const kept = marks.has(id);
  return {
    marks: marks.size === 0 ? NO_MARKS : marks,
    pivot: { anchor: id, base: marks, end: id },
    unselected: kept ? null : id,
  };
}

export function toggleMark(state: MarkState, id: string): MarkState {
  const marks = toggled(state.marks, id);
  return { marks, pivot: { anchor: id, base: marks, end: id }, unselected: null };
}

export function extendTo(
  state: MarkState,
  id: string,
  shown: ShownRows,
  cursor: Cursor,
): MarkState {
  const { pivot } = state;
  const live =
    cursor.anchored &&
    pivot !== null &&
    pivot.end === cursor.id &&
    shown.positions.has(pivot.anchor)
      ? pivot
      : null;
  const anchor =
    live?.anchor ?? (cursor.id !== null && shown.positions.has(cursor.id) ? cursor.id : id);
  const base = live?.base ?? state.marks;
  const range = rangeIds(shown, anchor, id);
  const marks = base.size === 0 && range.length <= 1 ? NO_MARKS : new Set([...base, ...range]);
  const unchanged =
    live !== null && live.end === id && state.unselected === null && sameMarks(marks, state.marks);
  return unchanged ? state : { marks, pivot: { anchor, base, end: id }, unselected: null };
}

export function selectAll(shown: ShownRows): MarkState {
  return { marks: shownIds(shown), pivot: null, unselected: null };
}

export function toggleAll(state: MarkState, shown: ShownRows): MarkState {
  const everyMarked = shown.rows.length > 0 && shown.rows.every((row) => state.marks.has(row.id));
  return everyMarked ? NO_MARK_STATE : selectAll(shown);
}

export function prune(state: MarkState, shown: ShownRows): MarkState {
  if ([...state.marks].every((id) => shown.positions.has(id))) return state;
  return {
    marks: new Set([...state.marks].filter((id) => shown.positions.has(id))),
    pivot: null,
    unselected: state.unselected,
  };
}
