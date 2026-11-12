import { useMemo } from 'react';
import type { Scope, SidebarView } from './scope';
import {
  resolveScope,
  sidebarContent,
  type SidebarContent,
  type SidebarInput,
} from './sidebarGroups';

export interface SidebarModel {
  readonly content: SidebarContent;
  readonly scope: Scope | null;
}

export function useSidebarContent(
  view: SidebarView,
  { projects, rows, index, home, nowMs }: SidebarInput,
  selected: Scope | null,
): SidebarModel {
  const content = useMemo(
    () => sidebarContent(view, { projects, rows, index, home, nowMs }),
    [view, projects, rows, index, home, nowMs],
  );
  const scope = useMemo(() => resolveScope(selected, content, nowMs), [selected, content, nowMs]);
  return { content, scope };
}
