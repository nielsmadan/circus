import type { ListResponse, ScanSummary, SessionRow } from '../api/types';

const BASE_ROW: SessionRow = {
  id: 'claude-code:s0',
  source: 'claude-code',
  agent: 'claude',
  session_id: 's0',
  label: 'fix flaky login',
  project: '/u/work/proj-00',
  project_short: '…/work/proj-00',
  project_key: '/u/work/proj-00',
  project_label: 'proj-00',
  git_project_key: null,
  git_project_label: null,
  git_branch: null,
  last_prompt: null,
  what_it_is: null,
  status: 'unclassified',
  mtime: '2026-10-10T12:00:00+00:00',
  age_days: 6,
  age_human: '6d ago',
  size_bytes: 4096,
  size_human: '4.0KB',
  message_count: 4,
  file: '/u/.claude/projects/-u-work-proj-00/s0.jsonl',
  decision: null,
  reviewed_at_mtime: null,
  snoozed_at: null,
  snoozed_until: null,
  kept_at: null,
  finish_on_exit: false,
  file_fingerprint: '1:4:4096:1791892800000000000:1791892800000000000',
  running: false,
  in_recent: true,
  woke: false,
  lifecycle_block: null,
  badges: [],
};

export function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return { ...BASE_ROW, badges: [], ...overrides };
}

export function makeList(
  rows: readonly SessionRow[],
  overrides: Partial<ListResponse> = {},
): ListResponse {
  return {
    version: 1,
    kind: 'list',
    generated_at: '2026-10-16T12:00:00+00:00',
    registry: '/u/.local/share/ringleader/registry.json',
    recent_days: 7,
    presence: { state: 'ok', problem: null },
    roundup: { last_at: null, age_human: null, stale: false, stale_hours: 8 },
    scan: null,
    sessions: [...rows],
    ...overrides,
  };
}

export function makeScanSummary(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    scanned_at: '2026-10-16T12:30:00+00:00',
    added: 0,
    removed: 0,
    unavailable_sources: [],
    ...overrides,
  };
}
