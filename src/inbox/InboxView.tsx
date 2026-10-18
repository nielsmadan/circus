import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import type { CircusApi } from '../api/client';
import { toCircusError, type DecisionAction, type SessionRow } from '../api/types';
import { inboxListContext, type InboxListAction } from '../shortcuts/contexts';
import { useShortcutContext } from '../shortcuts/react';
import { SnoozeDialog } from '../snooze/SnoozeDialog';
import { Banners } from './Banners';
import { Conversation } from './Conversation';
import {
  filterByProject,
  indexRows,
  nextSelection,
  positions,
  projectCounts,
  searchRows,
  splitCounts,
  splitRows,
  SPLITS,
  type Split,
} from './derive';
import { clearSelect, hasSelectMark, markPaint, markSelect } from './perfMarks';
import { ProjectSidebar } from './ProjectSidebar';
import { ReadingPane } from './ReadingPane';
import { effectiveViewport, ROW_HEIGHT, scrollToShow } from './rowWindow';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { SplitTabs } from './SplitTabs';
import { StatusBar } from './StatusBar';
import type { InboxController } from './useInbox';
import { useTails } from './useTails';

export interface InboxViewProps {
  readonly controller: InboxController;
  readonly api: CircusApi;
  readonly visible: boolean;
}

interface View {
  readonly selectedId: string | null;
  readonly scrollTop: number;
}

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);
const INITIAL_VIEW: View = Object.freeze({ selectedId: null, scrollTop: 0 });
const currentTime = () => new Date();

const DECISION_FOR: Readonly<Partial<Record<InboxListAction, DecisionAction>>> = {
  harvestArchive: 'harvest',
  archive: 'archive',
  delete: 'delete',
  keep: 'keep',
  keepGoing: 'keep_going',
};

function emptyText(
  split: Split,
  recentDays: number,
  query: string,
  projectFiltered: boolean,
): string {
  if (query.trim() !== '') return `No sessions match “${query}”`;
  if (projectFiltered) return 'No sessions in this project — Esc shows all projects';
  switch (split) {
    case 'recent':
      return `Nothing from the last ${recentDays} days is waiting`;
    case 'woke':
      return 'No snoozed sessions have woken up';
    case 'all':
      return 'Inbox zero';
  }
}

function reconcileView(
  view: View,
  before: readonly SessionRow[],
  after: readonly SessionRow[],
  viewport: number,
): View {
  const selectedId = nextSelection(before, after, view.selectedId);
  const index = selectedId === null ? -1 : after.findIndex((row) => row.id === selectedId);
  const wasAt = before.findIndex((row) => row.id === view.selectedId);
  const maxTop = Math.max(0, after.length * ROW_HEIGHT - effectiveViewport(viewport));
  const clamped = Math.min(view.scrollTop, maxTop);
  const moved = selectedId !== view.selectedId || index !== wasAt;
  const scrollTop = moved && index >= 0 ? scrollToShow(index, clamped, viewport) : clamped;
  return selectedId === view.selectedId && scrollTop === view.scrollTop
    ? view
    : { selectedId, scrollTop };
}

function nextSplit(split: Split, delta: number): Split {
  const at = SPLITS.indexOf(split);
  return SPLITS[(at + delta + SPLITS.length) % SPLITS.length] ?? split;
}

