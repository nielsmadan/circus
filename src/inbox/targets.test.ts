import { describe, expect, it } from 'vitest';
import { makeRow } from '../test/fixtures';
import type { Scope } from './scope';
import { actionTargets, scopeProject, triageChoice } from './targets';
import { markedIn, toggled, toggledAll } from './useMarks';

const a = makeRow({ id: 'claude-code:a', project_key: '/u/a', project_label: 'alpha' });
const b = makeRow({ id: 'claude-code:b', project_key: '/u/a', project_label: 'alpha' });
const c = makeRow({ id: 'claude-code:c', project_key: '/u/c', project_label: 'gamma' });

describe('actionTargets', () => {
  it('acts on the marked rows when there are any', () => {
    expect(actionTargets([b], a)).toEqual([b]);
  });

  it('acts on the selection otherwise', () => {
    expect(actionTargets([], a)).toEqual([a]);
    expect(actionTargets([], null)).toEqual([]);
  });
});

describe('triageChoice', () => {
  it('triages the filtered project whatever is marked', () => {
    expect(triageChoice({ key: '/u/c', label: 'gamma' }, [a])).toEqual({
      kind: 'target',
      target: { key: '/u/c', label: 'gamma' },
    });
  });

  it("triages the targets' one project", () => {
    expect(triageChoice(null, [a, b])).toEqual({
      kind: 'target',
      target: { key: '/u/a', label: 'alpha' },
    });
  });

  it('refuses targets in several projects', () => {
    expect(triageChoice(null, [a, c])).toEqual({ kind: 'several' });
  });

  it('has nothing to triage without targets or a filter', () => {
    expect(triageChoice(null, [])).toEqual({ kind: 'none' });
  });
});

describe('scopeProject', () => {
  const folder: Scope = { kind: 'folder', key: '/u/a', label: '~/a' };
  const tree: Scope = { kind: 'tree', key: '/u', label: '~', excluding: null };
  const day: Scope = {
    kind: 'period',
    key: 'day:2026-11-11',
    label: '2026-11-11',
    period: 'day',
    start: 0,
    end: 1,
  };

  it('uses a repo scope as is', () => {
    expect(scopeProject({ kind: 'repo', key: 'k', label: 'K' }, [])).toEqual({
      key: 'k',
      label: 'K',
    });
  });

  it('finds the one project every scoped session shares, from a folder, tree or period', () => {
    for (const scope of [folder, tree, day]) {
      expect(scopeProject(scope, [a, b])).toEqual({ key: '/u/a', label: 'alpha' });
    }
  });

  it('has no project when the scope spans several, holds none or is unset', () => {
    expect(scopeProject(tree, [a, c])).toBeNull();
    expect(scopeProject(folder, [])).toBeNull();
    expect(scopeProject(null, [a])).toBeNull();
  });
});

describe('marks', () => {
  it('toggles one id', () => {
    expect([...toggled(new Set([a.id]), b.id)]).toEqual([a.id, b.id]);
    expect([...toggled(new Set([a.id, b.id]), a.id)]).toEqual([b.id]);
  });

  it('marks every row, or clears when every row is already marked', () => {
    expect([...toggledAll(new Set([a.id]), [a, b])]).toEqual([a.id, b.id]);
    expect([...toggledAll(new Set([a.id, b.id]), [a, b])]).toEqual([]);
  });

  it('lists the marked rows that are shown, in list order', () => {
    const positions = new Map([
      [a.id, 0],
      [c.id, 1],
    ]);
    expect(markedIn(new Set([c.id, b.id, a.id]), [a, c], positions)).toEqual([a, c]);
  });
});
