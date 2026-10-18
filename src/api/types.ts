export const CONTRACT_VERSION = 1;
export const LIST_TEXT_MAX_CHARS = 500;
export const TAIL_MAX_IDS = 16;

export type DecisionAction = 'harvest' | 'archive' | 'delete' | 'snooze' | 'keep' | 'keep_going';
export type OutcomeStatus = 'ok' | 'refused' | 'empty' | 'failed';
export type Badge =
  'filtered' | 'snoozed' | 'kept' | 'finishing' | 'harvested' | 'abandoned' | 'drifted';

export interface SessionRow {
  id: string;
  source: string;
  agent: string;
  session_id: string;
  label: string;
  project: string | null;
  project_short: string;
  project_key: string;
  project_label: string;
  git_project_key: string | null;
  git_project_label: string | null;
  git_branch: string | null;
  last_prompt: string | null;
  what_it_is: string | null;
  status: string;
  mtime: string;
  age_days: number;
  age_human: string;
  size_bytes: number | null;
  size_human: string;
  message_count: number;
  file: string | null;
  decision: string | null;
  reviewed_at_mtime: string | null;
  snoozed_at: string | null;
  snoozed_until: string | null;
  kept_at: string | null;
  finish_on_exit: boolean;
  file_fingerprint: string | null;
  running: boolean | null;
  in_recent: boolean;
  woke: boolean;
  lifecycle_block: string | null;
  badges: Badge[];
}

export interface ListResponse {
  version: 1;
  kind: 'list';
  generated_at: string;
  registry: string;
  recent_days: number;
  presence: { state: 'ok' | 'unknown'; problem: string | null };
  roundup: {
    last_at: string | null;
    age_human: string | null;
    stale: boolean;
    stale_hours: number;
  };
  sessions: SessionRow[];
}

export interface ScanResponse {
  version: 1;
  kind: 'scan';
  scanned_at: string;
  added: number;
  removed: number;
  unavailable_sources: string[];
}

export interface TailItem {
  id: string;
  text: string;
  max_chars: number;
  truncated: boolean;
  unavailable: string | null;
  mtime: string | null;
  file_fingerprint: string | null;
}

export interface TailsResponse {
  version: 1;
  kind: 'tails';
  items: TailItem[];
}

export interface DecideOutcome {
  version: 1;
  kind: 'outcome';
  action: DecisionAction;
  id: string;
  status: OutcomeStatus;
  reason: string | null;
  message: string;
  wrote: boolean;
  path: string | null;
  warnings: string[];
}

export interface ErrorDocument {
  version: 1;
  kind: 'error';
  message: string;
}

export const SESSION_ROW_KEYS = [
  'age_days',
  'age_human',
  'agent',
  'badges',
  'decision',
  'file',
  'file_fingerprint',
  'finish_on_exit',
  'git_branch',
  'git_project_key',
  'git_project_label',
  'id',
  'in_recent',
  'kept_at',
  'label',
  'last_prompt',
  'lifecycle_block',
  'message_count',
  'mtime',
  'project',
  'project_key',
  'project_label',
  'project_short',
  'reviewed_at_mtime',
  'running',
  'session_id',
  'size_bytes',
  'size_human',
  'snoozed_at',
  'snoozed_until',
  'source',
  'status',
  'what_it_is',
  'woke',
] as const satisfies readonly (keyof SessionRow)[];

export const LIST_RESPONSE_KEYS = [
  'generated_at',
  'kind',
  'presence',
  'recent_days',
  'registry',
  'roundup',
  'sessions',
  'version',
] as const satisfies readonly (keyof ListResponse)[];

export const DECIDE_OUTCOME_KEYS = [
  'action',
  'id',
  'kind',
  'message',
  'path',
  'reason',
  'status',
  'version',
  'warnings',
  'wrote',
] as const satisfies readonly (keyof DecideOutcome)[];

export const TAILS_RESPONSE_KEYS = [
  'items',
  'kind',
  'version',
] as const satisfies readonly (keyof TailsResponse)[];

export const TAIL_ITEM_KEYS = [
  'file_fingerprint',
  'id',
  'max_chars',
  'mtime',
  'text',
  'truncated',
  'unavailable',
] as const satisfies readonly (keyof TailItem)[];

export type CircusErrorKind =
  | 'rl_not_found'
  | 'rl_too_old'
  | 'timeout'
  | 'failed'
  | 'bad_output'
  | 'invalid_argument'
  | 'launch';

export interface CircusError {
  kind: CircusErrorKind;
  message: string;
  exit_code: number | null;
  stderr_tail: string | null;
}

export interface DecideRequest {
  action: DecisionAction;
  id: string;
  mtime: string;
  fingerprint: string | null;
  until: string | null;
}

export type TerminalKind = 'iterm2' | 'custom';

export interface ResumeLaunch {
  command: string;
  launched: boolean;
  via: TerminalKind;
}

export interface AppInfo {
  rl_command: string[];
  rl_source: 'env' | 'settings' | 'login_shell' | 'fallback' | 'missing';
  shell_probe: 'ok' | 'timed_out' | 'failed' | 'skipped';
  environment_label: string | null;
  world_root: string | null;
  resume_dry_run: boolean;
  terminal: TerminalKind;
  settings_path: string;
}

const ERROR_KINDS: ReadonlySet<string> = new Set<CircusErrorKind>([
  'rl_not_found',
  'rl_too_old',
  'timeout',
  'failed',
  'bad_output',
  'invalid_argument',
  'launch',
]);

export function isCircusError(value: unknown): value is CircusError {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === 'string' &&
    ERROR_KINDS.has(record.kind) &&
    typeof record.message === 'string' &&
    (record.exit_code === null || typeof record.exit_code === 'number') &&
    (record.stderr_tail === null || typeof record.stderr_tail === 'string')
  );
}

export function toCircusError(value: unknown): CircusError {
  if (isCircusError(value)) return value;
  return { kind: 'failed', message: String(value), exit_code: null, stderr_tail: null };
}
