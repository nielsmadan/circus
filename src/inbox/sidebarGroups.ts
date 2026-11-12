import type { SessionRow } from '../api/types';
import { DAY_MS, localDayNumber } from '../localDay';
import { compareStrings, mtimeOf, type ProjectCount, type RowIndex } from './derive';
import {
  UNKNOWN_FOLDER,
  UNKNOWN_FOLDER_LABEL,
  folderOf,
  sameScope,
  under,
  withSlash,
  type PeriodKind,
  type Scope,
  type SidebarView,
} from './scope';

export interface SidebarEntry {
  readonly scope: Scope;
  readonly label: string;
  readonly detail: string | null;
  readonly count: number;
}

export interface FolderNode {
  readonly path: string;
  readonly name: string;
  readonly own: number;
  readonly total: number;
  readonly children: readonly FolderNode[];
  readonly scope: Scope;
}

export type SidebarContent =
  | { readonly kind: 'list'; readonly entries: readonly SidebarEntry[] }
  | { readonly kind: 'tree'; readonly roots: readonly FolderNode[] };

function homeRoot(home: string | null): string | null {
  if (home === null || home === '' || home === '/') return null;
  return home.endsWith('/') ? home.slice(0, -1) : home;
}

export function tilde(path: string, home: string | null): string {
  const root = homeRoot(home);
  if (root === null || !under(path, root)) return path;
  return `~${path.slice(root.length)}`;
}

function parentOf(key: string, home: string | null): string {
  const shown = tilde(key, home);
  const cut = shown.lastIndexOf('/');
  return cut <= 0 ? shown : shown.slice(0, cut + 1);
}

export function repoEntries(
  projects: readonly ProjectCount[],
  home: string | null,
): SidebarEntry[] {
  const seen = new Map<string, number>();
  for (const project of projects) seen.set(project.label, (seen.get(project.label) ?? 0) + 1);
  return projects.map((project) => ({
    scope: { kind: 'repo', key: project.key, label: project.label },
    label: project.label,
    detail: (seen.get(project.label) ?? 0) > 1 ? parentOf(project.key, home) : null,
    count: project.pending,
  }));
}

function folderLabel(path: string, home: string | null): string {
  return path === UNKNOWN_FOLDER ? UNKNOWN_FOLDER_LABEL : tilde(path, home);
}

function splitLabel(label: string): { readonly detail: string | null; readonly name: string } {
  const cut = label.lastIndexOf('/');
  if (cut < 0 || cut === label.length - 1) return { detail: null, name: label };
  return { detail: label.slice(0, cut + 1), name: label.slice(cut + 1) };
}

function compareFolded(a: string, b: string): number {
  return compareStrings(a.toLowerCase(), b.toLowerCase()) || compareStrings(a, b);
}

