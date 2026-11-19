export const TAIL_MAX_IDS = 16;
export const TAIL_CHARS = 50_000;

export type DecisionAction =
  'harvest' | 'archive' | 'delete' | 'snooze' | 'keep' | 'keep_going' | 'unkeep';
export type OutcomeStatus = 'ok' | 'refused' | 'empty' | 'failed';
export type OutcomeCode =
  | 'changed'
  | 'no_fingerprint'
  | 'gone'
  | 'transcript_missing'
  | 'running'
  | 'presence_unknown'
  | 'lifecycle_blocked'
  | 'until_invalid'
  | 'until_naive'
  | 'until_past'
  | 'no_harvest_model'
  | 'harvest_failed'
  | 'failed'
  | 'other';
export type PresenceCode = 'not_installed' | 'failed';
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

export type NextStepKind = 'roundup' | 'woke' | 'recent' | 'publish' | 'project' | 'resume';

interface NextStepFlags {
  deletes: boolean;
  costs_model: boolean;
}

export type NextStep = NextStepFlags &
  (
    | { kind: 'roundup'; count: null; project_key: null; id: null }
    | { kind: 'woke' | 'recent' | 'publish'; count: number; project_key: null; id: null }
    | { kind: 'project'; count: number; project_key: string; id: null }
    | { kind: 'resume'; count: null; project_key: null; id: string }
  );

export interface HomeProject {
  key: string;
  label: string;
  pending: number;
  unclassified: number;
  oldest_mtime: string;
  newest_mtime: string;
}

export interface HomeCounts {
  triage_total: number;
  live: number;
  unclassified: number;
  blocked: number;
  stale: number;
  kept: number;
  projects: number;
  spread_projects: number;
}

export interface Home {
  counts: HomeCounts;
  pending_harvests: number;
  projects: HomeProject[];
  waking_soon: string[];
  in_flight: string[];
  rows: SessionRow[];
  next_steps: NextStep[];
}

export interface AgentInfo {
  source: string;
  agent: string;
  installed: boolean;
}

export interface ListResponse {
  version: 1;
  kind: 'list';
  agents?: AgentInfo[];
  home?: Home;
  generated_at: string;
  registry: string;
  recent_days: number;
  presence: { state: 'ok' | 'unknown'; problem: string | null; code?: PresenceCode | null };
  roundup: {
    last_at: string | null;
    age_human: string | null;
    stale: boolean;
    stale_hours: number;
  };
  scan?: ScanSummary | null;
  sessions: SessionRow[];
  kept?: SessionRow[];
}

export interface ScanSummary {
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
  code: OutcomeCode | null;
  reason: string | null;
  message: string;
  wrote: boolean;
  path: string | null;
  warnings: string[];
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
  'agents',
  'generated_at',
  'home',
  'kept',
  'kind',
  'presence',
  'recent_days',
  'registry',
  'roundup',
  'scan',
  'sessions',
  'version',
] as const satisfies readonly (keyof ListResponse)[];

export const HOME_KEYS = [
  'counts',
  'in_flight',
  'next_steps',
  'pending_harvests',
  'projects',
  'rows',
  'waking_soon',
] as const satisfies readonly (keyof Home)[];

export const HOME_COUNT_KEYS = [
  'blocked',
  'kept',
  'live',
  'projects',
  'spread_projects',
  'stale',
  'triage_total',
  'unclassified',
] as const satisfies readonly (keyof HomeCounts)[];

export const HOME_PROJECT_KEYS = [
  'key',
  'label',
  'newest_mtime',
  'oldest_mtime',
  'pending',
  'unclassified',
] as const satisfies readonly (keyof HomeProject)[];

export const NEXT_STEP_KEYS = [
  'costs_model',
  'count',
  'deletes',
  'id',
  'kind',
  'project_key',
] as const satisfies readonly (keyof NextStep)[];

export const AGENT_INFO_KEYS = [
  'agent',
  'installed',
  'source',
] as const satisfies readonly (keyof AgentInfo)[];

export type HandoffCode = 'nothing_to_triage' | 'agent_not_installed';

interface HandoffDocument {
  version: 1;
  kind: 'handoff';
  purpose: 'triage';
  source: string;
  agent: string;
  project_key: string;
}

export type HandoffResponse = HandoffDocument &
  (
    | { status: 'ok'; code: null; reason: null; cwd: string; argv: string[] }
    | { status: 'refused'; code: HandoffCode; reason: string; cwd: null; argv: null }
  );

export const HANDOFF_RESPONSE_KEYS = [
  'agent',
  'argv',
  'code',
  'cwd',
  'kind',
  'project_key',
  'purpose',
  'reason',
  'source',
  'status',
  'version',
] as const satisfies readonly (keyof HandoffResponse)[];

export interface HandoffRequest {
  project_key: string;
  agent: string;
}

export const DECIDE_OUTCOME_KEYS = [
  'action',
  'code',
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
  | 'rl_error'
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

export interface TerminalLaunch {
  command: string;
  launched: boolean;
  via: TerminalKind;
}

export type InstallState = 'missing' | 'too_old' | 'outdated' | 'current';

interface SetupRequirements {
  minimum: string;
  latest: string;
  uv_available: boolean;
  can_install: boolean;
}

export type InstalledStatus = SetupRequirements & {
  state: Exclude<InstallState, 'missing'>;
  installed: string;
};

export type SetupStatus =
  (SetupRequirements & { state: 'missing'; installed: null }) | InstalledStatus;

export interface SetupPrefs {
  onboarded: boolean;
  prompt_updates: boolean;
}

export type RlSource = 'env' | 'settings' | 'installed' | 'login_shell' | 'fallback' | 'missing';

export interface AppInfo {
  rl_command: string[];
  rl_source: RlSource;
  shell_probe: 'ok' | 'timed_out' | 'failed' | 'skipped';
  environment_label: string | null;
  world_root: string | null;
  resume_dry_run: boolean;
  terminal: TerminalKind;
  settings_path: string;
  home_dir: string;
}

const ERROR_KINDS: ReadonlySet<string> = new Set<CircusErrorKind>([
  'rl_not_found',
  'rl_too_old',
  'timeout',
  'failed',
  'rl_error',
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
