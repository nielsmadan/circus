import { memo, type ReactElement } from 'react';
import { Entry } from './Entry';
import { FolderTree } from './FolderTree';
import { KeepFocusButton } from './KeepFocusButton';
import { SIDEBAR_VIEWS, sameScope, type Scope, type SidebarView } from './scope';
import type { SidebarContent } from './sidebarGroups';

const VIEW_TEXT: Readonly<
  Record<SidebarView, { readonly tab: string; readonly nav: string; readonly all: string }>
> = {
  repos: { tab: 'Repos', nav: 'Repos', all: 'All repos' },
  folders: { tab: 'Folders', nav: 'Folders', all: 'All folders' },
  tree: { tab: 'Tree', nav: 'Folder tree', all: 'All folders' },
  dates: { tab: 'Dates', nav: 'Dates', all: 'All dates' },
};

export interface SidebarProps {
  readonly view: SidebarView;
  readonly onView: (view: SidebarView) => void;
  readonly total: number;
  readonly scope: Scope | null;
  readonly onScope: (scope: Scope | null) => void;
  readonly content: SidebarContent;
  readonly treeChoices: ReadonlyMap<string, boolean>;
  readonly onTreeOpen: (path: string, open: boolean) => void;
}

export const Sidebar = memo(function Sidebar({
  view,
  onView,
  total,
  scope,
  onScope,
  content,
  treeChoices,
  onTreeOpen,
}: SidebarProps): ReactElement {
  return (
    <div className="flex flex-col">
      <div className="sticky -top-2 z-[1] -mx-2 -mt-2 bg-white px-2 pt-2 pb-2 dark:bg-neutral-950">
        <div
          role="tablist"
          aria-label="Group sessions by"
          className="flex gap-px rounded bg-neutral-100 p-0.5 dark:bg-neutral-900"
        >
          {SIDEBAR_VIEWS.map((candidate) => (
            <KeepFocusButton
              key={candidate}
              role="tab"
              aria-selected={candidate === view}
              onClick={() => onView(candidate)}
              className="flex-1 rounded px-1 py-0.5 text-xs aria-selected:bg-white aria-selected:font-medium aria-selected:shadow-sm dark:aria-selected:bg-neutral-700"
            >
              {VIEW_TEXT[candidate].tab}
            </KeepFocusButton>
          ))}
        </div>
      </div>
      <nav aria-label={VIEW_TEXT[view].nav}>
        <ul className="flex flex-col gap-px">
          <li>
            <Entry
              label={VIEW_TEXT[view].all}
              detail={null}
              count={total}
              current={scope === null}
              onClick={() => onScope(null)}
            />
          </li>
          {content.kind === 'tree' ? (
            <FolderTree
              roots={content.roots}
              scope={scope}
              choices={treeChoices}
              onScope={onScope}
              onOpen={onTreeOpen}
            />
          ) : (
            content.entries.map((entry) => (
              <li key={entry.scope.key}>
                <Entry
                  label={entry.label}
                  detail={entry.detail}
                  count={entry.count}
                  current={sameScope(entry.scope, scope)}
                  title={entry.scope.key}
                  onClick={() => onScope(sameScope(entry.scope, scope) ? null : entry.scope)}
                />
              </li>
            ))
          )}
        </ul>
      </nav>
    </div>
  );
});
