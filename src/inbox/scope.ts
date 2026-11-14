import type { SessionRow } from '../api/types';

export type SidebarView = 'repos' | 'folders' | 'tree' | 'dates';
export const SIDEBAR_VIEWS: readonly SidebarView[] = Object.freeze([
  'repos',
  'folders',
  'tree',
  'dates',
]);

export const UNKNOWN_FOLDER = '(unknown)';
export const UNKNOWN_FOLDER_LABEL = 'Unknown folder';

export type PeriodKind = 'day' | 'week' | 'month';

export type Scope =
  | { readonly kind: 'repo' | 'folder'; readonly key: string; readonly label: string }
  | {
      readonly kind: 'tree';
      readonly key: string;
      readonly label: string;
      readonly excluding: string | null;
    }
  | {
      readonly kind: 'period';
      readonly key: string;
      readonly label: string;
      readonly period: PeriodKind;
      readonly start: number;
      readonly end: number | null;
    };

const VIEW_OF_KIND: Readonly<Record<Scope['kind'], SidebarView>> = {
  repo: 'repos',
  folder: 'folders',
  tree: 'tree',
  period: 'dates',
};

export function viewFor(scope: Scope): SidebarView {
  return VIEW_OF_KIND[scope.kind];
}

export function folderOf(row: SessionRow): string {
  return row.project || UNKNOWN_FOLDER;
}

export function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

export function under(folder: string, path: string): boolean {
  return folder === path || folder.startsWith(withSlash(path));
}

function inTree(folder: string, path: string, excluding: string | null): boolean {
  if (path === UNKNOWN_FOLDER || folder === UNKNOWN_FOLDER) return folder === path;
  return under(folder, path) && !(excluding !== null && under(folder, excluding));
}

export function inScope(row: SessionRow, scope: Scope, mtimeMs: number): boolean {
  switch (scope.kind) {
    case 'repo':
      return row.project_key === scope.key;
    case 'folder':
      return folderOf(row) === scope.key;
    case 'tree':
      return inTree(folderOf(row), scope.key, scope.excluding);
    case 'period':
      return mtimeMs >= scope.start && (scope.end === null || mtimeMs < scope.end);
  }
}

export function scopeKey(scope: Scope | null): string {
  return scope === null ? '' : `${scope.kind}:${scope.key}`;
}

export function sameScope(a: Scope | null, b: Scope | null): boolean {
  return a === b || scopeKey(a) === scopeKey(b);
}

export function scopeNoun(scope: Scope): string {
  switch (scope.kind) {
    case 'repo':
      return 'repo';
    case 'folder':
    case 'tree':
      return 'folder';
    case 'period':
      return scope.period;
  }
}
