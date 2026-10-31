import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import type { SessionRow } from '../api/types';
import { ROW_HEIGHT, rowWindow } from './rowWindow';

export const RowRenderProbe = createContext<((id: string) => void) | null>(null);

interface RowProps {
  readonly row: SessionRow;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

const rowDomId = (id: string): string => `session-row-${id}`;

const CHIP = 'shrink-0 rounded px-1.5 py-px text-[11px] leading-4';

const SessionRowItem = memo(function SessionRowItem({
  row,
  selected,
  onSelect,
}: RowProps): ReactElement {
  useContext(RowRenderProbe)?.(row.id);
  const summary = row.what_it_is ?? row.last_prompt ?? '';
  return (
    <div
      id={rowDomId(row.id)}
      role="option"
      aria-selected={selected}
      data-row-id={row.id}
      onClick={() => onSelect(row.id)}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default flex-col justify-center gap-0.5 border-b border-neutral-200 px-3 dark:border-neutral-800 ${
        selected ? 'bg-blue-500/15' : 'hover:bg-neutral-500/5'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {row.running === true && (
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-green-500" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
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
        <span className="shrink-0 text-xs opacity-60">{row.age_human}</span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="shrink-0 opacity-70">{row.project_label}</span>
        <span className="min-w-0 flex-1 truncate opacity-60">{summary}</span>
        <span className={`${CHIP} bg-neutral-500/10 opacity-80`}>{row.agent}</span>
      </div>
    </div>
  );
});

export interface SessionListProps {
  readonly rows: readonly SessionRow[];
  readonly selectedId: string | null;
  readonly scrollTop: number;
  readonly viewport: number;
  readonly onScroll: (scrollTop: number) => void;
  readonly onResize: (height: number) => void;
  readonly onSelect: (id: string) => void;
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly empty: ReactNode;
}

export const SessionList = memo(function SessionList(props: SessionListProps): ReactElement {
  const { rows, selectedId, scrollTop, viewport, onScroll, onResize, onSelect, listRef } = props;

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
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Sessions"
      aria-activedescendant={selectedId === null ? undefined : rowDomId(selectedId)}
      tabIndex={0}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      className="h-full min-h-0 overflow-y-auto outline-none"
    >
      {rows.length === 0 ? (
        <div className="p-6 text-center text-sm opacity-60">{props.empty}</div>
      ) : (
        <>
          <div aria-hidden="true" style={{ height: span.padTop }} />
          {rows.slice(span.start, span.end).map((row) => (
            <SessionRowItem
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={onSelect}
            />
          ))}
          <div aria-hidden="true" style={{ height: span.padBottom }} />
        </>
      )}
    </div>
  );
});
