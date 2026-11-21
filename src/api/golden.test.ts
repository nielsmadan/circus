import { describe, expect, expectTypeOf, it } from 'vitest';
import handoffGolden from '../test/golden/contract-handoff.json';
import listGolden from '../test/golden/contract-list.json';
import outcomeOkGolden from '../test/golden/contract-outcome-ok.json';
import outcomeRefusedGolden from '../test/golden/contract-outcome-refused.json';
import tailsGolden from '../test/golden/contract-tails.json';
import {
  AGENT_INFO_KEYS,
  DECIDE_OUTCOME_KEYS,
  HANDOFF_RESPONSE_KEYS,
  HOME_COUNT_KEYS,
  HOME_KEYS,
  HOME_PROJECT_KEYS,
  NEXT_STEP_KEYS,
  LIST_RESPONSE_KEYS,
  SESSION_ROW_KEYS,
  TAIL_ITEM_KEYS,
  TAILS_RESPONSE_KEYS,
  type AgentInfo,
  type DecideOutcome,
  type HandoffResponse,
  type Home,
  type HomeCounts,
  type HomeProject,
  type NextStep,
  type ListResponse,
  type SessionRow,
  type TailItem,
  type TailsResponse,
} from './types';

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

// remove each key once the pinned release's goldens carry it
const UNRELEASED_LIST_KEYS: ReadonlySet<string> = new Set(['kept', 'snoozed']);

describe('golden documents', () => {
  it('pins the list document and every session row', () => {
    expect(listGolden.kind).toBe('list');
    expect(listGolden.version).toBe(1);
    expect(keysOf(listGolden)).toEqual(
      LIST_RESPONSE_KEYS.filter((key) => !UNRELEASED_LIST_KEYS.has(key)),
    );
    expect(keysOf(listGolden.presence)).toEqual(['code', 'problem', 'state']);
    expect(keysOf(listGolden.roundup)).toEqual(['age_human', 'last_at', 'stale', 'stale_hours']);
    expect(listGolden.scan).toBeNull();
    expect(listGolden.sessions.length).toBeGreaterThanOrEqual(1);
    listGolden.sessions.forEach((session) => {
      expect(keysOf(session)).toEqual([...SESSION_ROW_KEYS]);
    });
  });

  it('pins the home block, its rows and the agents', () => {
    const { home, agents } = listGolden;
    expect(keysOf(home)).toEqual([...HOME_KEYS]);
    expect(keysOf(home.counts)).toEqual([...HOME_COUNT_KEYS]);
    expect(home.projects.length).toBeGreaterThanOrEqual(1);
    home.projects.forEach((project) => expect(keysOf(project)).toEqual([...HOME_PROJECT_KEYS]));
    expect(home.next_steps.map((step) => step.kind)).toEqual(
      expect.arrayContaining(['roundup', 'woke', 'recent']),
    );
    home.next_steps.forEach((step) => expect(keysOf(step)).toEqual([...NEXT_STEP_KEYS]));
    home.rows.forEach((row) => expect(keysOf(row)).toEqual([...SESSION_ROW_KEYS]));
    expect(agents.length).toBeGreaterThanOrEqual(1);
    agents.forEach((agent) => expect(keysOf(agent)).toEqual([...AGENT_INFO_KEYS]));
  });

  it('pins the handoff document', () => {
    expect(handoffGolden.kind).toBe('handoff');
    expect(handoffGolden.version).toBe(1);
    expect(handoffGolden.status).toBe('ok');
    expect(keysOf(handoffGolden)).toEqual([...HANDOFF_RESPONSE_KEYS]);
  });

  it('pins both outcome documents', () => {
    expect(keysOf(outcomeOkGolden)).toEqual([...DECIDE_OUTCOME_KEYS]);
    expect(keysOf(outcomeRefusedGolden)).toEqual([...DECIDE_OUTCOME_KEYS]);
    expect(outcomeOkGolden.status).toBe('ok');
    expect(outcomeRefusedGolden.status).toBe('refused');
    expect(outcomeRefusedGolden.reason).toBe('changed since you looked');
  });

  it('pins the tails document and its items', () => {
    expect(tailsGolden.kind).toBe('tails');
    expect(keysOf(tailsGolden)).toEqual([...TAILS_RESPONSE_KEYS]);
    expect(tailsGolden.items).toHaveLength(3);
    tailsGolden.items.forEach((item) => {
      expect(keysOf(item)).toEqual([...TAIL_ITEM_KEYS]);
    });
    expect(tailsGolden.items[2]?.unavailable).toBe('no longer in the registry');
  });

  it('declares every key of each type in its key array', () => {
    expectTypeOf<(typeof SESSION_ROW_KEYS)[number]>().toEqualTypeOf<keyof SessionRow>();
    expectTypeOf<(typeof LIST_RESPONSE_KEYS)[number]>().toEqualTypeOf<keyof ListResponse>();
    expectTypeOf<(typeof DECIDE_OUTCOME_KEYS)[number]>().toEqualTypeOf<keyof DecideOutcome>();
    expectTypeOf<(typeof TAILS_RESPONSE_KEYS)[number]>().toEqualTypeOf<keyof TailsResponse>();
    expectTypeOf<(typeof TAIL_ITEM_KEYS)[number]>().toEqualTypeOf<keyof TailItem>();
    expectTypeOf<(typeof HOME_KEYS)[number]>().toEqualTypeOf<keyof Home>();
    expectTypeOf<(typeof HOME_COUNT_KEYS)[number]>().toEqualTypeOf<keyof HomeCounts>();
    expectTypeOf<(typeof HOME_PROJECT_KEYS)[number]>().toEqualTypeOf<keyof HomeProject>();
    expectTypeOf<(typeof NEXT_STEP_KEYS)[number]>().toEqualTypeOf<keyof NextStep>();
    expectTypeOf<(typeof AGENT_INFO_KEYS)[number]>().toEqualTypeOf<keyof AgentInfo>();
    expectTypeOf<(typeof HANDOFF_RESPONSE_KEYS)[number]>().toEqualTypeOf<keyof HandoffResponse>();
  });
});
