import { memo, type ReactElement } from 'react';
import type { Home, ListResponse, NextStep, SessionRow } from '../api/types';
import { spanText } from './age';
import type { ProjectCount } from './derive';
import { KeepFocusButton } from './KeepFocusButton';
import { plural, unknownValue } from './messages';

interface StepView {
  readonly text: string;
  readonly buttonLabel: string | null;
}

export interface StepContext {
  readonly home: Home;
  readonly roundup: ListResponse['roundup'];
  readonly recentDays: number;
  readonly now: string;
  readonly rowFor: (id: string) => SessionRow | null;
  readonly projectFor: (key: string) => ProjectCount | null;
}

function stepView(step: NextStep, context: StepContext): StepView | null {
  switch (step.kind) {
    case 'roundup':
      return {
        text:
          context.roundup.age_human === null
            ? 'Sessions have never been cleaned up'
            : `Sessions were last cleaned up ${context.roundup.age_human}`,
        buttonLabel: null,
      };
    case 'woke':
      return { text: `${plural(step.count, 'snoozed session')} woke up`, buttonLabel: 'Review' };
    case 'recent':
      return {
        text: `${plural(step.count, 'session')} from the last ${context.recentDays} days`,
        buttonLabel: 'Triage',
      };
    case 'publish':
      return { text: `${plural(step.count, 'harvest')} to publish`, buttonLabel: 'Open Harvests' };
    case 'project': {
      const project = context.projectFor(step.project_key);
      if (project === null) return null;
      const oldest = spanText(project.oldestMtime, context.now);
      return {
        text: `${project.label}: ${project.pending} waiting, oldest ${oldest}`,
        buttonLabel: 'Triage',
      };
    }
    case 'resume': {
      const row = context.rowFor(step.id);
      return row === null
        ? { text: 'Nothing waiting', buttonLabel: null }
        : {
            text: `Pick up “${row.label}” (${row.agent}, ${row.age_human})`,
            buttonLabel: 'Resume',
          };
    }
    default:
      return unknownValue(step);
  }
}

function countsText(home: Home): string {
  const { counts } = home;
  const secondary: readonly [string, number][] = [
    ['live', counts.live],
    ['unclassified', counts.unclassified],
    ['blocked', counts.blocked],
    ['stale', counts.stale],
    ['kept', counts.kept],
  ];
  return [
    `${counts.triage_total} waiting`,
    ...secondary.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`),
  ].join(' · ');
}

export interface NextStepsProps {
  readonly context: StepContext;
  readonly onStep: (step: NextStep) => void;
}

export const NextSteps = memo(function NextSteps({
  context,
  onStep,
}: NextStepsProps): ReactElement {
  const shown = context.home.next_steps.flatMap((step) => {
    const view = stepView(step, context);
    return view === null ? [] : [{ step, view }];
  });
  return (
    <section
      aria-label="Next steps"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-800"
    >
      {shown.length === 0 ? (
        <span className="font-medium">All caught up</span>
      ) : (
        <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          {shown.map(({ step, view }, position) => (
            <li
              key={`${step.kind}:${step.project_key ?? step.id ?? ''}`}
              className={`flex items-center gap-1.5 ${position === 0 ? 'font-medium' : 'opacity-80'}`}
            >
              {position === 0 && <span className="opacity-60">Next:</span>}
              <span>{view.text}</span>
              {view.buttonLabel !== null && (
                <KeepFocusButton
                  onClick={() => onStep(step)}
                  className="rounded border border-neutral-300 px-1.5 text-xs font-normal hover:bg-neutral-500/10 dark:border-neutral-700"
                >
                  {view.buttonLabel}
                </KeepFocusButton>
              )}
            </li>
          ))}
        </ol>
      )}
      <span className="ml-auto text-xs tabular-nums opacity-60">{countsText(context.home)}</span>
    </section>
  );
});