function folderCounts(rows: readonly SessionRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const folder = folderOf(row);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

export function folderEntries(rows: readonly SessionRow[], home: string | null): SidebarEntry[] {
  return [...folderCounts(rows)]
    .map(([key, count]) => ({ key, count, label: folderLabel(key, home) }))
    .sort((a, b) => compareFolded(a.label, b.label) || compareStrings(a.key, b.key))
    .map(({ key, count, label }) => {
      const { detail, name } = splitLabel(label);
      return { scope: { kind: 'folder', key, label }, label: name, detail, count };
    });
}

interface Trie {
  readonly path: string;
  readonly name: string;
  own: number;
  readonly children: Map<string, Trie>;
}

function trie(path: string, name: string): Trie {
  return { path, name, own: 0, children: new Map() };
}

function child(node: Trie, name: string): Trie {
  const found = node.children.get(name);
  if (found !== undefined) return found;
  const made = trie(`${withSlash(node.path)}${name}`, name);
  node.children.set(name, made);
  return made;
}

function treeNodeScope(path: string, excluding: string | null, home: string | null): Scope {
  const label = folderLabel(path, home);
  return {
    kind: 'tree',
    key: path,
    label: excluding === null ? label : `${label} except ~`,
    excluding,
  };
}

function freeze(node: Trie, excluding: string | null, home: string | null): FolderNode {
  const children = [...node.children.values()].map((c) => freeze(c, excluding, home));
  const total = children.reduce((sum, c) => sum + c.total, node.own);
  const [only] = children;
  if (node.own === 0 && children.length === 1 && only !== undefined) {
    return { ...only, name: `${withSlash(node.name)}${only.name}`, total };
  }
  const kept = excluding !== null && under(excluding, node.path) ? excluding : null;
  return {
    path: node.path,
    name: node.name,
    own: node.own,
    total,
    children: children.sort((a, b) => compareFolded(a.name, b.name)),
    scope: treeNodeScope(node.path, kept, home),
  };
}

function leaf(path: string, name: string, own: number, home: string | null): FolderNode {
  return { path, name, own, total: own, children: [], scope: treeNodeScope(path, null, home) };
}

// deeper paths only come from a corrupt session; they would overflow the recursion in freeze
const MAX_SEGMENTS = 256;

export function folderTree(rows: readonly SessionRow[], home: string | null): FolderNode[] {
  const root = homeRoot(home);
  const homeSide = root === null ? null : { root, trie: trie(root, '~') };
  const slashTrie = trie('/', '/');
  const loose: FolderNode[] = [];
  let unknown = 0;
  for (const [folder, own] of folderCounts(rows)) {
    if (folder === UNKNOWN_FOLDER) {
      unknown = own;
      continue;
    }
    const segments = folder.split('/');
    if (!folder.startsWith('/') || segments.length > MAX_SEGMENTS) {
      loose.push(leaf(folder, folder, own, home));
      continue;
    }
    const inside = homeSide !== null && under(folder, homeSide.root);
    let node = inside ? homeSide.trie : slashTrie;
    const rest = inside ? folder.slice(homeSide.root.length).split('/') : segments;
    for (const segment of rest) {
      if (segment !== '') node = child(node, segment);
    }
    node.own += own;
  }
  const grown = (t: Trie) => t.own > 0 || t.children.size > 0;
  return [
    ...(homeSide !== null && grown(homeSide.trie) ? [freeze(homeSide.trie, null, home)] : []),
    ...(grown(slashTrie) ? [freeze(slashTrie, root, home)] : []),
    ...loose.sort((a, b) => compareFolded(a.name, b.name)),
    ...(unknown > 0 ? [leaf(UNKNOWN_FOLDER, UNKNOWN_FOLDER_LABEL, unknown, home)] : []),
  ];
}

function outside(path: string, excluding: string | null): boolean {
  return excluding === null || !under(path, excluding);
}

// a selected folder that merged with its only child is now shown as that child's row
function findNode(
  nodes: readonly FolderNode[],
  path: string,
  excluding: string | null,
): FolderNode | null {
  const exact = nodes.find((node) => node.path === path);
  if (exact !== undefined) return exact;
  const absorbed = nodes.filter((node) => under(node.path, path) && outside(node.path, excluding));
  if (absorbed.length === 1) return absorbed[0] ?? null;
  const parent = nodes.find((node) => node.children.length > 0 && under(path, node.path));
  return parent === undefined ? null : findNode(parent.children, path, excluding);
}

const DAYS_BACK = 6;
const WEEKS_BACK = 8;

function localDay(ms: number): number {
  return localDayNumber(new Date(ms));
}

function localMidnight(day: number): number {
  const at = new Date(day * DAY_MS);
  return new Date(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()).getTime();
}

function weekday(day: number): number {
  return (day + 3) % 7;
}

function firstOfMonth(day: number, months = 0): number {
  const at = new Date(day * DAY_MS);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1) / DAY_MS;
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

interface Period {
  readonly kind: PeriodKind;
  readonly first: number;
  readonly end: number | null;
}

interface Calendar {
  readonly today: number;
  readonly dayFloor: number;
  readonly weekFloor: number;
}

function calendar(nowMs: number): Calendar {
  const today = localDay(nowMs);
  return {
    today,
    dayFloor: today - DAYS_BACK,
    weekFloor: today - weekday(today) - 7 * WEEKS_BACK,
  };
}

function periodOf(day: number, { today, dayFloor, weekFloor }: Calendar): Period {
  if (day >= today) return { kind: 'day', first: today, end: null };
  if (day >= dayFloor) return { kind: 'day', first: day, end: day + 1 };
  if (day >= weekFloor) {
    const monday = day - weekday(day);
    return { kind: 'week', first: monday, end: Math.min(monday + 7, dayFloor) };
  }
  const first = firstOfMonth(day);
  return { kind: 'month', first, end: Math.min(firstOfMonth(day, 1), weekFloor) };
}

function periodLabel({ kind, first }: Period): string {
  return kind === 'month' ? isoDay(first).slice(0, 7) : isoDay(first);
}

function periodScope(period: Period): Scope {
  const label = periodLabel(period);
  return {
    kind: 'period',
    key: `${period.kind}:${label}`,
    label,
    period: period.kind,
    start: localMidnight(period.first),
    end: period.end === null ? null : localMidnight(period.end),
  };
}

const PERIOD_KEY = /^(day|week|month):(\d{4})-(\d{2})(?:-(\d{2}))?$/;

function periodFromKey(key: string, nowMs: number): Scope | null {
  const match = PERIOD_KEY.exec(key);
  if (match === null) return null;
  const [, kind, year, month, day] = match;
  const first = Date.UTC(Number(year), Number(month) - 1, Number(day ?? 1)) / DAY_MS;
  const period = periodOf(first, calendar(nowMs));
  return period.kind === kind && period.first === first ? periodScope(period) : null;
}

interface Bucket {
  readonly period: Period;
  count: number;
}

export function dateEntries(
  rows: readonly SessionRow[],
  index: RowIndex,
  nowMs: number,
): SidebarEntry[] {
  const days = calendar(nowMs);
  // periods never share a first day, so it keys them
  const buckets = new Map<number, Bucket>();
  for (const row of rows) {
    const ms = mtimeOf(row, index);
    if (Number.isNaN(ms)) continue;
    const period = periodOf(localDay(ms), days);
    const bucket = buckets.get(period.first);
    if (bucket === undefined) buckets.set(period.first, { period, count: 1 });
    else bucket.count += 1;
  }
  return [...buckets.values()]
    .sort((a, b) => b.period.first - a.period.first)
    .map(({ period, count }) => {
      const scope = periodScope(period);
      return { scope, label: scope.label, detail: null, count };
    });
}

export interface SidebarInput {
  readonly projects: readonly ProjectCount[];
  readonly rows: readonly SessionRow[];
  readonly index: RowIndex;
  readonly home: string | null;
  readonly nowMs: number | null;
}

export function sidebarContent(view: SidebarView, input: SidebarInput): SidebarContent {
  switch (view) {
    case 'repos':
      return { kind: 'list', entries: repoEntries(input.projects, input.home) };
    case 'folders':
      return { kind: 'list', entries: folderEntries(input.rows, input.home) };
    case 'dates':
      return {
        kind: 'list',
        entries: input.nowMs === null ? [] : dateEntries(input.rows, input.index, input.nowMs),
      };
    case 'tree':
      return { kind: 'tree', roots: folderTree(input.rows, input.home) };
  }
}

export function resolvePeriod(selected: Scope, nowMs: number | null): Scope | null {
  if (selected.kind !== 'period' || nowMs === null) return selected;
  return periodFromKey(selected.key, nowMs);
}

// a selection keeps its key; its bounds and label follow the current data, and a period that
// no longer exists (today became yesterday's week) is dropped
export function resolveScope(
  selected: Scope | null,
  content: SidebarContent,
  nowMs: number | null,
): Scope | null {
  if (selected === null) return null;
  if (selected.kind === 'period') return resolvePeriod(selected, nowMs);
  if (content.kind === 'tree') {
    const excluding = selected.kind === 'tree' ? selected.excluding : null;
    return findNode(content.roots, selected.key, excluding)?.scope ?? selected;
  }
  return content.entries.find((entry) => sameScope(entry.scope, selected))?.scope ?? selected;
}
