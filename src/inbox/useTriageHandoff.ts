import { readStored, writeStored } from '../storage';
import { useCallback, useState } from 'react';
import type { CircusApi } from '../api/client';
import { toCircusError, type AgentInfo } from '../api/types';
import {
  errorDetail,
  handoffRefusalText,
  launchedToast,
  noAgentToast,
  toast,
  triageFailedToast,
  type ToastSpec,
} from './messages';

const AGENT_KEY = 'circus.triage-agent';

export interface TriageTarget {
  readonly key: string;
  readonly label: string;
}

export interface AgentChoice {
  readonly target: TriageTarget;
  readonly preferred: string | null;
}

export interface TriageHandoff {
  readonly choice: AgentChoice | null;
  triage(target: TriageTarget): void;
  pick(agent: AgentInfo): void;
  closePicker(): void;
}

export function useTriageHandoff(
  api: CircusApi,
  notify: (spec: ToastSpec) => void,
  agents: readonly AgentInfo[],
): TriageHandoff {
  const [choice, setChoice] = useState<AgentChoice | null>(null);

  const start = useCallback(
    (target: TriageTarget, agent: AgentInfo) => {
      writeStored(AGENT_KEY, agent.source);
      const request = { project_key: target.key, agent: agent.source };
      const fail = (error: unknown) =>
        notify(triageFailedToast(target.label, errorDetail(toCircusError(error))));
      api.previewHandoff(request).then((doc) => {
        if (doc.status === 'refused') {
          notify(
            toast('warning', handoffRefusalText(doc.code, target.label, agent.agent), doc.reason),
          );
          return;
        }
        api
          .launchHandoff(request)
          .then(
            (launch) => notify(launchedToast(launch, `${agent.agent} to triage ${target.label}`)),
            fail,
          );
      }, fail);
    },
    [api, notify],
  );

  const triage = useCallback(
    (target: TriageTarget) => {
      const [only, ...others] = agents;
      if (only === undefined) notify(noAgentToast());
      else if (others.length === 0) start(target, only);
      else setChoice({ target, preferred: readStored(AGENT_KEY) });
    },
    [agents, notify, start],
  );

  const pick = useCallback(
    (agent: AgentInfo) => {
      if (choice === null) return;
      setChoice(null);
      start(choice.target, agent);
    },
    [choice, start],
  );

  const closePicker = useCallback(() => setChoice(null), []);

  return { choice, triage, pick, closePicker };
}
