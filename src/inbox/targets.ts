import type { SessionRow } from '../api/types';
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

export function triageChoice(
  projectKey: string | null,
  projectLabel: string | null,
  targets: readonly SessionRow[],
): TriageChoice {
  if (projectKey !== null) {
    return {
      kind: 'target',
      target: { key: projectKey, label: projectLabel ?? targets[0]?.project_label ?? projectKey },
    };
  }
  const projects = new Map(targets.map((row) => [row.project_key, row.project_label]));
  if (projects.size > 1) return { kind: 'several' };
  const [only] = projects;
  return only === undefined
    ? { kind: 'none' }
    : { kind: 'target', target: { key: only[0], label: only[1] } };
}
