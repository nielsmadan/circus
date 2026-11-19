import type { Badge, ListResponse, SessionRow } from '../api/types';

const DAY_MS = 86_400_000;
const SPAN_DAYS = 60;
const RECENT_DAYS = 7;
const MAX_TEXT_CHARS = 200;

const WORDS = Object.freeze([
  'fix',
  'flaky',
  'login',
  'parser',
  'export',
  'release',
  'cache',
  'schema',
  'docs',
  'hooks',
  'picker',
  'refactor',
  'migrate',
  'retry',
  'build',
  'deploy',
  'search',
  'index',
  'review',
  'tests',
  'config',
  'session',
  'outbox',
  'tail',
]);

const BRANCHES = Object.freeze(['main', 'fix/login', 'feat/search', 'chore/deps', null]);

type Random = () => number;

function lcg(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function phrase(random: Random, min: number, max: number): string {
  const count = min + Math.floor(random() * (max - min + 1));
  const words = Array.from({ length: count }, () => pick(random, WORDS));
  return words.join(' ').slice(0, MAX_TEXT_CHARS);
}

function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
}

function ageHuman(ageMs: number): string {
  if (ageMs >= DAY_MS) return `${Math.floor(ageMs / DAY_MS)}d ago`;
  if (ageMs >= 3_600_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.max(0, Math.floor(ageMs / 60_000))}m ago`;
}

function sizeHuman(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

interface Draft {
  readonly index: number;
  readonly mtimeMs: number;
  readonly project: number;
  readonly woke: boolean;
  readonly sizeBytes: number;
  readonly messages: number;
  readonly label: string;
  readonly prompt: string;
  readonly what: string;
  readonly branch: string | null;
}

function draft(random: Random, index: number, projects: number, nowMs: number): Draft {
  return {
    index,
    mtimeMs: nowMs - Math.floor((random() * SPAN_DAYS * DAY_MS) / 1000) * 1000,
    project: Math.floor(random() * projects),
    woke: random() < 0.05,
    sizeBytes: 1_000 + Math.floor(random() * 4_000_000),
    messages: 1 + Math.floor(random() * 200),
    label: `${phrase(random, 2, 4)} ${index}`,
    prompt: phrase(random, 6, 24),
    what: phrase(random, 4, 12),
    branch: pick(random, BRANCHES),
  };
}

type Place = Pick<
  SessionRow,
  | 'project'
  | 'project_short'
  | 'project_key'
  | 'project_label'
  | 'git_project_key'
  | 'git_project_label'
>;

function shortPath(path: string): string {
  const parts = (path.startsWith('/u/') ? `~${path.slice(2)}` : path).split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

function inGit(cwd: string, key: string, label: string): Place {
  return {
    project: cwd,
    project_short: shortPath(cwd),
    project_key: key,
    project_label: label,
    git_project_key: key,
    git_project_label: label,
  };
}

function placeOf(d: Draft, name: string): Place {
  if (d.index % 97 === 96) {
    return {
      project: null,
      project_short: '(unknown)',
      project_key: '(unknown)',
      project_label: '(unknown)',
      git_project_key: null,
      git_project_label: null,
    };
  }
  switch (d.project % 5) {
    case 0:
      return inGit(`/u/wrksp/${name}/dev${1 + (d.index % 2)}`, `github.com/acme/${name}`, name);
    case 1:
      return inGit(`/u/wrksp/mono/packages/${name}`, 'github.com/acme/mono', 'mono');
    case 2:
      return inGit(`/u/work/${name}`, `/u/work/${name}`, name);
    case 3: {
      const cwd = `/u/notes/${name}`;
      return {
        project: cwd,
        project_short: shortPath(cwd),
        project_key: cwd,
        project_label: shortPath(cwd),
        git_project_key: null,
        git_project_label: null,
      };
    }
    default:
      return inGit(`/opt/src/${name}`, `gitlab.com/ops/${name}`, name);
  }
}

function toRow(d: Draft, nowMs: number, running: boolean): SessionRow {
  const codex = d.index % 5 === 4;
  const source = codex ? 'codex' : 'claude-code';
  const sessionId = `s${d.index}`;
  const name = `proj-${String(d.project).padStart(2, '0')}`;
  const place = placeOf(d, name);
  const ageMs = nowMs - d.mtimeMs;
  const mtime = isoSeconds(d.mtimeMs);
  return {
    id: `${source}:${sessionId}`,
    source,
    agent: codex ? 'codex' : 'claude',
    session_id: sessionId,
    label: d.label,
    ...place,
    git_branch: d.branch,
    last_prompt: d.prompt,
    what_it_is: d.what,
    status: 'unclassified',
    mtime,
    age_days: Math.round((ageMs / DAY_MS) * 10) / 10,
    age_human: ageHuman(ageMs),
    size_bytes: d.sizeBytes,
    size_human: sizeHuman(d.sizeBytes),
    message_count: d.messages,
    file: codex
      ? `/u/.codex/sessions/${sessionId}.jsonl`
      : `/u/.claude/projects/-u-work-${name}/${sessionId}.jsonl`,
    decision: null,
    reviewed_at_mtime: null,
    snoozed_at: d.woke ? mtime : null,
    snoozed_until: d.woke ? isoSeconds(nowMs - DAY_MS) : null,
    kept_at: null,
    finish_on_exit: false,
    file_fingerprint: `1:${d.messages}:${d.sizeBytes}:${d.mtimeMs}000000:${d.mtimeMs}000000`,
    running,
    in_recent: ageMs <= RECENT_DAYS * DAY_MS,
    woke: d.woke,
    lifecycle_block: null,
    badges: [],
  };
}

export function syntheticRows(count: number, nowMs: number): SessionRow[] {
  const random = lcg(0x5eed);
  const projects = Math.max(1, Math.floor(count / 14));
  const drafts = Array.from({ length: count }, (_, index) => draft(random, index, projects, nowMs));
  const newest = drafts.reduce<Draft | null>(
    (best, d) => (best === null || d.mtimeMs > best.mtimeMs ? d : best),
    null,
  );
  return drafts.map((d) => toRow(d, nowMs, d === newest));
}

export type FakeWorld = Required<Pick<ListResponse, 'sessions' | 'kept'>>;

function withoutBadges(row: SessionRow, ...badges: readonly Badge[]): Badge[] {
  return row.badges.filter((each) => !badges.includes(each));
}

export function keptRow(row: SessionRow, keptAt: string): SessionRow {
  return {
    ...row,
    decision: 'keep',
    kept_at: keptAt,
    woke: false,
    badges: [...withoutBadges(row, 'kept'), 'kept'],
  };
}

export function unkeptRow(row: SessionRow): SessionRow {
  return {
    ...row,
    decision: null,
    kept_at: null,
    reviewed_at_mtime: null,
    snoozed_at: null,
    snoozed_until: null,
    woke: false,
    badges: withoutBadges(row, 'kept', 'snoozed'),
  };
}

export function keepEvery(rows: readonly SessionRow[], every: number, nowMs: number): FakeWorld {
  const keptAt = (row: SessionRow) => isoSeconds(Math.min(nowMs, Date.parse(row.mtime) + DAY_MS));
  return {
    sessions: rows.filter((_, index) => index % every !== every - 1),
    kept: rows
      .filter((_, index) => index % every === every - 1)
      .map((row) => keptRow(row, keptAt(row))),
  };
}
