import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { SessionRow } from '../api/types';
import { isSnoozed } from './derive';
import { ROW_HEIGHT, rowWindow } from './rowWindow';
import { formatted, NO_WAKE_DATE, WAKE_FORMAT } from './timeFormats';

export const RowRenderProbe = createContext<((id: string) => void) | null>(null);

export type RowGesture = 'only' | 'toggle' | 'extend' | 'open';

interface RowProps {
  readonly row: SessionRow;
  readonly selected: boolean;
  readonly current: boolean;
  readonly onPointer: (id: string, gesture: RowGesture) => void;
}

function gestureOf(event: MouseEvent<HTMLDivElement>): RowGesture {
  if (event.shiftKey) return 'extend';
  return event.metaKey ? 'toggle' : 'only';
}

const rowDomId = (id: string): string => `session-row-${id}`;

const CHIP = 'shrink-0 rounded px-1.5 py-px text-[11px] leading-4';

const STATUS_STYLES: Readonly<Record<string, string>> = {
  unclassified: 'bg-neutral-500/10 opacity-70',
  unfinished: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  blocked: 'bg-red-500/15 text-red-800 dark:text-red-300',
  finished: 'bg-green-500/15 text-green-800 dark:text-green-400',
  abandoned: 'bg-neutral-500/10 italic opacity-70',
};

function statusStyle(status: string): string {
  return STATUS_STYLES[status] ?? 'bg-neutral-500/10 italic';
}

const SessionRowItem = memo(function SessionRowItem({
  row,
  selected,
  current,
  onPointer,
}: RowProps): ReactElement {
  useContext(RowRenderProbe)?.(row.id);
  const summary = row.what_it_is ?? row.last_prompt ?? '';
  return (
    <div
      id={rowDomId(row.id)}
      role="option"
      aria-selected={selected}
      data-row-id={row.id}
      onClick={(event) => {
        if (event.detail < 2) onPointer(row.id, gestureOf(event));
      }}
      onDoubleClick={() => onPointer(row.id, 'open')}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default flex-col justify-center gap-0.5 border-b border-neutral-200 px-3 dark:border-neutral-800 ${
        selected ? 'bg-blue-500/15' : 'hover:bg-neutral-500/5'
      } ${current ? 'ring-1 ring-blue-500/60 ring-inset' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {row.running === true && (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-green-500" />
        )}
        <span className="min-w-[30%] flex-1 truncate font-medium">{row.label}</span>
        {row.running === true && (
          <span className={`${CHIP} bg-green-500/15 text-green-800 dark:text-green-400`}>
            running
          </span>
        )}
        {row.badges.map((badge) => (
          <span key={badge} className={`${CHIP} bg-neutral-500/15`}>
            {badge}
          </span>
        ))}
        {isSnoozed(row) && (
          <span className="min-w-0 truncate text-xs text-blue-700 dark:text-blue-300">
            {row.snoozed_until === null
              ? NO_WAKE_DATE
              : `wakes ${formatted(WAKE_FORMAT, row.snoozed_until)}`}
          </span>
        )}
        <span className="shrink-0 text-xs opacity-60">{row.age_human}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className={`${CHIP} ${statusStyle(row.status)}`}>{row.status}</span>
        <span className="shrink-0 opacity-70">{row.project_label}</span>
        <span className="min-w-0 flex-1 truncate opacity-60">{summary}</span>
        <span className={`${CHIP} bg-neutral-500/10 opacity-80`}>{row.agent}</span>
      </div>
    </div>
  );
});

export interface SessionListProps {
  readonly rows: readonly SessionRow[];
  readonly cursorId: string | null;
  readonly selection: ReadonlySet<string>;
  readonly scrollTop: number;
  readonly viewport: number;
  readonly onScroll: (scrollTop: number) => void;
  readonly onResize: (height: number) => void;
  readonly onPointer: (id: string, gesture: RowGesture) => void;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly empty: ReactNode;
}

export const SessionList = memo(function SessionList(props: SessionListProps): ReactElement {
  const { rows, cursorId, selection, scrollTop, viewport, onScroll, onResize, onPointer, listRef } =
    props;

  useLayoutEffect(() => {
    const node = listRef.current;
    if (node !== null && node.scrollTop !== scrollTop) node.scrollTop = scrollTop;
  }, [listRef, scrollTop, viewport]);

  useEffect(() => {
    const node = listRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((records) => {
      const height = records[records.length - 1]?.contentRect.height;
      if (height !== undefined) onResize(height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [listRef, onResize]);

  const span = rowWindow(scrollTop, viewport, rows.length);
  const windowRows = rows.slice(span.start, span.end);
  const cursorShown = windowRows.some((row) => row.id === cursorId);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Sessions"
      aria-multiselectable="true"
      aria-activedescendant={cursorShown && cursorId !== null ? rowDomId(cursorId) : undefined}
      tabIndex={0}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      className="h-full min-h-0 overflow-y-auto outline-none select-none"
    >
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm opacity-60">{props.empty}</div>
      ) : (
        <>
          <div aria-hidden="true" style={{ height: span.padTop }} />
          {windowRows.map((row) => {
            const selected = selection.has(row.id);
            return (
              <SessionRowItem
                key={row.id}
                row={row}
                selected={selected}
                current={row.id === cursorId && (selection.size > 1 || !selected)}
                onPointer={onPointer}
              />
            );
          })}
          <div aria-hidden="true" style={{ height: span.padBottom }} />
        </>
      )}
    </div>
  );
});
