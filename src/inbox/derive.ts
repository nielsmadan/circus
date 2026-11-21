import type { AppInfo, DecisionAction, ListResponse, SessionRow } from '../api/types';
import type { DayBounds } from '../localDay';
import type { InboxListAction } from '../shortcuts/contexts';
import type { Applied } from './applied';
import { presenceUnknownText, stillRunningText } from './messages';
import type { OutboxEntry } from './outbox';
import { inScope, type Scope } from './scope';

export type Split = 'today' | 'recent' | 'woke' | 'all' | 'snoozed' | 'kept';

const splitsWith = ({ snoozed, kept }: { snoozed: boolean; kept: boolean }): readonly Split[] =>
  Object.freeze([
    'today',
    'recent',
    'woke',
    'all',
    ...(snoozed ? (['snoozed'] as const) : []),
    ...(kept ? (['kept'] as const) : []),
  ]);

const INBOX_SPLITS = splitsWith({ snoozed: false, kept: false });
const WITH_KEPT = splitsWith({ snoozed: false, kept: true });
const WITH_SNOOZED = splitsWith({ snoozed: true, kept: false });
const WITH_BOTH = splitsWith({ snoozed: true, kept: true });

export function availableSplits(
  list: Pick<ListResponse, 'kept' | 'snoozed'> | null,
): readonly Split[] {
  const kept = list?.kept !== undefined;
  if (list?.snoozed === undefined) return kept ? WITH_KEPT : INBOX_SPLITS;
  return kept ? WITH_BOTH : WITH_SNOOZED;
}

export const isKept = (row: SessionRow): boolean => row.decision === 'keep';

// a kept session stays in Kept whatever its snooze says, and ringleader never marks it woke
export const isSnoozed = (row: SessionRow): boolean =>
  row.snoozed_at !== null && !row.woke && !isKept(row);

export interface SplitSources {
  readonly sessions: readonly SessionRow[];
  readonly kept: readonly SessionRow[];
  readonly snoozed: readonly SessionRow[];
}

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

export function listedRows(
  list: {
    readonly sessions: readonly SessionRow[];
    readonly kept?: readonly SessionRow[];
    readonly snoozed?: readonly SessionRow[];
  } | null,
): readonly SessionRow[] {
  const sessions = list?.sessions ?? NO_ROWS;
  const kept = list?.kept ?? NO_ROWS;
  const snoozed = list?.snoozed ?? NO_ROWS;
  return kept.length === 0 && snoozed.length === 0 ? sessions : [...sessions, ...kept, ...snoozed];
}

export function mapSources(
  sources: SplitSources,
  each: (rows: readonly SessionRow[]) => readonly SessionRow[],
): SplitSources {
  return {
    sessions: each(sources.sessions),
    kept: each(sources.kept),
    snoozed: each(sources.snoozed),
  };
}

export const isParkedSplit = (split: Split): split is 'kept' | 'snoozed' =>
  split === 'kept' || split === 'snoozed';

export function sourcesOf(row: SessionRow): SplitSources {
  if (isKept(row)) return { sessions: NO_ROWS, kept: [row], snoozed: NO_ROWS };
  if (isSnoozed(row)) return { sessions: NO_ROWS, kept: NO_ROWS, snoozed: [row] };
  return { sessions: [row], kept: NO_ROWS, snoozed: NO_ROWS };
}

function bucketFor(sources: SplitSources, split: Split): readonly SessionRow[] {
  return isParkedSplit(split) ? sources[split] : sources.sessions;
}

export interface ProjectCount {
  readonly key: string;
  readonly label: string;
  readonly pending: number;
  readonly oldestMtime: string;
}

