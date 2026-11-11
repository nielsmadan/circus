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
import { useRegistrySnapshot, useShortcutContext } from '@shortcutkit/react';
import { SnoozeDialog } from '../snooze/SnoozeDialog';
import { Banners } from './Banners';
import { Conversation } from './Conversation';
import {
  indexRows,
  narrowRows,
  nextSelection,
  positions,
  projectCounts,
  splitCounts,
  splitRows,
  filterByProject,
  SPLITS,
  type ProjectCount,
  type Split,
} from './derive';
import { InFlight, WakingSoon } from './HomeLists';
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
import { ProjectSidebar } from './ProjectSidebar';
import { ReadingPane } from './ReadingPane';
import { effectiveViewport, ROW_HEIGHT, scrollToShow } from './rowWindow';
import { SearchBox } from './SearchBox';
import { SessionList } from './SessionList';
import { SplitTabs } from './SplitTabs';
import { StatusBar } from './StatusBar';
import type { InboxController } from './useInbox';
import { useMarks } from './useMarks';
import { usePresenceInstall } from './usePresenceInstall';
import { useTails } from './useTails';
import { actionTargets, triageChoice } from './targets';
import { useTriageHandoff } from './useTriageHandoff';

export interface InboxViewProps {
  readonly controller: InboxController;
  readonly api: CircusApi;
  readonly visible: boolean;
  readonly onOpenHarvests: () => void;
}

interface View {
  readonly selectedId: string | null;
  readonly scrollTop: number;
}

interface PendingConfirm {
  readonly action: ConfirmedAction;
  readonly rows: readonly SessionRow[];
}

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);
const INITIAL_VIEW: View = Object.freeze({ selectedId: null, scrollTop: 0 });
const currentTime = () => new Date();

const DECISION_FOR: Readonly<Partial<Record<InboxListAction, DecisionAction>>> = {
  harvestArchive: 'harvest',
  archive: 'archive',
  delete: 'delete',
  snooze: 'snooze',
  keep: 'keep',
  keepGoing: 'keep_going',
};

