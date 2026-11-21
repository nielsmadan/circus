import type { Home, HomeProject, NextStep, SessionRow } from '../api/types';
import { indexRows, parseMtime, projectCounts } from '../inbox/derive';
import type { FakeWorld } from './synthetic';

const IN_FLIGHT_LIMIT = 8;
const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'unfinished', 'blocked']);

const FLAGS = { deletes: false, costs_model: false };

const countStep = (kind: 'woke' | 'recent' | 'publish', count: number): NextStep => ({
  ...FLAGS,
  kind,
  count,
  project_key: null,
  id: null,
});

const newestFirst = (rows: readonly SessionRow[]): SessionRow[] =>
  rows
    .map((row) => ({ row, ms: parseMtime(row.mtime) }))
    .sort((a, b) => b.ms - a.ms)
    .map(({ row }) => row);

function projectQueue(rows: readonly SessionRow[]): HomeProject[] {
  return projectCounts(rows, indexRows(rows)).map((project) => {
    const members = newestFirst(rows.filter((row) => row.project_key === project.key));
    return {
      key: project.key,
      label: project.label,
      pending: project.pending,
      unclassified: members.filter((row) => row.status === 'unclassified').length,
      oldest_mtime: project.oldestMtime,
      newest_mtime: members[0]?.mtime ?? project.oldestMtime,
    };
  });
}

export function fakeHome(
  { sessions: rows, kept }: Pick<FakeWorld, 'sessions' | 'kept'>,
  pendingHarvests: number,
  roundupStale: boolean,
): Home {
  const recent = rows.filter((row) => row.in_recent);
  const woke = rows.filter((row) => row.woke);
  const projects = projectQueue(rows);
  const inFlight = newestFirst(
    rows.filter(
      (row) =>
        (LIVE_STATUSES.has(row.status) || row.status === 'unclassified') &&
        row.in_recent &&
        !row.finish_on_exit,
    ),
  ).slice(0, IN_FLIGHT_LIMIT);
  const covered = new Set([...recent, ...woke].map((row) => row.id)).size;
  const first = projects[0];
  const steps: NextStep[] = [
    ...(roundupStale
      ? [
          {
            kind: 'roundup',
            deletes: true,
            costs_model: true,
            count: null,
            project_key: null,
            id: null,
          } as const,
        ]
      : []),
    ...(woke.length > 0 ? [countStep('woke', woke.length)] : []),
    ...(recent.length > 0 ? [countStep('recent', recent.length)] : []),
    ...(pendingHarvests > 0 ? [countStep('publish', pendingHarvests)] : []),
    ...(first !== undefined && rows.length > covered
      ? [
          {
            ...FLAGS,
            kind: 'project',
            count: first.pending,
            project_key: first.key,
            id: null,
          } as const,
        ]
      : []),
  ];
  const resume = inFlight[0];
  const nextSteps: NextStep[] =
    steps.length > 0 || resume === undefined
      ? steps
      : [{ ...FLAGS, kind: 'resume', count: null, project_key: null, id: resume.id }];
  return {
    counts: {
      triage_total: rows.length,
      live: rows.filter((row) => LIVE_STATUSES.has(row.status)).length,
      unclassified: rows.filter((row) => row.status === 'unclassified').length,
      blocked: rows.filter((row) => row.status === 'blocked').length,
      stale: 0,
      kept: kept.length,
      projects: projects.length,
      spread_projects: 0,
    },
    pending_harvests: pendingHarvests,
    projects,
    waking_soon: [],
    in_flight: inFlight.map((row) => row.id),
    rows: [],
    next_steps: nextSteps,
  };
}