export interface RowIndex {
  readonly mtimeMs: ReadonlyMap<string, number>;
  readonly haystack: ReadonlyMap<string, string>;
  readonly oldestFirst: readonly string[];
  readonly newestFirst: readonly string[];
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
  const keyed = [...mtimeMs].map(([id, ms]) => ({ id, ms }));
  const order = (direction: number) =>
    [...keyed]
      .sort((a, b) => (a.ms - b.ms) * direction || compareStrings(a.id, b.id))
      .map(({ id }) => id);
  return { mtimeMs, haystack, oldestFirst: order(1), newestFirst: order(-1) };
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

export function mtimeOf(row: SessionRow, index: RowIndex): number {
  return index.mtimeMs.get(row.id) ?? parseMtime(row.mtime);
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortByMtime(
  rows: readonly SessionRow[],
  index: RowIndex,
  newestFirst: boolean,
): SessionRow[] {
  if (rows.length < 2) return [...rows];
  const order = newestFirst ? index.newestFirst : index.oldestFirst;
  if (rows.length * Math.log2(rows.length) >= order.length) {
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (byId.size === rows.length && rows.every((row) => index.mtimeMs.has(row.id))) {
      return order.map((id) => byId.get(id)).filter((row): row is SessionRow => row !== undefined);
    }
  }
  const direction = newestFirst ? -1 : 1;
  return rows
    .map((row) => ({ row, ms: mtimeOf(row, index) }))
    .sort((a, b) => (a.ms - b.ms) * direction || compareStrings(a.row.id, b.row.id))
    .map((keyed) => keyed.row);
}

export function splitRows(
  sources: SplitSources,
  split: Split,
  index: RowIndex,
  today: DayBounds | null,
): SessionRow[] {
  return sortSplit(bucketFor(sources, split), split, index, today);
}

const isToday = (row: SessionRow, index: RowIndex, today: DayBounds | null): boolean => {
  if (today === null) return false;
  const ms = mtimeOf(row, index);
  return ms >= today.start && ms < today.end;
};

function sortSplit(
  rows: readonly SessionRow[],
  split: Split,
  index: RowIndex,
  today: DayBounds | null,
): SessionRow[] {
  switch (split) {
    case 'today':
      return sortByMtime(
        rows.filter((row) => isToday(row, index, today)),
        index,
        true,
      );
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
    case 'snoozed':
      return soonestWakeFirst(rows);
    case 'kept':
      return newestKeptFirst(rows, index);
  }
}

function wakeMs(row: SessionRow): number {
  const ms = row.snoozed_until === null ? NaN : parseMtime(row.snoozed_until);
  return Number.isNaN(ms) ? Infinity : ms;
}

function soonestWakeFirst(rows: readonly SessionRow[]): SessionRow[] {
  return rows
    .map((row) => ({ row, ms: wakeMs(row) }))
    .sort((a, b) => a.ms - b.ms || compareStrings(a.row.id, b.row.id))
    .map((keyed) => keyed.row);
}

function newestKeptFirst(rows: readonly SessionRow[], index: RowIndex): SessionRow[] {
  return rows
    .map((row) => ({
      row,
      ms: row.kept_at === null ? mtimeOf(row, index) : parseMtime(row.kept_at),
    }))
    .sort((a, b) => b.ms - a.ms || compareStrings(a.row.id, b.row.id))
    .map((keyed) => keyed.row);
}

export function splitCounts(
  { sessions, kept, snoozed }: SplitSources,
  index: RowIndex,
  today: DayBounds | null,
): Record<Split, number> {
  let todays = 0;
  let recent = 0;
  let woke = 0;
  for (const row of sessions) {
    if (isToday(row, index, today)) todays += 1;
    if (row.in_recent) recent += 1;
    if (row.woke) woke += 1;
  }
  return {
    today: todays,
    recent,
    woke,
    all: sessions.length,
    snoozed: snoozed.length,
    kept: kept.length,
  };
}

export function filterByScope(
  rows: readonly SessionRow[],
  scope: Scope | null,
  index: RowIndex,
): SessionRow[] {
  if (scope === null) return rows as SessionRow[];
  return rows.filter((row) => inScope(row, scope, mtimeOf(row, index)));
}

export function narrowRows(
  rows: readonly SessionRow[],
  scope: Scope | null,
  query: string,
  index: RowIndex,
): SessionRow[] {
  return searchRows(filterByScope(rows, scope, index), query, index);
}

interface ProjectGroup {
  readonly key: string;
  label: string;
  oldestMs: number;
  oldestId: string;
  oldestMtime: string;
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
        oldestMtime: row.mtime,
        pending: 1,
      });
      continue;
    }
    group.pending += 1;
    if (ms < group.oldestMs || (ms === group.oldestMs && row.id < group.oldestId)) {
      group.label = row.project_label;
      group.oldestMs = ms;
      group.oldestId = row.id;
      group.oldestMtime = row.mtime;
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, sortLabel: group.label.toLowerCase() }))
    .sort(
      (a, b) =>
        a.oldestMs - b.oldestMs ||
        compareStrings(a.sortLabel, b.sortLabel) ||
        compareStrings(a.key, b.key),
    )
    .map(({ key, label, pending, oldestMtime }) => ({ key, label, pending, oldestMtime }));
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
  const kept = new Set(after.map((row) => row.id));
  if (kept.has(selectedId)) return selectedId;
  const previous = before.findIndex((row) => row.id === selectedId);
  if (previous < 0) return after[0]?.id ?? null;
  const following = before.slice(previous + 1).find((row) => kept.has(row.id));
  return following?.id ?? after[Math.min(previous, last)]?.id ?? null;
}

