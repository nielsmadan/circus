import type { AppInfo, DecisionAction, ListResponse, SessionRow } from '../api/types';
import type { Applied } from './applied';
import type { OutboxEntry } from './outbox';

export type Split = 'recent' | 'woke' | 'all';
export const SPLITS: readonly Split[] = Object.freeze(['recent', 'woke', 'all']);

export interface ProjectCount {
  readonly key: string;
  readonly label: string;
  readonly pending: number;
}

export interface RowIndex {
  readonly mtimeMs: ReadonlyMap<string, number>;
  readonly haystack: ReadonlyMap<string, string>;
}

function buildHaystack(row: SessionRow): string {
  return [
    row.label,
    row.project_label,
    row.project_short,
    row.what_it_is,
    row.last_prompt,
    row.git_branch,
    row.session_id,
    row.agent,
  ]
    .filter((part) => part !== null)
    .join('\n')
    .toLowerCase();
}

const HAS_OFFSET = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i;

// ringleader reads an offset-less timestamp as UTC; Date.parse would read it as local
export function parseMtime(mtime: string): number {
  const naive = /T\d\d:\d\d/.test(mtime) && !HAS_OFFSET.test(mtime);
  return Date.parse(naive ? `${mtime}Z` : mtime);
}

export function indexRows(rows: readonly SessionRow[]): RowIndex {
  const mtimeMs = new Map<string, number>();
  const haystack = new Map<string, string>();
  for (const row of rows) {
    mtimeMs.set(row.id, parseMtime(row.mtime));
    haystack.set(row.id, buildHaystack(row));
  }
  return { mtimeMs, haystack };
}

export function hiddenIds(entries: readonly OutboxEntry[]): ReadonlySet<string> {
  return new Set(entries.map((entry) => entry.decision.row.id));
}

export function visibleSessions(
  rows: readonly SessionRow[],
  entries: readonly OutboxEntry[],
  applied: Applied,
): SessionRow[] {
  if (entries.length === 0 && applied.size === 0) return rows as SessionRow[];
  const hidden = hiddenIds(entries);
  const visible = rows.filter((row) => !hidden.has(row.id) && !applied.has(row.id));
  return visible.length === rows.length ? (rows as SessionRow[]) : visible;
}

function mtimeOf(row: SessionRow, index: RowIndex): number {
  return index.mtimeMs.get(row.id) ?? parseMtime(row.mtime);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortByMtime(
  rows: readonly SessionRow[],
  index: RowIndex,
  newestFirst: boolean,
): SessionRow[] {
  const direction = newestFirst ? -1 : 1;
  return rows
    .map((row) => ({ row, ms: mtimeOf(row, index) }))
    .sort((a, b) => (a.ms - b.ms) * direction || compareStrings(a.row.id, b.row.id))
    .map((keyed) => keyed.row);
}

export function splitRows(
  rows: readonly SessionRow[],
  split: Split,
  index: RowIndex,
): SessionRow[] {
  switch (split) {
    case 'recent':
      return sortByMtime(
        rows.filter((row) => row.in_recent),
        index,
        true,
      );
    case 'woke':
      return sortByMtime(
        rows.filter((row) => row.woke),
        index,
        false,
      );
    case 'all':
      return sortByMtime(rows, index, false);
  }
}

export function splitCounts(rows: readonly SessionRow[]): Record<Split, number> {
  let recent = 0;
  let woke = 0;
  for (const row of rows) {
    if (row.in_recent) recent += 1;
    if (row.woke) woke += 1;
  }
  return { recent, woke, all: rows.length };
}

export function filterByProject(
  rows: readonly SessionRow[],
  projectKey: string | null,
): SessionRow[] {
  if (projectKey === null) return rows as SessionRow[];
  return rows.filter((row) => row.project_key === projectKey);
}

interface ProjectGroup {
  readonly key: string;
  label: string;
  oldestMs: number;
  oldestId: string;
  pending: number;
}

export function projectCounts(rows: readonly SessionRow[], index: RowIndex): ProjectCount[] {
  const groups = new Map<string, ProjectGroup>();
  for (const row of rows) {
    const ms = mtimeOf(row, index);
    const group = groups.get(row.project_key);
    if (group === undefined) {
      groups.set(row.project_key, {
        key: row.project_key,
        label: row.project_label,
        oldestMs: ms,
        oldestId: row.id,
        pending: 1,
      });
      continue;
    }
    group.pending += 1;
    if (ms < group.oldestMs || (ms === group.oldestMs && row.id < group.oldestId)) {
      group.label = row.project_label;
      group.oldestMs = ms;
      group.oldestId = row.id;
    }
  }
  return [...groups.values()]
    .map(({ key, label, pending }) => ({ key, label, pending, sortLabel: label.toLowerCase() }))
    .sort((a, b) => compareStrings(a.sortLabel, b.sortLabel) || compareStrings(a.key, b.key))
    .map(({ key, label, pending }) => ({ key, label, pending }));
}

export function searchRows(
  rows: readonly SessionRow[],
  query: string,
  index: RowIndex,
): SessionRow[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  if (terms.length === 0) return rows as SessionRow[];
  return rows.filter((row) => {
    const haystack = index.haystack.get(row.id) ?? buildHaystack(row);
    return terms.every((term) => haystack.includes(term));
  });
}

export function positions(rows: readonly SessionRow[]): ReadonlyMap<string, number> {
  return new Map(rows.map((row, position) => [row.id, position]));
}

export function nextSelection(
  before: readonly SessionRow[],
  after: readonly SessionRow[],
  selectedId: string | null,
): string | null {
  const last = after.length - 1;
  if (last < 0) return null;
  if (selectedId === null) return after[0]?.id ?? null;
  if (after.some((row) => row.id === selectedId)) return selectedId;
  const previous = Math.max(
    0,
    before.findIndex((row) => row.id === selectedId),
  );
  return after[Math.min(previous, last)]?.id ?? null;
}

const GUARDED_ACTIONS: ReadonlySet<DecisionAction> = new Set(['archive', 'delete', 'harvest']);

export function clientRefusal(action: DecisionAction, row: SessionRow): string | null {
  if (!GUARDED_ACTIONS.has(action)) return null;
  if (row.running === true) {
    return `${row.label} is running — finish it from inside with the ringleader-finish skill`;
  }
  if (row.running === null) {
    return `Can't tell whether ${row.label} is running — archive, delete and harvest are refused until presence works`;
  }
  if (row.lifecycle_block) return row.lifecycle_block;
  if (row.file_fingerprint === null) {
    return `${row.label} has no fingerprint — rescan first (⌘K › Rescan sessions)`;
  }
  return null;
}

export function decisionGuard(info: AppInfo | null, list: ListResponse | null): string | null {
  if (info !== null && info.environment_label === null) return null;
  if (info === null || list === null) return 'Loading…';
  if (info.world_root === null) return 'Sandbox without CIRCUS_WORLD_ROOT — decisions are disabled';
  if (!list.registry.startsWith(`${info.world_root}/`)) {
    return `Sandbox registry ${list.registry} is outside ${info.world_root} — decisions are disabled`;
  }
  return null;
}