export function InboxView({ controller, api, visible }: InboxViewProps): ReactElement {
  const [split, setSplit] = useState<Split>('recent');
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [viewport, setViewport] = useState(0);
  const [snoozeTarget, setSnoozeTarget] = useState<SessionRow | null>(null);
  const [roundupDismissed, setRoundupDismissed] = useState(false);

  const { list, rows } = controller;
  const index = useMemo(() => indexRows(list?.sessions ?? NO_ROWS), [list]);
  const inSplit = useMemo(() => splitRows(rows, split, index), [rows, split, index]);
  const shown = useMemo(
    () => searchRows(filterByProject(inSplit, projectKey), query, index),
    [inSplit, projectKey, query, index],
  );
  const shownPositions = useMemo(() => positions(shown), [shown]);
  const counts = useMemo(() => splitCounts(filterByProject(rows, projectKey)), [rows, projectKey]);
  const projects = useMemo(() => projectCounts(inSplit, index), [inSplit, index]);

  const [prevShown, setPrevShown] = useState<readonly SessionRow[]>(NO_ROWS);
  if (shown !== prevShown) {
    setPrevShown(shown);
    setView((current) => reconcileView(current, prevShown, shown, viewport));
  }

  const selectedIndex = view.selectedId === null ? undefined : shownPositions.get(view.selectedId);
  const selectedRow = selectedIndex === undefined ? null : (shown[selectedIndex] ?? null);
  const tail = useTails(api, shown, shownPositions, selectedRow, list?.sessions ?? null);
  const conversation = useMemo(
    () =>
      selectedRow === null ? null : (
        <Conversation row={selectedRow} item={tail.item} error={tail.error} />
      ),
    [selectedRow, tail.item, tail.error],
  );

  const viewRef = useRef(view);
  const shownRef = useRef(shown);
  const positionsRef = useRef(shownPositions);
  const viewportRef = useRef(viewport);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  useLayoutEffect(() => {
    viewRef.current = view;
    shownRef.current = shown;
    positionsRef.current = shownPositions;
  });

  const onSelect = useCallback(
    (id: string) =>
      setView((current) => (current.selectedId === id ? current : { ...current, selectedId: id })),
    [],
  );
  const onScroll = useCallback(
    (scrollTop: number) =>
      setView((current) => (current.scrollTop === scrollTop ? current : { ...current, scrollTop })),
    [],
  );
  const onResize = useCallback((height: number) => {
    viewportRef.current = height;
    setViewport(height);
  }, []);
  const changeSplit = useCallback(
    (next: Split) => {
      if (next === split) return;
      setSplit(next);
      setView(INITIAL_VIEW);
      setProjectKey((key) =>
        key !== null && filterByProject(splitRows(rows, next, index), key).length === 0
          ? null
          : key,
      );
    },
    [split, rows, index],
  );
  const inCurrentView = (row: SessionRow): boolean =>
    searchRows(filterByProject(splitRows([row], split, index), projectKey), query, index).length >
    0;
  const onProject = useCallback((key: string | null) => setProjectKey(key), []);
  const onDismissRoundup = useCallback(() => setRoundupDismissed(true), []);
  const onSearchDone = useCallback(() => listRef.current?.focus(), []);

  const selectedId = view.selectedId;
  useEffect(() => {
    if (selectedId === null) return undefined;
    const frame =
      hasSelectMark(selectedId) && typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => markPaint(selectedId))
        : null;
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      clearSelect(selectedId);
    };
  }, [selectedId]);

  const move = (delta: number) => {
    const rowsNow = shownRef.current;
    if (rowsNow.length === 0) return;
    const current = viewRef.current;
    const at =
      current.selectedId === null ? undefined : positionsRef.current.get(current.selectedId);
    const target = Math.min(Math.max(at === undefined ? 0 : at + delta, 0), rowsNow.length - 1);
    const row = rowsNow[target];
    if (row === undefined || row.id === current.selectedId) return;
    const next = {
      selectedId: row.id,
      scrollTop: scrollToShow(target, current.scrollTop, viewportRef.current),
    };
    viewRef.current = next;
    setView(next);
    markSelect(row.id);
  };

  const selectedNow = (): SessionRow | null => {
    const id = viewRef.current.selectedId;
    const at = id === null ? undefined : positionsRef.current.get(id);
    return at === undefined ? null : (shownRef.current[at] ?? null);
  };

  const resume = (row: SessionRow) => {
    api.resume(row.id).then(
      (launch) =>
        controller.notify({
          tone: 'info',
          text: launch.launched
            ? `Opened in ${launch.via === 'iterm2' ? 'iTerm2' : 'the terminal'}`
            : `Dry run: ${launch.command}`,
          undo: false,
          detail: null,
        }),
      (error: unknown) =>
        controller.notify({
          tone: 'error',
          text: `Resume failed: ${toCircusError(error).message}`,
          undo: false,
          detail: null,
        }),
    );
  };

  const back = () => {
    const input = searchRef.current;
    if (input !== null && document.activeElement === input) {
      setQuery('');
      input.blur();
      listRef.current?.focus();
      return;
    }
    if (query !== '') setQuery('');
    else if (projectKey !== null) setProjectKey(null);
  };

  const onAction = (action: InboxListAction) => {
    switch (action) {
      case 'next':
        move(1);
        return;
      case 'previous':
        move(-1);
        return;
      case 'undo': {
        const undone = controller.undo();
        if (undone !== null && inCurrentView(undone.row)) onSelect(undone.row.id);
        return;
      }
      case 'search':
        searchRef.current?.focus();
        return;
      case 'back':
        back();
        return;
      case 'nextSplit':
        changeSplit(nextSplit(split, 1));
        return;
      case 'previousSplit':
        changeSplit(nextSplit(split, -1));
        return;
      case 'rescan':
        controller.rescan();
        return;
      default:
        break;
    }
    const row = selectedNow();
    if (row === null) return;
    if (action === 'resume') {
      resume(row);
      return;
    }
    if (action === 'snooze') {
      if (controller.decisionsBlocked === null) setSnoozeTarget(row);
      else controller.decide('snooze', row);
      return;
    }
    const decision = DECISION_FOR[action];
    if (decision !== undefined) controller.decide(decision, row);
  };

  useShortcutContext(
    inboxListContext,
    onAction,
    visible && snoozeTarget === null && !controller.closing,
  );

  const loadError = controller.loadError;
  const fatal =
    loadError !== null && (loadError.kind === 'rl_not_found' || loadError.kind === 'rl_too_old');

  if (fatal && list === null) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-xl text-center text-sm whitespace-pre-wrap">{loadError.message}</p>
      </div>
    );
  }

  const envLabel = controller.info?.environment_label ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <SplitTabs split={split} counts={counts} onSplit={changeSplit} />
        <SearchBox query={query} onQuery={setQuery} onDone={onSearchDone} inputRef={searchRef} />
        {controller.listStale && (
          <span className="rounded-full bg-neutral-500/15 px-2 py-0.5 text-xs">
            Cached · refreshing…
          </span>
        )}
        <span className="flex-1" />
        {envLabel !== null && (
          <span className="rounded bg-amber-500 px-2 py-0.5 text-xs font-bold tracking-wide text-black">
            {envLabel.toUpperCase()}
          </span>
        )}
      </div>
      <Banners
        decisionsBlocked={controller.decisionsBlocked}
        list={list}
        roundupDismissed={roundupDismissed}
        onDismissRoundup={onDismissRoundup}
        loadErrorMessage={fatal ? loadError.message : null}
      />
      {loadError !== null && !fatal && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-red-300 bg-red-50 px-3 py-2 text-sm dark:border-red-800 dark:bg-red-950"
        >
          <p className="flex-1">Couldn’t load sessions: {loadError.message}</p>
          <button
            type="button"
            onClick={() => controller.refresh()}
            className="rounded border px-2 py-0.5"
          >
            Retry
          </button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.1fr)]">
        <ProjectSidebar
          projects={projects}
          total={inSplit.length}
          projectKey={projectKey}
          onProject={onProject}
        />
        <div className="min-h-0 border-x border-neutral-200 dark:border-neutral-800">
          {list === null ? (
            <p className="p-6 text-center text-sm opacity-60">
              {loadError === null ? 'Loading sessions…' : ''}
            </p>
          ) : (
            <SessionList
              rows={shown}
              selectedId={view.selectedId}
              scrollTop={view.scrollTop}
              viewport={viewport}
              onScroll={onScroll}
              onResize={onResize}
              onSelect={onSelect}
              listRef={listRef}
              empty={emptyText(split, list.recent_days, query, projectKey !== null)}
            />
          )}
        </div>
        <ReadingPane row={selectedRow} conversation={conversation} />
      </div>
      <StatusBar entries={controller.entries} scanning={controller.scanning} />
      {snoozeTarget !== null && (
        <SnoozeDialog
          sessionLabel={snoozeTarget.label}
          now={currentTime}
          onConfirm={(at) => {
            setSnoozeTarget(null);
            controller.decide('snooze', snoozeTarget, at.toISOString());
          }}
          onClose={() => setSnoozeTarget(null)}
        />
      )}
    </div>
  );
}