const GUARDED_ACTIONS: ReadonlySet<DecisionAction> = new Set(['archive', 'delete', 'harvest']);
const REFUSED_WHEN_KEPT: ReadonlySet<DecisionAction> = new Set(['snooze', 'keep', 'keep_going']);
const REFUSED_WHEN_SNOOZED: ReadonlySet<DecisionAction> = new Set(['keep', 'keep_going']);

export const DECISION_FOR: Readonly<Partial<Record<InboxListAction, DecisionAction>>> = {
  harvestArchive: 'harvest',
  archive: 'archive',
  delete: 'delete',
  snooze: 'snooze',
  keep: 'keep',
  keepGoing: 'keep_going',
  unkeep: 'unkeep',
  wake: 'wake',
};

function stateRefusal(action: DecisionAction, row: SessionRow): string | null {
  if (action === 'unkeep') return isKept(row) ? null : `${row.label} isn’t kept`;
  if (action === 'wake') {
    if (isSnoozed(row)) return null;
    return isKept(row) ? `${row.label} is kept` : `${row.label} isn’t snoozed`;
  }
  if (REFUSED_WHEN_KEPT.has(action) && isKept(row)) return `${row.label} is already kept`;
  if (REFUSED_WHEN_SNOOZED.has(action) && isSnoozed(row)) return `${row.label} is snoozed`;
  return null;
}

export function offers(action: InboxListAction, row: SessionRow): boolean {
  const decision = DECISION_FOR[action];
  return decision === undefined || stateRefusal(decision, row) === null;
}

const ARCHIVE_BLOCK = 'cannot archive ';

// the block is computed for archive; the same transcript check refuses every guarded action
export function lifecycleText(block: string, action: DecisionAction): string {
  return block.startsWith(ARCHIVE_BLOCK)
    ? `cannot ${action} ${block.slice(ARCHIVE_BLOCK.length)}`
    : block;
}

export function acceptsAny(action: DecisionAction, rows: readonly SessionRow[]): boolean {
  return rows.some((row) => clientRefusal(action, row) === null);
}

export function clientRefusal(action: DecisionAction, row: SessionRow): string | null {
  const refused = stateRefusal(action, row);
  if (refused !== null) return refused;
  if (!GUARDED_ACTIONS.has(action)) return null;
  if (row.running === true) return stillRunningText(row.label);
  if (row.running === null) return presenceUnknownText(row.label);
  if (row.lifecycle_block) return lifecycleText(row.lifecycle_block, action);
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
