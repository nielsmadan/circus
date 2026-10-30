import { describe, expect, expectTypeOf, it } from 'vitest';
import listGolden from '../test/golden/contract-list.json';
import outcomeOkGolden from '../test/golden/contract-outcome-ok.json';
import outcomeRefusedGolden from '../test/golden/contract-outcome-refused.json';
import tailsGolden from '../test/golden/contract-tails.json';
import {
  DECIDE_OUTCOME_KEYS,
  LIST_RESPONSE_KEYS,
  SESSION_ROW_KEYS,
  TAIL_ITEM_KEYS,
  TAILS_RESPONSE_KEYS,
  type DecideOutcome,
  type ListResponse,
  type SessionRow,
  type TailItem,
  type TailsResponse,
} from './types';

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe('golden documents', () => {
  it('pins the list document and every session row', () => {
    expect(listGolden.kind).toBe('list');
    expect(listGolden.version).toBe(1);
    expect(keysOf(listGolden)).toEqual([...LIST_RESPONSE_KEYS]);
    expect(keysOf(listGolden.presence)).toEqual(['problem', 'state']);
    expect(keysOf(listGolden.roundup)).toEqual(['age_human', 'last_at', 'stale', 'stale_hours']);
    expect(listGolden.scan).toBeNull();
    expect(listGolden.sessions.length).toBeGreaterThanOrEqual(1);
    listGolden.sessions.forEach((session) => {
      expect(keysOf(session)).toEqual([...SESSION_ROW_KEYS]);
    });
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
  });
});
