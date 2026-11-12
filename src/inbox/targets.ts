import type { SessionRow } from '../api/types';
import type { Scope } from './scope';
import type { TriageTarget } from './useTriageHandoff';

const NO_ROWS: readonly SessionRow[] = Object.freeze([]);

export function actionTargets(
  marked: readonly SessionRow[],
  selected: SessionRow | null,
): readonly SessionRow[] {
  if (marked.length > 0) return marked;
  return selected === null ? NO_ROWS : [selected];
}

type TriageChoice =
  | { readonly kind: 'target'; readonly target: TriageTarget }
  | { readonly kind: 'several' }
  | { readonly kind: 'none' };

function onlyProject(rows: readonly SessionRow[]): TriageTarget | 'several' | null {
  const projects = new Map(rows.map((row) => [row.project_key, row.project_label]));
  if (projects.size > 1) return 'several';
  const [only] = projects;
  return only === undefined ? null : { key: only[0], label: only[1] };
}

export function scopeProject(
  scope: Scope | null,
  scoped: readonly SessionRow[],
): TriageTarget | null {
  if (scope === null) return null;
  if (scope.kind === 'repo') return { key: scope.key, label: scope.label };
  const project = onlyProject(scoped);
  return project === 'several' ? null : project;
}

export function triageChoice(
  project: TriageTarget | null,
  targets: readonly SessionRow[],
): TriageChoice {
  if (project !== null) return { kind: 'target', target: project };
  const only = onlyProject(targets);
  if (only === 'several') return { kind: 'several' };
  return only === null ? { kind: 'none' } : { kind: 'target', target: only };
}
