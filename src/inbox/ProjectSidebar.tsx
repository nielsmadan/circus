import { memo, type ReactElement } from 'react';
import type { ProjectCount } from './derive';

export interface ProjectSidebarProps {
  readonly projects: readonly ProjectCount[];
  readonly total: number;
  readonly projectKey: string | null;
  readonly onProject: (key: string | null) => void;
}

interface EntryProps {
  readonly label: string;
  readonly count: number;
  readonly current: boolean;
  readonly onClick: () => void;
}

function Entry({ label, count, current, onClick }: EntryProps): ReactElement {
  return (
    <li>
      <button
        type="button"
        tabIndex={-1}
        aria-current={current}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm aria-[current=true]:bg-blue-500/15 aria-[current=true]:font-medium"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-xs tabular-nums opacity-60">{count}</span>
      </button>
    </li>
  );
}

export const ProjectSidebar = memo(function ProjectSidebar({
  projects,
  total,
  projectKey,
  onProject,
}: ProjectSidebarProps): ReactElement {
  return (
    <nav aria-label="Projects" className="h-full min-h-0 overflow-y-auto p-2">
      <ul className="flex flex-col gap-px">
        <Entry
          label="All projects"
          count={total}
          current={projectKey === null}
          onClick={() => onProject(null)}
        />
        {projects.map((project) => (
          <Entry
            key={project.key}
            label={project.label}
            count={project.pending}
            current={project.key === projectKey}
            onClick={() => onProject(project.key === projectKey ? null : project.key)}
          />
        ))}
      </ul>
    </nav>
  );
});
