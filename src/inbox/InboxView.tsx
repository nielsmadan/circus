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
import { toCircusError, type DecisionAction, type NextStep, type SessionRow } from '../api/types';
import { AgentPicker } from './AgentPicker';
import { ConfirmDialog } from './ConfirmDialog';
import { inboxListContext, isModalOpen, type InboxListAction } from '../shortcuts/contexts';
import { isEditingText } from '@shortcutkit/dom';
import { useRegistrySnapshot, useShortcutContext } from '@shortcutkit/react';
import { SnoozeDialog } from '../snooze/SnoozeDialog';
import { Banners } from './Banners';
import { Conversation } from './Conversation';
import {
  acceptsAny,
  availableSplits,
  DECISION_FOR,
  indexRows,
  listedRows,
  narrowRows,
  nextSelection,
  parseMtime,
  positions,
  projectCounts,
  splitCounts,
  splitRows,
  filterByScope,
  mtimeOf,
  sourcesOf,
  type Split,
  type SplitSources,
} from './derive';
import { WakingSoon } from './HomeLists';
import {
  blockedToast,
  bulkConfirmText,
  errorDetail,
  isConfirmedAction,
  launchedToast,
  oneProjectToast,
  oneResumeToast,
  quote,
  resumeFailedToast,
  sessions,
  type ConfirmedAction,
} from './messages';
import { NextSteps, type StepContext } from './NextSteps';
import { clearSelect, hasSelectMark, markPaint, markSelect } from './perfMarks';
import { ReadingPane } from './ReadingPane';
import { effectiveViewport, ROW_HEIGHT, scrollToShow } from './rowWindow';
import { SearchBox } from './SearchBox';
import { SessionList, type RowGesture } from './SessionList';
import { SplitTabs } from './SplitTabs';
import { StatusBar } from './StatusBar';
import type { InboxController } from './useInbox';
import { useMarks } from './useMarks';
import { targetRows, type Cursor, type ShownRows } from './marks';
import { useStableCallback } from './useStableCallback';
import { usePresenceInstall } from './usePresenceInstall';
import { useTails } from './useTails';
import { scopeProject, triageChoice } from './targets';
import { useTriageHandoff } from './useTriageHandoff';
import { inScope, scopeKey, scopeNoun, sameScope, type Scope, type SidebarView } from './scope';
import { Sidebar } from './Sidebar';
import { resolvePeriod, type SidebarEntry } from './sidebarGroups';
import { sidebarColumns } from './sidebarWidth';
import { Splitter } from './Splitter';
import { useSidebarContent } from './useSidebarContent';
import { useSidebarScope } from './useSidebarScope';
import { useSidebarWidth } from './useSidebarWidth';

export interface InboxViewProps {
  readonly controller: InboxController;
  readonly api: CircusApi;
  readonly visible: boolean;
  readonly onOpenHarvests: () => void;
}

interface View {
  readonly selectedId: string | null;
  readonly scrollTop: number;
  readonly anchored: boolean;
}

type Motion = 'move' | 'extend';

interface PendingConfirm {
  readonly action: ConfirmedAction;
  readonly rows: readonly SessionRow[];
}

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);
const SIDEBAR_ACTION_VIEWS = {
  sidebarRepos: 'repos',
  sidebarFolders: 'folders',
  sidebarTree: 'tree',
  sidebarDates: 'dates',
} as const satisfies Partial<Record<InboxListAction, SidebarView>>;
const INITIAL_VIEW: View = Object.freeze({ selectedId: null, scrollTop: 0, anchored: false });
const currentTime = () => new Date();