function emptyText(
  split: Split,
  recentDays: number,
  query: string,
  projectFiltered: boolean,
  following: ProjectCount | null,
): string {
  if (query.trim() !== '') return `No sessions match “${query}”`;
  if (projectFiltered) {
    return following === null
      ? 'This project is done — all caught up. Esc shows all projects'
      : `This project is done. Next: ${following.label} (${following.pending} waiting) — Enter`;
  }
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

function rowsById(list: InboxController['list']): ReadonlyMap<string, SessionRow> {
  const all = [...(list?.sessions ?? NO_ROWS), ...(list?.home?.rows ?? NO_ROWS)];
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
  const [split, setSplit] = useState<Split>('recent');
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(INITIAL_VIEW);
  const [viewport, setViewport] = useState(0);
  const [snoozeTargets, setSnoozeTargets] = useState<readonly SessionRow[] | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  const { list, rows, notify, rescan } = controller;
  const index = useMemo(() => indexRows(list?.sessions ?? NO_ROWS), [list]);
  const inSplit = useMemo(() => splitRows(rows, split, index), [rows, split, index]);
  const shown = useMemo(
    () => narrowRows(inSplit, projectKey, query, index),
    [inSplit, projectKey, query, index],
  );
  const shownPositions = useMemo(() => positions(shown), [shown]);
  const marks = useMarks(shown, shownPositions);
  const { markedRows } = marks;
  const counts = useMemo(() => splitCounts(filterByProject(rows, projectKey)), [rows, projectKey]);
  const projects = useMemo(() => projectCounts(inSplit, index), [inSplit, index]);
  const following = useMemo(
    () => (shown.length === 0 ? (projects.find((p) => p.key !== projectKey) ?? null) : null),
    [shown, projects, projectKey],
  );
  const byId = useMemo(() => rowsById(list), [list]);
  const home = list?.home ?? null;
  const inFlight = useMemo(() => pick(home?.in_flight ?? [], byId), [home, byId]);
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
  const clearMarks = marks.clear;
  const changeSplit = useCallback(
    (next: Split) => {
      if (next === split) return;
      setSplit(next);
      setView(INITIAL_VIEW);
      clearMarks();
      setProjectKey((key) =>
        key !== null && filterByProject(splitRows(rows, next, index), key).length === 0
          ? null
          : key,
      );
    },
    [split, rows, index, clearMarks],
  );
  const inCurrentView = (row: SessionRow): boolean =>
    narrowRows(splitRows([row], split, index), projectKey, query, index).length > 0;
  const onProject = useCallback((key: string | null) => setProjectKey(key), []);
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
      (launch) => notify(launchedToast(launch, quote(row.label))),
      (error: unknown) => notify(resumeFailedToast(row.label, errorDetail(toCircusError(error)))),
    );
  };

  const resumeRef = useRef(resume);
  useLayoutEffect(() => {
    resumeRef.current = resume;
  });
  const onResumeRow = useCallback((row: SessionRow) => resumeRef.current(row), []);

  const goToProject = (key: string) => {
    changeSplit('all');
    setProjectKey(key);
    setView(INITIAL_VIEW);
  };

  const onStep = (step: NextStep) => {
    switch (step.kind) {
      case 'woke':
      case 'recent':
        setProjectKey(null);
        changeSplit(step.kind);
        return;
      case 'project':
        goToProject(step.project_key);
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
  };
  const onStepRef = useRef(onStep);
  useLayoutEffect(() => {
    onStepRef.current = onStep;
  });
  const onStepStable = useCallback((step: NextStep) => onStepRef.current(step), []);

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

  const unlessBlocked = (open: () => void) => {
    const blocked = controller.decisionsBlocked;
    if (blocked === null) open();
    else notify(blockedToast(blocked));
  };

  const decideOn = (decision: DecisionAction, targets: readonly SessionRow[]) => {
    if (decision === 'snooze') {
      unlessBlocked(() => setSnoozeTargets(targets));
      return;
    }
    if (targets.length > 1 && isConfirmedAction(decision)) {
      unlessBlocked(() => setPendingConfirm({ action: decision, rows: targets }));
      return;
    }
    if (controller.decideMany(decision, targets)) marks.clear();
  };

  const resumeTargets = (targets: readonly SessionRow[]) => {
    const [only, ...others] = targets;
    if (only === undefined) {
      if (following !== null && projectKey !== null) goToProject(following.key);
      return;
    }
    if (others.length > 0) notify(oneResumeToast());
    else resume(only);
  };

  const triageTargets = (targets: readonly SessionRow[]) => {
    const label =
      projectKey === null ? null : (projects.find((p) => p.key === projectKey)?.label ?? null);
    const choice = triageChoice(projectKey, label, targets);
    if (choice.kind === 'several') notify(oneProjectToast());
    else if (choice.kind === 'target') handoff.triage(choice.target);
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
        changeSplit(nextSplit(split, 1));
        return;
      case 'previousSplit':
        changeSplit(nextSplit(split, -1));
        return;
      case 'rescan':
        controller.rescan();
        return;
      case 'markAll':
        marks.toggleAll(shownRef.current);
        return;
      case 'mark': {
        const row = selectedNow();
        if (row !== null) marks.toggle(row.id);
        return;
      }
      default:
        break;
    }
    const targets = actionTargets(markedRows, selectedNow());
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
        <SplitTabs split={split} counts={counts} onSplit={changeSplit} />
        <SearchBox query={query} onQuery={setQuery} onDone={onSearchDone} inputRef={searchRef} />
        {markedRows.length > 0 && (
          <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs">
            {markedRows.length} marked
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
      {stepContext !== null && <NextSteps context={stepContext} onStep={onStepStable} />}
      <div className="grid min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="h-full min-h-0 overflow-y-auto p-2">
          <ProjectSidebar
            projects={projects}
            total={inSplit.length}
            projectKey={projectKey}
            onProject={onProject}
          />
          <InFlight rows={inFlight} onResume={onResumeRow} />
          <WakingSoon rows={wakingSoon} now={list?.generated_at ?? ''} />
        </div>
        <div className="min-h-0 border-x border-neutral-200 dark:border-neutral-800">
          {list === null ? (
            <p className="p-6 text-center text-sm opacity-60">
              {loadError === null ? 'Loading sessions…' : ''}
            </p>
          ) : (
            <SessionList
              rows={shown}
              selectedId={view.selectedId}
              marks={marks.marks}
              scrollTop={view.scrollTop}
              viewport={viewport}
              onScroll={onScroll}
              onResize={onResize}
              onSelect={onSelect}
              listRef={listRef}
              empty={emptyText(split, list.recent_days, query, projectKey !== null, following)}
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
