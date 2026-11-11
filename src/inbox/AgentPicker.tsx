import { useRef, type ReactElement } from 'react';
import type { AgentInfo } from '../api/types';
import { agentPickerContext } from '../shortcuts/contexts';
import { useShortcutContext } from '@shortcutkit/react';
import { Modal } from './Modal';

export interface AgentPickerProps {
  readonly projectLabel: string;
  readonly agents: readonly AgentInfo[];
  readonly preferred: string | null;
  readonly onPick: (agent: AgentInfo) => void;
  readonly onClose: () => void;
}

export function AgentPicker(props: AgentPickerProps): ReactElement {
  const { projectLabel, agents, preferred, onPick, onClose } = props;
  const focusRef = useRef<HTMLButtonElement>(null);
  const focusSource = agents.some((agent) => agent.source === preferred)
    ? preferred
    : (agents[0]?.source ?? null);
  useShortcutContext(agentPickerContext, () => onClose());
  return (
    <Modal
      labelledBy="agent-picker-title"
      panelClassName="w-80"
      initialFocus={focusRef}
      onDismiss={onClose}
    >
      <h2 id="agent-picker-title" className="mb-3 text-sm font-semibold">
        Triage {projectLabel} with…
      </h2>
      <ul className="flex flex-col gap-1">
        {agents.map((agent) => (
          <li key={agent.source}>
            <button
              type="button"
              ref={agent.source === focusSource ? focusRef : undefined}
              onClick={() => onPick(agent)}
              className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-neutral-500/10 focus:bg-blue-500/15 focus:outline-none"
            >
              {agent.agent}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