function emptyText(
  split: Split,
  recentDays: number,
  query: string,
  scope: Scope | null,
  following: SidebarEntry | null,
  remaining: number,
): string {
  if (query.trim() !== '') return `No sessions match “${query}”`;
  if (scope !== null) {
    const noun = scopeNoun(scope);
    if (following !== null) {
      const waiting = split === 'kept' ? 'kept' : 'waiting';
      return `This ${noun} is done. Next: ${following.scope.label} (${following.count} ${waiting}) — Enter`;
    }
    return remaining > 0
      ? `This ${noun} is done. Esc shows all ${noun}s`
      : `This ${noun} is done — all caught up. Esc shows all ${noun}s`;
  }
  switch (split) {
    case 'recent':
      return `Nothing from the last ${recentDays} days is waiting`;
    case 'woke':
      return 'No snoozed sessions have woken up';
    case 'all':
      return 'Inbox zero';
    case 'kept':
      return 'No kept sessions';
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
  if (selectedId === view.selectedId && scrollTop === view.scrollTop) return view;
  return { selectedId, scrollTop, anchored: view.anchored && selectedId === view.selectedId };
}

function nextSplit(split: Split, delta: number, splits: readonly Split[]): Split {
  const at = splits.indexOf(split);
  return splits[(at + delta + splits.length) % splits.length] ?? split;
}

function rowsById(list: InboxController['list']): ReadonlyMap<string, SessionRow> {
  const all = [...listedRows(list), ...(list?.home?.rows ?? NO_ROWS)];
  return new Map(all.map((row) => [row.id, row]));
}

function pick(ids: readonly string[], byId: ReadonlyMap<string, SessionRow>): SessionRow[] {
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
}

export function InboxView({
  controller,
  api,
  visible,
  onOpenHarvests,
}: InboxViewProps): ReactElement {
  const [chosenSplit, setChosenSplit] = useState<Split>('recent');
  const sidebar = useSidebarScope();
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [viewport, setViewport] = useState(0);
  const [snoozeTargets, setSnoozeTargets] = useState<readonly SessionRow[] | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const { list, rows, keptRows, notify, rescan } = controller;
  const splits = availableSplits(list);
  const split = splits.includes(chosenSplit) ? chosenSplit : 'recent';
  const listed = useMemo(() => listedRows(list), [list]);
  const index = useMemo(() => indexRows(listed), [listed]);
  const sources = useMemo(
    (): SplitSources => ({ sessions: rows, kept: keptRows }),
    [rows, keptRows],
  );
  const inSplit = useMemo(() => splitRows(sources, split, index), [sources, split, index]);
  const homeDir = controller.info?.home_dir ?? null;
  const projects = useMemo(() => projectCounts(inSplit, index), [inSplit, index]);
  const generatedAt = list?.generated_at ?? null;
  const nowMs = useMemo(
    () => (generatedAt === null ? null : parseMtime(generatedAt)),
    [generatedAt],
  );
  const { content, scope } = useSidebarContent(
    sidebar.view,
    { projects, rows: inSplit, index, home: homeDir, nowMs },
    sidebar.selected,
  );
  const shown = useMemo(
    () => narrowRows(inSplit, scope, query, index),
    [inSplit, scope, query, index],
  );
  const shownPositions = useMemo(() => positions(shown), [shown]);
  const shownRows = useMemo(
    (): ShownRows => ({ rows: shown, positions: shownPositions }),
    [shown, shownPositions],
  );
  const marks = useMarks(shownRows, `${split}|${scopeKey(scope)}`);
  const { markedRows } = marks;
  const counts = useMemo(
    () =>
      splitCounts({
        sessions: filterByScope(rows, scope, index),
        kept: filterByScope(keptRows, scope, index),
      }),
    [rows, keptRows, scope, index],
  );
  const following = useMemo(
    () =>
      shown.length === 0 && content.kind === 'list'
        ? (content.entries.find((entry) => !sameScope(entry.scope, scope)) ?? null)
        : null,
    [shown, content, scope],
  );
  const { select: selectScope, clear: clearScope } = sidebar;
  const onSidebarScope = useCallback(
    (next: Scope | null) => (next === null ? clearScope() : selectScope(next)),
    [selectScope, clearScope],
  );
  const byId = useMemo(() => rowsById(list), [list]);
  const home = list?.home ?? null;
  const wakingSoon = useMemo(() => pick(home?.waking_soon ?? [], byId), [home, byId]);
  const allProjects = useMemo(
    () => new Map(projectCounts(rows, index).map((project) => [project.key, project])),
    [rows, index],
  );
  const stepContext = useMemo(
    (): StepContext | null =>
      list === null || home === null
        ? null
        : {
            home,
            roundup: list.roundup,
            recentDays: list.recent_days,
            now: list.generated_at,
            rowFor: (id) => byId.get(id) ?? null,
            projectFor: (key) => allProjects.get(key) ?? null,
          },
    [list, home, byId, allProjects],
  );
  const installedAgents = useMemo(
    () => (list?.agents ?? []).filter((agent) => agent.installed),
    [list],
  );
  const presence = usePresenceInstall(api, notify, rescan);
  const handoff = useTriageHandoff(api, notify, installedAgents);
  const modalOpen = isModalOpen(useRegistrySnapshot());

  const [prevShown, setPrevShown] = useState<readonly SessionRow[]>(NO_ROWS);
  if (shown !== prevShown) {
    setPrevShown(shown);
    setView((current) => reconcileView(current, prevShown, shown, viewport));
  }

  const selectedIndex = view.selectedId === null ? undefined : shownPositions.get(view.selectedId);
  const selectedRow = selectedIndex === undefined ? null : (shown[selectedIndex] ?? null);
  const { selectedId: cursorId, anchored } = view;
  const chosen = useMemo(
    () => targetRows(markedRows, marks.state, { id: cursorId, anchored }, selectedRow),
    [markedRows, marks.state, cursorId, anchored, selectedRow],
  );
  const chosenIds = useMemo(() => new Set(chosen.map((row) => row.id)), [chosen]);
  const tail = useTails(api, shown, shownPositions, selectedRow, list === null ? null : listed);
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
      setView((current) =>
        current.selectedId === id ? current : { ...current, selectedId: id, anchored: false },
      ),
    [],
  );
  const placeCursor = (id: string) =>
    setView((current) =>
      current.selectedId === id && current.anchored
        ? current
        : { ...current, selectedId: id, anchored: true },
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
  const updateScopes = sidebar.updateAll;
  const changeSplit = useCallback(
    (next: Split) => {
      if (next === split) return;
      setChosenSplit(next);
      setView(INITIAL_VIEW);
      const nextRows = splitRows(sources, next, index);
      updateScopes((current) => {
        const live = current === null ? null : resolvePeriod(current, nowMs);
        return live !== null && nextRows.some((row) => inScope(row, live, mtimeOf(row, index)))
          ? current
          : null;
      });
    },
    [split, sources, index, nowMs, updateScopes],
  );
  const inCurrentView = (row: SessionRow): boolean =>
    narrowRows(splitRows(sourcesOf(row), split, index), scope, query, index).length > 0;
  const onPreviewWidth = useCallback((width: number) => {
    gridRef.current?.style.setProperty('grid-template-columns', sidebarColumns(width));
  }, []);
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

  const moveTo = (pick: (at: number | undefined, count: number) => number, motion: Motion) => {
    const rowsNow = shownRef.current;
    if (rowsNow.length === 0) return;
    const current = viewRef.current;
    const at =
      current.selectedId === null ? undefined : positionsRef.current.get(current.selectedId);
    const target = Math.min(Math.max(pick(at, rowsNow.length), 0), rowsNow.length - 1);
    const row = rowsNow[target];
    if (row === undefined || row.id === current.selectedId) return;
    if (motion === 'extend') {
      marks.extendTo(row.id, { id: current.selectedId, anchored: current.anchored });
    }
    const next = {
      selectedId: row.id,
      scrollTop: scrollToShow(target, current.scrollTop, viewportRef.current),
      anchored: motion === 'extend',
    };
    viewRef.current = next;
    setView(next);
    markSelect(row.id);
  };
  const move = (delta: number, motion: Motion) =>
    moveTo((at) => (at === undefined ? 0 : at + delta), motion);
  const moveToEdge = (edge: 'first' | 'last', motion: Motion) =>
    moveTo((_, count) => (edge === 'first' ? 0 : count - 1), motion);

  const shownRow = (id: string | null): SessionRow | null => {
    const at = id === null ? undefined : positionsRef.current.get(id);
    return at === undefined ? null : (shownRef.current[at] ?? null);
  };
  const cursorNow = (): Cursor => ({
    id: viewRef.current.selectedId,
    anchored: viewRef.current.anchored,
  });
  const selectedNow = (): SessionRow | null => shownRow(viewRef.current.selectedId);
  const targetsNow = (): readonly SessionRow[] =>
    targetRows(markedRows, marks.state, cursorNow(), selectedNow());

  const resume = (row: SessionRow) => {
    api.resume(row.id).then(
      (launch) => notify(launchedToast(launch, quote(row.label))),
      (error: unknown) => notify(resumeFailedToast(row.label, errorDetail(toCircusError(error)))),
    );
  };

  const onPointer = useStableCallback((id: string, gesture: RowGesture) => {
    if (gesture === 'open') {
      const row = shownRow(id);
      if (row !== null) resume(row);
      return;
    }
    const cursor = cursorNow();
    if (gesture === 'only') marks.selectOnly(id);
    else if (gesture === 'toggle') marks.toggleRow(id, cursor);
    else marks.extendTo(id, cursor);
    placeCursor(id);
  });

  const goTo = (target: Scope, within: Split) => {
    changeSplit(within);
    sidebar.select(target);
    setView(INITIAL_VIEW);
  };

  const onStep = useStableCallback((step: NextStep) => {
    switch (step.kind) {
      case 'woke':
      case 'recent':
        sidebar.clear();
        changeSplit(step.kind);
        return;
      case 'project':
        goTo(
          {
            kind: 'repo',
            key: step.project_key,
            label: allProjects.get(step.project_key)?.label ?? step.project_key,
          },
          'all',
        );
        return;
      case 'publish':
        onOpenHarvests();
        return;
      case 'resume': {
        const row = byId.get(step.id);
        if (row !== undefined) resume(row);
        return;
      }
      case 'roundup':
        return;
    }
  });

  const back = () => {
    const input = searchRef.current;
    if (input !== null && document.activeElement === input) {
      setQuery('');
      input.blur();
      listRef.current?.focus();
      return;
    }
    if (markedRows.length > 0) marks.clear();
    else if (query !== '') setQuery('');
    else if (scope !== null) sidebar.clear();
  };

  const unlessBlocked = (open: () => void) => {
    const blocked = controller.decisionsBlocked;
    if (blocked === null) open();
    else notify(blockedToast(blocked));
  };

  const decideOn = (decision: DecisionAction, targets: readonly SessionRow[]) => {
    if (!acceptsAny(decision, targets)) {
      controller.decideMany(decision, targets);
      return;
    }
    if (decision === 'snooze') {
      unlessBlocked(() => setSnoozeTargets(targets));
      return;
    }
    const offCursor = targets.some((row) => row.id !== viewRef.current.selectedId);
    const refused = decision === 'harvest' && targets.length > 1;
    if (offCursor && !refused && isConfirmedAction(decision)) {
      unlessBlocked(() => setPendingConfirm({ action: decision, rows: targets }));
      return;
    }
    if (controller.decideMany(decision, targets)) marks.clear();
  };

  const resumeTargets = (targets: readonly SessionRow[]) => {
    const [only, ...others] = targets;
    if (only === undefined) {
      if (following !== null && scope !== null) {
        goTo(following.scope, split === 'kept' ? 'kept' : 'all');
      }
      return;
    }
    if (others.length > 0) notify(oneResumeToast());
    else resume(only);
  };

  const triageTargets = (targets: readonly SessionRow[]) => {
    const choice = triageChoice(scopeProject(scope, filterByScope(inSplit, scope, index)), targets);
    if (choice.kind === 'several') notify(oneProjectToast());
    else if (choice.kind === 'target') handoff.triage(choice.target);
  };

  const onAction = (action: InboxListAction) => {
    switch (action) {
      case 'next':
        move(1, 'move');
        return;
      case 'previous':
        move(-1, 'move');
        return;
      case 'extendDown':
        move(1, 'extend');
        return;
      case 'extendUp':
        move(-1, 'extend');
        return;
      case 'first':
      case 'last':
        moveToEdge(action, 'move');
        return;
      case 'extendToFirst':
        moveToEdge('first', 'extend');
        return;
      case 'extendToLast':
        moveToEdge('last', 'extend');
        return;
      case 'selectAll': {
        const focused = document.activeElement;
        if (!isEditingText(focused)) marks.selectAll();
        else if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
          focused.select();
        }
        return;
      }
      case 'undo': {
        const newest = controller.undo().at(-1);
        if (newest !== undefined && inCurrentView(newest.row)) onSelect(newest.row.id);
        return;
      }
      case 'search':
        searchRef.current?.focus();
        return;
      case 'back':
        back();
        return;
      case 'nextSplit':
        changeSplit(nextSplit(split, 1, splits));
        return;
      case 'previousSplit':
        changeSplit(nextSplit(split, -1, splits));
        return;
      case 'rescan':
        controller.rescan();
        return;
      case 'sidebarRepos':
      case 'sidebarFolders':
      case 'sidebarTree':
      case 'sidebarDates':
        sidebar.showView(SIDEBAR_ACTION_VIEWS[action]);
        return;
      case 'toggleAll':
        marks.toggleAll();
        return;
      case 'toggleCurrent': {
        const row = selectedNow();
        if (row !== null) marks.toggleMark(row.id);
        return;
      }
      default:
        break;
    }
    const targets = targetsNow();
    if (action === 'triageWithAgent') {
      triageTargets(targets);
      return;
    }
    if (action === 'resume') {
      resumeTargets(targets);
      return;
    }
    const decision = DECISION_FOR[action];
    if (decision !== undefined && targets.length > 0) decideOn(decision, targets);
  };

  useShortcutContext(inboxListContext, onAction, {
    enabled: visible && !modalOpen && !controller.closing,
  });

  const loadError = controller.loadError;
  const envLabel = controller.info?.environment_label ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <SplitTabs split={split} splits={splits} counts={counts} onSplit={changeSplit} />
        <SearchBox query={query} onQuery={setQuery} onDone={onSearchDone} inputRef={searchRef} />
        {markedRows.length > 0 && (
          <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs">
            {markedRows.length} selected
          </span>
        )}
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
        installingPresence={presence.installing}
        onInstallPresence={presence.install}
        loadError={loadError === null ? null : loadError.message}
        onRetry={controller.refresh}
      />
      {stepContext !== null && <NextSteps context={stepContext} onStep={onStep} />}
      <div
        ref={gridRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateColumns: sidebarColumns(sidebarWidth) }}
      >
        <div className="relative min-h-0">
          <div className="h-full min-h-0 overflow-y-auto p-2">
            <Sidebar
              view={sidebar.view}
              onView={sidebar.showView}
              total={inSplit.length}
              scope={scope}
              onScope={onSidebarScope}
              content={content}
              treeChoices={sidebar.treeChoices}
              onTreeOpen={sidebar.setTreeOpen}
            />
            <WakingSoon rows={wakingSoon} now={list?.generated_at ?? ''} />
          </div>
          <Splitter width={sidebarWidth} onPreview={onPreviewWidth} onCommit={setSidebarWidth} />
        </div>
        <div className="min-h-0 border-x border-neutral-200 dark:border-neutral-800">
          {list === null ? (
            <p className="p-6 text-center text-sm opacity-60">
              {loadError === null ? 'Loading sessions…' : ''}
            </p>
          ) : (
            <SessionList
              rows={shown}
              cursorId={view.selectedId}
              selection={chosenIds}
              scrollTop={view.scrollTop}
              viewport={viewport}
              onScroll={onScroll}
              onResize={onResize}
              onPointer={onPointer}
              listRef={listRef}
              empty={emptyText(split, list.recent_days, query, scope, following, inSplit.length)}
            />
          )}
        </div>
        <ReadingPane row={selectedRow} conversation={conversation} />
      </div>
      <StatusBar entries={controller.entries} scanning={controller.scanning} />
      {handoff.choice !== null && (
        <AgentPicker
          projectLabel={handoff.choice.target.label}
          agents={installedAgents}
          preferred={handoff.choice.preferred}
          onPick={handoff.pick}
          onClose={handoff.closePicker}
        />
      )}
      {pendingConfirm !== null && (
        <ConfirmDialog
          {...bulkConfirmText(pendingConfirm.action, pendingConfirm.rows.length)}
          onConfirm={() => {
            setPendingConfirm(null);
            if (controller.decideMany(pendingConfirm.action, pendingConfirm.rows)) marks.clear();
          }}
          onClose={() => setPendingConfirm(null)}
        />
      )}
      {snoozeTargets !== null && (
        <SnoozeDialog
          sessionLabel={
            snoozeTargets.length === 1
              ? (snoozeTargets[0]?.label ?? '')
              : sessions(snoozeTargets.length)
          }
          now={currentTime}
          onConfirm={(at) => {
            setSnoozeTargets(null);
            if (controller.decideMany('snooze', snoozeTargets, at.toISOString())) marks.clear();
          }}
          onClose={() => setSnoozeTargets(null)}
        />
      )}
    </div>
  );
}
