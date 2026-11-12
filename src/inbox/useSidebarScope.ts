import { useCallback, useState } from 'react';
import { readStored, writeStored } from '../storage';
import { SIDEBAR_VIEWS, viewFor, type Scope, type SidebarView } from './scope';

const VIEW_KEY = 'circus.sidebar.view';

type Selections = Readonly<Record<SidebarView, Scope | null>>;

const NO_SELECTIONS: Selections = Object.freeze(
  Object.fromEntries(SIDEBAR_VIEWS.map((view) => [view, null])) as Record<SidebarView, null>,
);

const NO_CHOICES: ReadonlyMap<string, boolean> = new Map();

export function parseView(raw: string | null): SidebarView {
  return SIDEBAR_VIEWS.find((view) => view === raw) ?? 'repos';
}

export function withChoice(
  choices: ReadonlyMap<string, boolean>,
  path: string,
  open: boolean,
): ReadonlyMap<string, boolean> {
  return new Map(choices).set(path, open);
}

export interface SidebarScope {
  readonly view: SidebarView;
  readonly selected: Scope | null;
  readonly treeChoices: ReadonlyMap<string, boolean>;
  showView(view: SidebarView): void;
  select(scope: Scope): void;
  clear(): void;
  updateAll(change: (scope: Scope | null) => Scope | null): void;
  setTreeOpen(path: string, open: boolean): void;
}

export function useSidebarScope(): SidebarScope {
  const [view, setView] = useState(() => parseView(readStored(VIEW_KEY)));
  const [selections, setSelections] = useState<Selections>(NO_SELECTIONS);
  const [treeChoices, setTreeChoices] = useState(NO_CHOICES);

  const showView = useCallback((next: SidebarView) => {
    setView(next);
    writeStored(VIEW_KEY, next);
  }, []);
  const select = useCallback(
    (scope: Scope) => {
      const owner = viewFor(scope);
      showView(owner);
      setSelections((current) =>
        current[owner] === scope ? current : { ...current, [owner]: scope },
      );
    },
    [showView],
  );
  const clear = useCallback(
    () =>
      setSelections((current) => (current[view] === null ? current : { ...current, [view]: null })),
    [view],
  );
  const updateAll = useCallback(
    (change: (scope: Scope | null) => Scope | null) =>
      setSelections((current) => {
        const next = Object.fromEntries(
          SIDEBAR_VIEWS.map((each) => [each, change(current[each])]),
        ) as Selections;
        return SIDEBAR_VIEWS.every((each) => next[each] === current[each]) ? current : next;
      }),
    [],
  );
  const setTreeOpen = useCallback(
    (path: string, open: boolean) => setTreeChoices((current) => withChoice(current, path, open)),
    [],
  );

  return {
    view,
    selected: selections[view],
    treeChoices,
    showView,
    select,
    clear,
    updateAll,
    setTreeOpen,
  };
}
